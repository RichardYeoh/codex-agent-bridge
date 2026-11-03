'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { config, taskDir, readJson, writeJsonAtomic, loadTask, sleep, processAlive } = require('./util');
const { agentInfo, api } = require('./herdr');
const { assertWorker } = require('./worker');
const { leaseForEvent } = require('./worker-lease');
const { queryAdmission, resolveTurn } = require('./zcode-observation');

const protocol = 1;
const envelopeDigest = envelope => envelope ? crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex') : null;
function files(task) {
  const root = taskDir(task.id);
  return { journal: path.join(root, `round-${String(task.round).padStart(3, '0')}-zcode-command.json`),
    request: path.join(root, 'zcode-ready-request.json'), receipt: path.join(root, 'zcode-ready-receipt.json') };
}
function binding(task, journal) {
  if (task.agent !== 'zcode' || !Number.isInteger(task.round) || task.round < 0
      || !task.workerSessionId || !task.terminalId || !task.paneId || task.round > 0 && !journal?.envelope?.commandId
      || journal && (journal.envelope?.sessionId !== task.workerSessionId || journal.envelope?.type !== 'sendText')) {
    throw new Error('ZCode readiness command or worker identity mismatch');
  }
  return { taskId: task.id, agent: task.agent, round: task.round, sessionId: task.workerSessionId, cwd: task.cwd,
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId,
    commandId: journal?.envelope?.commandId || null, commandSha256: envelopeDigest(journal?.envelope) };
}
function matches(left, right) { return !!right && Object.entries(left).every(([key, value]) => right[key] === value); }
function failedAdmission(journal) {
  return journal?.envelope?.type === 'sendText' && journal.ack?.commandId === journal.envelope.commandId
    && ['failed', 'rejected'].includes(journal.ack.status) && typeof journal.ack.reasonCode === 'string'
    && journal.ack.reasonCode.length > 0 && !journal.ack.result;
}
function assertQuiescent(task, snapshot) {
  const c = snapshot?.control;
  if (snapshot?.sessionId !== task.workerSessionId || !c || !Array.isArray(c.activeWorks)
      || !Array.isArray(snapshot.queue?.items) || !Array.isArray(snapshot.pendingInteractions)
      || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || typeof snapshot.logEpoch !== 'string' || !snapshot.logEpoch) {
    throw new Error('ZCode readiness snapshot identity or shape mismatch');
  }
  if (!['draft', 'completedSuccess', 'completedInterrupted', 'error'].includes(c.phase)
      || c.canStop !== false || c.stopState !== 'idle' || c.activeWorks.length || c.apiRetry
      || snapshot.queue.items.length || snapshot.pendingInteractions.length || snapshot.workspaceHookAdmission
      || snapshot.inputRouting?.mode !== 'startNow') {
    throw new Error('ZCode readiness refused: active work, queued input, interaction or non-idle routing');
  }
}

async function verifyNativeReady(task, journal, remote, conversation) {
  binding(task, journal);
  const first = conversation.snapshot; assertQuiescent(task, first);
  let previous = null;
  if (journal) {
    // Only an exact read-only inbox query can resolve admission uncertainty. / 仅原命令的精确只读inbox查询可解除准入不确定性。
    const ack = await queryAdmission(remote, journal.envelope, { attempts: 1 });
    if (['failed', 'rejected'].includes(ack.status) && ack.reasonCode && !ack.result) {
      previous = { state: 'failed', reason: ack.reasonCode, evidence: 'command-inbox', admissionStatus: ack.status };
    } else if (['accepted', 'duplicate'].includes(ack.status)) {
      const turn = await resolveTurn(remote, conversation.snapshot, journal.envelope.commandId);
      if (!turn.seen || !turn.terminal) throw new Error('ZCode readiness refused: original execution terminal is unconfirmed');
      previous = { state: turn.state, reason: turn.state === 'completedSuccess' ? null
        : turn.error?.code || (turn.state === 'completedInterrupted' ? 'execution_interrupted' : 'runtime_failed'),
        evidence: turn.evidence, headerRowId: turn.headerRowId ?? turn.header?.rowId };
    } else throw new Error('ZCode readiness refused: original command disposition is unconfirmed');
  } else if (task.round !== 0 || task.submission != null || task.history?.some(item => item.status === 'submitted')) {
    throw new Error('ZCode readiness refused: missing original command evidence');
  }
  const snapshot = conversation.snapshot; assertQuiescent(task, snapshot);
  if (snapshot.logEpoch !== first.logEpoch || snapshot.seq < first.seq) throw new Error('ZCode readiness snapshot watermark changed');
  return { previous, phase: snapshot.control.phase, seq: snapshot.seq, logEpoch: snapshot.logEpoch };
}

function validateProof(task, proof) {
  if (!proof || !['draft', 'completedSuccess', 'completedInterrupted', 'error'].includes(proof.phase)
      || !Number.isSafeInteger(proof.seq) || proof.seq < 0 || !proof.logEpoch) throw new Error('ZCode readiness proof is incomplete');
  if (task.round === 0 && proof.previous === null) return;
  const previous = proof.previous;
  if (!previous || !['failed', 'completedSuccess', 'completedInterrupted'].includes(previous.state)
      || (previous.evidence === 'command-inbox'
        ? previous.state !== 'failed' || !['failed', 'rejected'].includes(previous.admissionStatus) || !previous.reason
        : !['snapshot', 'conversationRowsRangeV4'].includes(previous.evidence) || !Number.isSafeInteger(previous.headerRowId))) {
    throw new Error('ZCode readiness original command proof is incomplete');
  }
}

function assertLocal(task, expected, { inspect = agentInfo } = {}) {
  if (path.resolve(task.stateDir) !== path.resolve(config().stateDir)) throw new Error('ZCode readiness state root mismatch');
  const current = loadTask(task.id), journal = readJson(files(current).journal, null);
  if (!matches(expected, binding(current, journal)) || current.status !== task.status) throw new Error('ZCode readiness task binding changed');
  assertWorker(task, inspect(task.herdrSession, task.paneId));
  const lease = leaseForEvent(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (!lease || lease.taskId !== task.id || lease.terminalId !== task.terminalId || lease.workerSessionId !== task.workerSessionId) {
    throw new Error('ZCode readiness Pane lease mismatch');
  }
  const other = require('./worker-scheduling').taskList(task.stateDir).find(item => item.id !== task.id
    && item.agent === 'zcode' && item.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(item.status));
  if (other) throw new Error('ZCode readiness native session has another unresolved owner');
}

function workerAttestation(task, expected, alive) {
  let state = readJson(path.join(taskDir(task.id), 'zcode-state.json'), null);
  if (state?.readinessProtocol === protocol && matches(expected, state) && state.workerPid && alive(state.workerPid)) return state;
  // A new task may inherit a live, accepted worker before it has its first receipt. / 新任务首条回执产生前，可继承存活且已验收的原执行者。
  if (task.round === 0 && task.reusedFromTaskId) {
    const prior = loadTask(task.reusedFromTaskId);
    if (prior.status === 'accepted' && prior.agent === 'zcode' && prior.workerSessionId === task.workerSessionId
        && prior.paneId === task.paneId && prior.terminalId === task.terminalId && prior.herdrSession === task.herdrSession
        && prior.cwd === task.cwd) {
      state = readJson(path.join(taskDir(prior.id), 'zcode-state.json'), null);
      if (state?.readinessProtocol === protocol && matches(binding(prior, readJson(files(prior).journal, null)), state)
          && state.workerPid && alive(state.workerPid)) return state;
    }
  }
  throw new Error('ZCode worker lacks bound readiness support; safely reload the idle local worker before rework');
}

async function refreshWorker(task, { forSubmission = false } = {}, { inspect = agentInfo, send = api,
  pause = sleep, clock = Date.now, alive = processAlive, timeoutMs = 40000 } = {}) {
  if (!forSubmission) return;
  if (task.status === 'submission_unknown' || ['preparing', 'sending', 'uncertain'].includes(task.submission?.status)) {
    throw new Error('ZCode submission is uncertain; observe the original command before rework');
  }
  if (task.watcherPid && alive(task.watcherPid)) throw new Error('ZCode execution watcher is still active');
  const target = files(task), expected = binding(task, readJson(target.journal, null));
  assertLocal(task, expected, { inspect });
  const state = workerAttestation(task, expected, alive);
  const request = { protocol, requestId: crypto.randomUUID(), ...expected, createdAt: clock(), expiresAt: clock() + timeoutMs };
  writeJsonAtomic(target.request, request);
  let transportError;
  try {
    send(task.herdrSession, ['pane', 'send-text', task.paneId, ':prepare-retry:' + request.requestId]);
    send(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
  } catch (error) { transportError = error; }
  // A lost terminal-input reply must never cause a second delivery. / 终端输入回执丢失不得触发第二次投递。
  while (clock() < request.expiresAt) {
    const receipt = readJson(target.receipt, null);
    if (receipt?.requestId === request.requestId) {
      if (!matches(expected, receipt) || receipt.protocol !== protocol || receipt.workerPid !== state.workerPid
          || receipt.expiresAt !== request.expiresAt) throw new Error('ZCode readiness receipt identity mismatch');
      assertLocal(task, expected, { inspect });
      if (receipt.ready !== true) throw new Error('ZCode readiness refused: ' + receipt.reason);
      validateProof(task, receipt.proof);
      return receipt;
    }
    await pause(200);
  }
  throw new Error('ZCode readiness not acknowledged; no business prompt sent' + (transportError ? ' (terminal transport uncertain)' : ''));
}

module.exports = { protocol, envelopeDigest, files, binding, matches, failedAdmission, assertQuiescent, verifyNativeReady, validateProof, assertLocal, refreshWorker };
