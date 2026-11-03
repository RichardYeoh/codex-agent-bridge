'use strict';

const path = require('node:path');
const { ZCodeRemote, Conversation, readBinding } = require('./zcode-remote');
const { loadTask, readJson, processAlive, taskDir } = require('./util');
const readiness = require('./zcode-readiness');
const { cancelNative } = require('./cancellation');
const { taskList } = require('./worker-scheduling');
const { leasePath } = require('./worker-lease');

function rejectedCommandEvidence(task) {
  const journal = readJson(readiness.files(task).journal, null);
  // A persisted pre-execution rejection already decides this command; Desktop availability is irrelevant. / 已持久化的执行前拒绝已决定该命令处置，不依赖Desktop在线。
  if (journal?.status !== 'acknowledged' || journal.ack?.status !== 'failed'
      || journal.ack.reasonCode !== 'modelUnavailable' || journal.ack.result != null
      || !Number.isSafeInteger(journal.ack.revisionAtDecision) || journal.ack.revisionAtDecision < 0
      || !Number.isFinite(Date.parse(journal.timestamp))) return null;
  const expected = readiness.binding(task, journal);
  if (journal.ack.commandId !== expected.commandId) throw new Error('Persisted rejection command identity mismatch');
  if (task.status !== 'cancel_pending' || task.submission?.status !== 'observed') {
    throw new Error('Persisted rejection cannot resolve an uncertain submission');
  }
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('Cancellation observer is still active');
  const root = taskDir(task.id);
  for (const file of ['zcode-state.json', `round-${String(task.round).padStart(3, '0')}-zcode-observation.json`]) {
    const state = readJson(path.join(root, file), null);
    if (!state) continue;
    const keys = ['taskId', 'round', 'sessionId', 'commandId', 'paneId', 'terminalId'];
    if (keys.some(key => state[key] !== expected[key])) throw new Error('Persisted rejection observation binding mismatch');
    if (state.workerPid && processAlive(state.workerPid)) throw new Error('Cancellation worker is still active');
    if (state.state === 'working' || state.result?.seen || state.result?.terminal
        || ['running', 'queued', 'awaitingInteraction'].includes(state.phase)) {
      throw new Error('Persisted rejection conflicts with local execution evidence');
    }
  }
  const lease = readJson(leasePath(task.stateDir, task.herdrSession, task.paneId), null);
  if (lease && (lease.taskId !== task.id || lease.workerSessionId !== task.workerSessionId
      || lease.terminalId !== task.terminalId)) throw new Error('Persisted rejection Pane lease has another owner');
  if (taskList(task.stateDir).some(other => other.id !== task.id && other.agent === 'zcode'
      && other.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(other.status))) {
    throw new Error('Persisted rejection native session has another unresolved task');
  }
  const current = loadTask(task.id);
  if (current.status !== task.status || !readiness.matches(expected,
    readiness.binding(current, readJson(readiness.files(current).journal, null)))) {
    throw new Error('Persisted rejection task or command binding changed');
  }
  return { confirmed: true, source: 'persisted-command-ack', reason: 'original_command_not_admitted',
    nativeBinding: expected, proof: { admissionStatus: journal.ack.status, reasonCode: journal.ack.reasonCode,
      revisionAtDecision: journal.ack.revisionAtDecision, acknowledgedAt: journal.timestamp },
    scope: 'original-command-only; session-wide quiescence not asserted' };
}

async function cancellationState(task, { createRemote = current => new ZCodeRemote(readBinding(current.zcodeConfig)),
  createConversation = (remote, sessionId) => new Conversation(remote, sessionId) } = {}) {
  const rejected = rejectedCommandEvidence(task);
  if (rejected) return rejected;
  const journal = readJson(readiness.files(task).journal, null), expected = readiness.binding(task, journal);
  const remote = createRemote(task); remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    conversation = createConversation(remote, task.workerSessionId); await conversation.subscribe();
    // Read-only proof closes a cancellation request; it cannot retry or stop any command. / 只读证据仅收口已请求取消，不得重试或停止任何命令。
    const proof = await readiness.verifyNativeReady(task, journal, remote, conversation);
    const current = loadTask(task.id);
    if (!readiness.matches(expected, readiness.binding(current, readJson(readiness.files(current).journal, null)))) {
      throw new Error('ZCode cancellation command binding changed');
    }
    return { confirmed: true, reason: 'native_quiescent', source: 'zcode-v4-read-only', nativeBinding: expected, proof };
  } finally {
    try { await conversation?.dispose(); } finally { remote.close(); }
  }
}

async function reconcileCancellation(task, dependencies = {}) {
  if (task.status !== 'cancel_pending') throw new Error('ZCode cancellation reconciliation requires cancel_pending');
  return cancelNative(task, { reconcileOnly: true, worker: { id: 'zcode',
    verifyCancellationReceipt: (current, receipt) => {
      if (receipt.source !== 'persisted-command-ack') return;
      const checked = rejectedCommandEvidence(current);
      if (!checked || JSON.stringify(checked) !== JSON.stringify(receipt)) {
        throw new Error('Persisted rejection changed before cancellation confirmation');
      }
    },
    cancellationState: current => cancellationState(current, dependencies) } });
}

module.exports = { cancellationState, reconcileCancellation, rejectedCommandEvidence };
