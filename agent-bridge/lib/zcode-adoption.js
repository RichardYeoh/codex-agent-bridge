'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic, saveTask, taskDir, now, processAlive, event } = require('./util');
const { ZCodeRemote, Conversation, readBinding } = require('./zcode-remote');
const { resolveTurn, queryAdmission } = require('./zcode-observation');
const { normalizeTaskSpec } = require('./worker-policy');
const { agentInfo, api, startWatcher } = require('./herdr');
const { assertWorker } = require('./worker');
const { leaseForEvent } = require('./worker-lease');
const { sendControlLine } = require('./zcode-readiness');

function localFile(root, file) {
  const result = path.resolve(file), relative = path.relative(root, result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Adoption files must remain inside this task directory');
  return result;
}

async function verifyNative(task, envelope) {
  const remote = new ZCodeRemote(readBinding(task.zcodeConfig)); remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    const ack = await queryAdmission(remote, envelope);
    if (!['accepted', 'duplicate'].includes(ack.status)) throw new Error('External command was not admitted');
    conversation = new Conversation(remote, task.workerSessionId);
    await conversation.subscribe();
    if (conversation.snapshot.sessionId !== task.workerSessionId) throw new Error('External command native session mismatch');
    const control = conversation.snapshot.control, queue = conversation.snapshot.queue?.items, interactions = conversation.snapshot.pendingInteractions;
    if (!control || !Array.isArray(control.activeWorks) || !Array.isArray(queue) || !Array.isArray(interactions)
        || control.activeWorks.some(work => work.sourceCommandId !== envelope.commandId)
        || queue.length || interactions.length || conversation.snapshot.workspaceHookAdmission) {
      throw new Error('Foreign work, queued input or interaction prevents command adoption');
    }
    const prior = readJson(path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-command.json`));
    const previous = await resolveTurn(remote, conversation.snapshot, prior.envelope.commandId);
    if (!previous.terminal) throw new Error('Previous command is not authoritatively terminal; adoption refused');
    const current = await resolveTurn(remote, conversation.snapshot, envelope.commandId);
    if (!current.seen) throw new Error('External command not found in native session; no task state changed');
    return { ack, previous, current, checkedAt: now() };
  } finally {
    try { await conversation?.dispose(); } finally { await remote.close(); }
  }
}

function assertWorkerAvailable(task, { alive = processAlive } = {}) {
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json'), state = readJson(stateFile, null);
  if (!state || state.taskId !== task.id || state.sessionId !== task.workerSessionId
      || state.paneId !== task.paneId || state.terminalId !== task.terminalId
      || state.round !== task.round || !Number.isSafeInteger(state.workerPid) || !alive(state.workerPid)) {
    throw new Error('ZCode worker identity or liveness is unconfirmed; adoption refused');
  }
  if (state.state === 'working' || state.reason === 'untracked_command_active') {
    throw new Error('ZCode worker is still processing another command; adoption refused');
  }
  return state;
}

function adoptedWorkerReceipt(task, commandId, { alive = processAlive } = {}) {
  const state = readJson(path.join(taskDir(task.id), 'zcode-state.json'), null);
  return Boolean(state && state.taskId === task.id && state.round === task.round
    && state.sessionId === task.workerSessionId && state.paneId === task.paneId && state.terminalId === task.terminalId
    && state.commandId === commandId && state.state === 'working'
    && Number.isSafeInteger(state.workerPid) && alive(state.workerPid));
}

function historicalCommand(taskId, commandId, exceptFile) {
  const root = taskDir(taskId);
  return fs.readdirSync(root).filter(name => /^round-\d+-zcode-command\.json$/.test(name))
    .some(name => path.join(root, name) !== exceptFile && readJson(path.join(root, name), null)?.envelope?.commandId === commandId);
}

// Adopt an already sent command; this path contains no native create/send/stop operation. / 接管已经提交的命令；此路径不包含原生创建、派工或停止操作。
async function adopt(task, { commandFile, specFile, deliveryFile, round }, {
  inspect = agentInfo, call = api, verify = verifyNative, watch = startWatcher,
  lease = leaseForEvent, alive = processAlive,
} = {}) {
  if (task.agent !== 'zcode') throw new Error('Native command adoption currently supports only ZCode');
  const root = taskDir(task.id), source = localFile(root, commandFile), delivery = localFile(path.join(root, 'deliveries'), deliveryFile);
  const sourceBytes = fs.readFileSync(source), imported = JSON.parse(sourceBytes);
  const envelope = imported.envelope;
  if (envelope?.type !== 'sendText' || envelope.sessionId !== task.workerSessionId
      || !envelope.commandId || typeof envelope.payload?.text !== 'string' || !envelope.payload.text.trim()
      || imported.ack?.commandId !== envelope.commandId || !['accepted', 'duplicate'].includes(imported.ack?.status)) {
    throw new Error('External command identity or admission receipt mismatch');
  }
  if (task.round === round && task.externalCommandAdoption?.commandId === envelope.commandId) {
    if (task.externalCommandAdoption.sourceSha256 !== crypto.createHash('sha256').update(sourceBytes).digest('hex')
        || path.resolve(task.deliveryPath) !== delivery) throw new Error('Adoption replay changed its immutable source or delivery');
    if (task.status !== 'running') throw new Error('Adoption replay requires the original running round');
    if (!adoptedWorkerReceipt(task, envelope.commandId, { alive })) {
      const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
      if (agent.terminal_id !== task.terminalId || agent.agent_status === 'working') {
        throw new Error('ZCode Pane is busy or has changed identity; adoption observer was not reattached');
      }
      const state = readJson(path.join(root, 'zcode-state.json'), null);
      if (!state || state.taskId !== task.id || state.sessionId !== task.workerSessionId
          || state.paneId !== task.paneId || state.terminalId !== task.terminalId
          || !Number.isSafeInteger(state.workerPid) || !alive(state.workerPid)
          || state.state === 'working' || state.reason === 'untracked_command_active') {
        throw new Error('ZCode worker cannot safely accept an observer reattachment');
      }
      if (!alive(task.watcherPid)) { task.watcherPid = watch(task.id); saveTask(task); }
      sendControlLine(task, ':resume', call);
    } else if (!alive(task.watcherPid)) { task.watcherPid = watch(task.id); saveTask(task); }
    return task;
  }
  if (round !== task.round + 1 || !['review_pending', 'blocked', 'failed', 'delivery_missing'].includes(task.status)
      || alive(task.watcherPid)) throw new Error('Adoption requires the next round and a settled coordinator observer');
  const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
  const ownership = lease(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (ownership?.taskId !== task.id || ownership.terminalId !== task.terminalId) throw new Error('Pane lease mismatch');
  if (!['idle', 'done', 'blocked'].includes(agent.agent_status)) throw new Error('Bridge observer is still active; release its Relay seat first');
  if (agent.terminal_id !== task.terminalId) throw new Error('ZCode Pane terminal changed; adoption refused');
  assertWorkerAvailable(task, { alive });
  const spec = normalizeTaskSpec(readJson(path.resolve(specFile)));
  const evidence = await verify(task, envelope);
  const prefix = `round-${String(round).padStart(3, '0')}`;
  const journal = path.join(root, `${prefix}-zcode-command.json`);
  if (historicalCommand(task.id, envelope.commandId, journal)) throw new Error('External command already belongs to a historical round');
  const existing = readJson(journal, null);
  if (existing && JSON.stringify(existing.envelope) !== JSON.stringify(envelope)) throw new Error('Round already belongs to another command or payload');
  const receipt = { commandId: envelope.commandId, source, sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    round, sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId, evidence, timestamp: now() };
  writeJsonAtomic(path.join(root, `${prefix}-zcode-adoption.json`), receipt);
  writeJsonAtomic(journal, { ...imported, status: 'acknowledged', adopted: true });
  task.round = round; task.taskSpec = spec; task.deliveryPath = delivery;
  task.promptPath = path.join(root, `${prefix}-prompt.md`);
  fs.writeFileSync(task.promptPath, envelope.payload.text);
  task.promptBody = envelope.payload.text; task.externalCommandAdoption = receipt;
  task.status = 'running'; task.error = null; delete task.blocker;
  task.observationRequestedAt = now();
  task.submission = { status: 'observed', adopted: true, commandId: envelope.commandId };
  task.notification = { status: 'pending', round };
  task.history.push({ round, status: 'external_command_adopted', commandId: envelope.commandId, timestamp: now() });
  saveTask(task);
  task.watcherPid = watch(task.id); saveTask(task);
  // Resume is an idempotent observer control, never a second business command. / resume是幂等观察控制，不会二次投递业务命令。
  sendControlLine(task, ':resume', call);
  event(task, 'external_command_adopted', { commandId: envelope.commandId });
  return task;
}

module.exports = { adopt, verifyNative };
