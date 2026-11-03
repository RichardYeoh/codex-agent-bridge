'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config, readJson, writeJsonAtomic, ensureDir, now, sleep, withLock } = require('./util');
const { agentInfo, api, resultPayload } = require('./herdr');
const { assertWorker } = require('./worker');
const { leaseForEvent } = require('./worker-lease');

const ID = /^[a-z][a-z0-9-]{2,63}$/;
const BINDING = ['taskId', 'round', 'agent', 'herdrSession', 'workerSessionId', 'paneId', 'terminalId'];
const FINAL = new Set(['accepted']);

function binding(task) {
  return { taskId: task.id, round: task.round, agent: task.agent, herdrSession: task.herdrSession,
    workerSessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId };
}
function messageDir(task) { return path.join(task.stateDir, 'tasks', task.id, 'messages'); }
function messageFile(task, id) {
  if (!ID.test(id)) throw new Error('Message ID must be 3-64 lowercase letters, digits or hyphens');
  return path.join(messageDir(task), id + '.json');
}
function readMessage(task, id) { return readJson(messageFile(task, id)); }
function matches(message, task) { const current = binding(task); return BINDING.every(key => message[key] === current[key]); }
function saveMessage(task, message, status, evidence) {
  message.status = status; message.updatedAt = now();
  if (evidence) message.evidence = evidence;
  message.history.push({ status, timestamp: message.updatedAt, ...(evidence ? { evidence } : {}) });
  writeJsonAtomic(messageFile(task, message.messageId), message);
  return message;
}
function messageLock(task, id, fn) {
  const digest = crypto.createHash('sha256').update(task.stateDir + '\n' + task.id + '\n' + id).digest('hex').slice(0, 32);
  return withLock('message-' + digest, fn);
}
function publicReceipt(message) {
  const { text, rendered, marker, ...result } = message;
  return result;
}

function verify(task, { inspect = agentInfo } = {}) {
  if (!task.workerSessionId || !task.paneId || !task.terminalId || !(task.round > 0)) throw new Error('Message requires a verified native session, Pane, terminal and round');
  const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
  const lease = leaseForEvent(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (!lease || lease.taskId !== task.id || lease.terminalId !== task.terminalId || lease.workerSessionId !== task.workerSessionId) {
    throw new Error('Message Pane lease mismatch; no delivery attempted');
  }
  return agent;
}

function agyObservation(task) {
  const state = readJson(path.join(task.stateDir, 'tasks', task.id, 'agy-state.json'), null);
  if (!state || state.sessionId !== task.workerSessionId || state.taskId !== task.id
      || state.round !== task.round || state.paneId !== task.paneId || state.terminalId !== task.terminalId) return null;
  return state;
}

function transcriptAcceptance(task, message) {
  const state = agyObservation(task);
  if (!state?.transcriptPath) return null;
  const file = path.resolve(state.transcriptPath);
  // Only read this worker's native transcript, never arbitrary supplied paths. / 只读取此执行会话的原生记录，不读取任意指定路径。
  if (!file.toLowerCase().split(path.sep).includes(task.workerSessionId.toLowerCase())
      || !/^transcript(?:_full)?\.jsonl$/.test(path.basename(file))) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
    const data = Buffer.alloc(size - start); fs.readSync(fd, data, 0, data.length, start);
    const lines = data.toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    for (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'USER_INPUT' && typeof entry.content === 'string'
          && entry.content.includes(message.marker) && entry.content.replace(/\r\n/g, '\n').includes(message.text)) {
        return { type: 'native_transcript', stepIndex: entry.step_index, nativeSource: entry.source || null,
          currentRound: message.round, observedAt: now() };
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function terminalText(task, call = api) {
  const response = call(task.herdrSession, ['pane', 'read', task.paneId, '--source', 'recent-unwrapped', '--lines', '100']);
  const value = resultPayload(response);
  return typeof response === 'string' ? response : value?.read?.text || value?.text || '';
}
function hasDialog(text) {
  return /permission required|needs? (?:your )?approval|allow once|always allow|trust this folder|do you trust|select (?:a |an )?(?:model|option)|choose (?:an? )?option|settings|configuration|\besc\s+(?:to )?cancel/i.test(text);
}

async function reconcile(task, id, deps = {}) {
  return messageLock(task, id, () => {
    const message = readMessage(task, id);
    if (FINAL.has(message.status)) return message;
    if (!matches(message, task)) throw new Error('Stale message binding; inspect the original task/round before reconciliation');
    verify(task, deps);
    const accepted = transcriptAcceptance(task, message);
    if (accepted) return saveMessage(task, message, 'accepted', accepted);
    if (message.transport === 'tui' && message.attemptedAt) {
      const text = terminalText(task, deps.call);
      if (text.includes(message.marker) && /queued|queue\b|排队/i.test(text)) {
        if (message.status !== 'queued') return saveMessage(task, message, 'queued', { type: 'native_queue_visible', observedAt: now() });
      }
    }
    return message;
  });
}

async function deliver(task, { id, mode, text, waitMs = 15000 }, deps = {}) {
  if (task.agent !== 'agy') throw new Error('Verified live message delivery currently supports agy only; no generic shortcut fallback');
  if (!['queue', 'immediate'].includes(mode)) throw new Error('Explicit --mode queue or immediate is required');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32768) throw new Error('Message must contain 1-32768 UTF-8 bytes');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('--wait-ms must be 0-60000');
  if (['accepted', 'cancelled', 'cancel_pending'].includes(task.status)) throw new Error('Cannot deliver to a settled or cancelling task');
  text = text.trim().replace(/\r\n/g, '\n');
  const bodySha256 = crypto.createHash('sha256').update(text).digest('hex');
  let existed = false;
  let message = await messageLock(task, id, () => {
    const prior = readJson(messageFile(task, id), null);
    if (prior) {
      if (!matches(prior, task) || prior.bodySha256 !== bodySha256 || prior.mode !== mode) throw new Error('Message ID already bound to different content, mode or execution identity');
      existed = true; return prior;
    }
    verify(task, deps);
    const markerHash = crypto.createHash('sha256').update(JSON.stringify(binding(task)) + '\n' + id + '\n' + mode + '\n' + text).digest('hex').slice(0, 20);
    const marker = `[bridge-msg:${id}:${markerHash}]`;
    const value = { schemaVersion: 1, ...binding(task), messageId: id, mode, bodySha256, text, marker,
      rendered: `${marker}\n${text}`, transport: mode === 'immediate' ? 'native-hook' : 'tui',
      createdAt: now(), status: 'prepared', history: [] };
    ensureDir(messageDir(task)); return saveMessage(task, value, 'prepared');
  });
  // Duplicate and uncertain requests only reconcile; they never write terminal input twice. / 重复及不确定请求只对账，绝不再次写入终端。
  if (existed) return reconcile(task, id, deps);
  const agent = verify(task, deps), observed = agyObservation(task);
  if (agent.agent_status === 'blocked' || !['working', 'idle', 'done'].includes(agent.agent_status)
      || observed?.state === 'blocked') {
    return messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'blocked', { type: 'preflight_blocked', inputWritten: false }));
  }
  if (!observed?.messageHookVersion) {
    return messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'blocked', { type: 'native_observation_missing', inputWritten: false }));
  }
  if (mode === 'immediate' && agent.agent_status === 'working') {
    await messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'awaiting_hook', { type: 'native_safe_boundary_pending' }));
  } else {
    if (task.agyDeliveryProfile?.queuedMessages !== 'queue' || task.agyDeliveryProfile.version !== '1.4.10') {
      return messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'blocked', { type: 'unverified_tui_profile', inputWritten: false }));
    }
    const call = deps.call || api;
    try {
      if (hasDialog(terminalText(task, call))) return messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'blocked', { type: 'dialog_visible', inputWritten: false }));
      await messageLock(task, id, () => {
        const current = readMessage(task, id); current.transport = 'tui'; current.attemptedAt = now();
        return saveMessage(task, current, 'writing');
      });
      call(task.herdrSession, ['pane', 'send-text', task.paneId, message.rendered]);
      await messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'text_written', { type: 'terminal_write_ack' }));
      const live = verify(task, deps);
      if (live.agent_status === 'blocked' || hasDialog(terminalText(task, call))) throw new Error('Dialog appeared after text write; submit key not sent');
      call(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
      await messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'submitted', { type: 'terminal_submit_ack', nativeAcceptanceConfirmed: false }));
    } catch (error) {
      await messageLock(task, id, () => saveMessage(task, readMessage(task, id), 'uncertain', { type: 'transport_or_state_uncertain', message: 'Inspect native state; no automatic resend' }));
    }
  }
  const deadline = Date.now() + waitMs;
  do {
    message = await reconcile(task, id, deps);
    if (['accepted', 'queued', 'blocked', 'uncertain'].includes(message.status)) return message;
    if (Date.now() >= deadline) break;
    await sleep(200);
  } while (true);
  return message;
}

async function injectAgy(task, input, response) {
  if (input.conversationId !== task.workerSessionId || !fs.existsSync(messageDir(task))) return;
  for (const name of fs.readdirSync(messageDir(task)).filter(file => file.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    await messageLock(task, id, () => {
      const message = readMessage(task, id);
      if (!matches(message, task) || message.transport !== 'native-hook' || message.status !== 'awaiting_hook') return;
      // A hook return is not proof the engine has appended the message yet. / Hook返回值准备完成不等于引擎已追加消息。
      saveMessage(task, message, 'injection_prepared', { type: 'native_pre_invocation', invocationNum: input.invocationNum, initialNumSteps: input.initialNumSteps });
      response.injectSteps ||= [];
      response.injectSteps.push({ userMessage: message.rendered });
    });
  }
}

function assertMessagesSettled(task) {
  if (!fs.existsSync(messageDir(task))) return;
  const pending = fs.readdirSync(messageDir(task)).filter(name => name.endsWith('.json')).map(name => readJson(path.join(messageDir(task), name)))
    .filter(message => message.round === task.round && !['accepted', 'blocked'].includes(message.status));
  if (pending.length) throw new Error('Unconfirmed live messages remain; reconcile before accepting or starting another round');
}

module.exports = { deliver, reconcile, readMessage, publicReceipt, injectAgy, assertMessagesSettled,
  binding, matches, messageFile, messageDir, transcriptAcceptance, hasDialog };
