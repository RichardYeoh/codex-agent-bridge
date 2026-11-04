'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ZCodeRemote, Conversation, readBinding } = require('./zcode-remote');
const { loadTask, readJson, processAlive, taskDir } = require('./util');
const readiness = require('./zcode-readiness');
const { cancelNative } = require('./cancellation');
const { taskList } = require('./worker-scheduling');
const { leasePath } = require('./worker-lease');
const { api, resultPayload } = require('./herdr');

function watcherAlive(task, alive = processAlive) {
  return [task.watcherPid, task.cancellation?.previousWatcherPid]
    .some(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid));
}

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function terminalCommandEvidence(task, { inspectPane = api, alive = processAlive } = {}) {
  const journalFile = readiness.files(task).journal, journal = readJson(journalFile, null);
  const terminalStates = ['failed', 'completedInterrupted', 'completedSuccess'];
  if (journal?.status !== 'terminal' || !terminalStates.includes(journal.turnState)) return null;
  const expected = readiness.binding(task, journal), root = taskDir(task.id);
  const observationFile = path.join(root, `round-${String(task.round).padStart(3, '0')}-zcode-observation.json`);
  const observation = readJson(observationFile, null), result = observation?.result, header = result?.header;
  const keys = ['taskId', 'round', 'sessionId', 'commandId', 'paneId', 'terminalId'];
  const bound = value => value && keys.every(key => value[key] === expected[key]);
  if (task.status !== 'cancel_pending' || task.submission?.status !== 'observed'
      || !bound(observation) || journal.ack?.commandId !== expected.commandId
      || !['accepted', 'duplicate'].includes(journal.ack.status)
      || journal.ack.result?.type !== 'inputAccepted' || journal.ack.result.inputId !== expected.commandId) {
    throw new Error('Persisted terminal failure admission or observation binding mismatch');
  }
  // A bound terminal header decides this command; it never proves session-wide idle by itself. / 精确绑定的终态轮次头只决定本命令，不单独证明整个会话空闲。
  const phaseMatches = journal.turnState === 'failed' ? observation.phase === 'error'
    : observation.phase === journal.turnState;
  if (result.seen !== true || result.terminal !== true || result.state !== journal.turnState || !phaseMatches
      || !['snapshot', 'conversationRowsRangeV4'].includes(result.evidence)
      || header?.kind !== 'turnHeader' || header.sourceCommandId !== expected.commandId || header.state !== journal.turnState
      || !Number.isSafeInteger(header.rowId) || header.rowId < 0 || result.headerRowId !== header.rowId
      || !Number.isSafeInteger(header.endedAt) || header.endedAt <= 0
      || !Number.isSafeInteger(result.seq) || result.seq < 0 || typeof result.logEpoch !== 'string' || !result.logEpoch
      || journal.turnState === 'failed' && (typeof result.error?.code !== 'string' || !result.error.code)
      || !Number.isFinite(Date.parse(observation.timestamp)) || Date.parse(observation.timestamp) < header.endedAt
      || !Number.isFinite(Date.parse(journal.timestamp)) || Date.parse(journal.timestamp) < Date.parse(observation.timestamp)) {
    throw new Error('Persisted terminal outcome lacks authoritative completed-turn evidence');
  }
  if (watcherAlive(task, alive)) throw new Error('Terminal cancellation observer is still active');
  const stateFile = path.join(root, 'zcode-state.json'), state = readJson(stateFile, null);
  const identityKeys = ['taskId', 'round', 'sessionId', 'paneId', 'terminalId'];
  if (!state || identityKeys.some(key => state[key] !== expected[key])
      || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 || alive(state.workerPid)
      || state.state === 'working' || state.reason === 'untracked_command_active'
      || state.commandId != null && state.commandId !== expected.commandId
      || state.commandId == null && !(state.state === 'blocked' && state.reason === 'stop_unconfirmed')) {
    throw new Error('Persisted terminal failure worker is live, foreign or unconfirmed');
  }
  const lease = readJson(leasePath(task.stateDir, task.herdrSession, task.paneId), null);
  if (lease && (lease.taskId !== task.id || lease.workerSessionId !== task.workerSessionId
      || lease.terminalId !== task.terminalId || lease.paneId !== task.paneId || lease.herdrSession !== task.herdrSession)) {
    throw new Error('Persisted terminal failure Pane lease has another owner');
  }
  if (taskList(task.stateDir).some(other => other.id !== task.id && other.agent === 'zcode'
      && other.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(other.status))) {
    throw new Error('Persisted terminal failure native session has another unresolved task');
  }
  let paneIdReusedByShell = false;
  try {
    const pane = resultPayload(inspectPane(task.herdrSession, ['pane', 'get', task.paneId]))?.pane;
    if (!pane || pane.pane_id !== task.paneId || !pane.terminal_id) {
      throw new Error('Persisted terminal outcome Pane identity is incomplete');
    }
    if (pane.terminal_id === task.terminalId || pane.agent_session?.value === task.workerSessionId) {
      throw new Error('Persisted terminal outcome Pane still owns the original execution');
    }
    paneIdReusedByShell = true;
  } catch (error) { if (error.herdrCode !== 'pane_not_found') throw error; }
  const panes = resultPayload(inspectPane(task.herdrSession, ['pane', 'list']))?.panes;
  if (!Array.isArray(panes) || panes.some(pane => !pane.pane_id || !pane.terminal_id)
      || panes.some(pane => pane.terminal_id === task.terminalId || pane.agent_session?.value === task.workerSessionId)) {
    throw new Error('Persisted terminal failure endpoint is moved, reused or unconfirmed');
  }
  const current = loadTask(task.id);
  if (current.status !== task.status || !readiness.matches(expected,
    readiness.binding(current, readJson(readiness.files(current).journal, null)))) {
    throw new Error('Persisted terminal failure task or command binding changed');
  }
  return { confirmed: true, source: journal.turnState === 'failed' ? 'persisted-terminal-failure' : 'persisted-terminal-outcome',
    reason: `original_command_${journal.turnState}`, nativeBinding: expected,
    proof: { state: journal.turnState, ...(result.error?.code ? { errorCode: result.error.code } : {}),
      headerRowId: header.rowId, endedAt: header.endedAt,
      evidence: result.evidence, seq: result.seq, logEpoch: result.logEpoch,
      journalSha256: sha256File(journalFile), observationSha256: sha256File(observationFile), workerStateSha256: sha256File(stateFile),
      localWorkerExited: true, originalPaneTerminalAbsent: true, paneIdReusedByShell },
    scope: 'original-command-only; remote session-wide quiescence not asserted' };
}

function rejectedCommandEvidence(task, { alive = processAlive } = {}) {
  const journal = readJson(readiness.files(task).journal, null);
  // A persisted pre-execution rejection already decides this command; Desktop availability is irrelevant. / 已持久化的执行前拒绝已决定该命令处置，不依赖Desktop在线。
  if (journal?.status !== 'acknowledged' || !readiness.failedAdmission(journal) || journal.ack.result != null
      || !Number.isSafeInteger(journal.ack.revisionAtDecision) || journal.ack.revisionAtDecision < 0
      || !Number.isFinite(Date.parse(journal.timestamp))) return null;
  const expected = readiness.binding(task, journal);
  if (journal.ack.commandId !== expected.commandId) throw new Error('Persisted rejection command identity mismatch');
  if (task.status !== 'cancel_pending' || task.submission?.status !== 'observed') {
    throw new Error('Persisted rejection cannot resolve an uncertain submission');
  }
  if (watcherAlive(task, alive)) throw new Error('Cancellation observer is still active');
  const root = taskDir(task.id);
  const stateFile = path.join(root, 'zcode-state.json'), state = readJson(stateFile, null);
  const observationFile = path.join(root, `round-${String(task.round).padStart(3, '0')}-zcode-observation.json`);
  const observation = readJson(observationFile, null);
  if (!state || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 || alive(state.workerPid)) {
    throw new Error('Persisted rejection local worker exit is unconfirmed');
  }
  for (const [file, value] of [['zcode-state.json', state], ['observation', observation]]) {
    if (!value) continue;
    const keys = ['taskId', 'round', 'sessionId', 'commandId', 'paneId', 'terminalId'];
    const prefixKeys = keys.filter(key => key !== 'commandId');
    if (prefixKeys.some(key => value[key] !== expected[key])) throw new Error('Persisted rejection observation binding mismatch');
    const stoppedProjection = file === 'zcode-state.json' && value.commandId == null
      && value.state === 'blocked' && value.reason === 'stop_unconfirmed';
    if (value.commandId !== expected.commandId && !stoppedProjection) throw new Error('Persisted rejection observation command mismatch');
    if (value.workerPid && alive(value.workerPid)) throw new Error('Cancellation worker is still active');
    if (value.state === 'working' || value.result?.seen || value.result?.terminal
        || ['running', 'queued', 'awaitingInteraction'].includes(value.phase)) {
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
      revisionAtDecision: journal.ack.revisionAtDecision, acknowledgedAt: journal.timestamp,
      journalSha256: sha256File(readiness.files(task).journal), workerStateSha256: sha256File(stateFile),
      localWorkerExited: true },
    scope: 'original-command-only; session-wide quiescence not asserted' };
}

function unsubmittedRoundZeroEvidence(task, { alive = processAlive } = {}) {
  if (task.agent !== 'zcode' || task.status !== 'cancel_pending' || task.round !== 0 || task.workerSessionId
      || task.submission != null || task.history?.some(item => item.status === 'submitted')) return null;
  const root = taskDir(task.id), createFile = path.join(root, 'zcode-create.json'), create = readJson(createFile, null);
  if (create && (create.status !== 'prepared' || create.ack || create.envelope?.type !== 'createSession'
      || !create.envelope.commandId || create.envelope.sessionId != null)) return null;
  const stateFile = path.join(root, 'zcode-state.json'), state = readJson(stateFile, null);
  const expected = { taskId: task.id, round: 0, sessionId: null, paneId: task.paneId ?? null, terminalId: task.terminalId ?? null };
  if (!state || Object.entries(expected).some(([key, value]) => state[key] !== value)
      || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 || alive(state.workerPid)
      || task.watcherPid && alive(task.watcherPid)) return null;
  const current = loadTask(task.id);
  if (current.status !== task.status || current.round !== 0 || current.workerSessionId
      || current.paneId !== task.paneId || current.terminalId !== task.terminalId) return null;
  const proof = { localWorkerExited: true, localWatcherExited: true, createCommand: create?.status || 'absent',
    createFileSha256: create ? sha256File(createFile) : null, workerStateSha256: sha256File(stateFile), noNativeSessionCaptured: true };
  return { confirmed: true, source: 'local-not-submitted', reason: 'round_zero_create_not_sent',
    nativeBinding: { taskId: task.id, agent: 'zcode', round: 0, sessionId: null, cwd: task.cwd,
      herdrSession: task.herdrSession, paneId: task.paneId ?? null, terminalId: task.terminalId ?? null,
      commandId: null, commandSha256: null }, proof,
    scope: 'round-zero createSession was not sent; no native session was created' };
}

// Local-only assessment for the coordinator's explicit quarantine/abandon path. / 协调器显式隔离退出前的本地只读评估。
function inspectAbandonment(task, { alive = processAlive } = {}) {
  if (task.agent !== 'zcode' || ['accepted', 'cancelled', 'coordination-abandoned'].includes(task.status)) {
    throw new Error('Abandonment assessment requires an unresolved ZCode task');
  }
  const expected = { id: task.id, round: task.round, workerSessionId: task.workerSessionId ?? null,
    paneId: task.paneId ?? null, terminalId: task.terminalId ?? null, herdrSession: task.herdrSession, cwd: task.cwd };
  const current = loadTask(task.id);
  if (current.status !== task.status || Object.entries(expected).some(([key, value]) => (current[key] ?? null) !== value)) {
    throw new Error('Abandonment task/round/native binding changed');
  }
  if (watcherAlive(task, alive)) throw new Error('ZCode watcher is still active; abandonment assessment refused');
  const root = taskDir(task.id), stateFile = path.join(root, 'zcode-state.json');
  const state = readJson(stateFile, null), journal = readJson(readiness.files(task).journal, null);
  const expectedState = { taskId: task.id, round: task.round, sessionId: task.workerSessionId ?? null,
    paneId: task.paneId ?? null, terminalId: task.terminalId ?? null };
  if (!state || Object.entries(expectedState).some(([key, value]) => state[key] !== value)
      || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 || alive(state.workerPid)) {
    throw new Error('ZCode local worker exit is unconfirmed; abandonment assessment refused');
  }
  const latest = loadTask(task.id);
  if (latest.status !== task.status || latest.round !== task.round
      || (latest.workerSessionId ?? null) !== (task.workerSessionId ?? null)
      || (latest.paneId ?? null) !== (task.paneId ?? null) || (latest.terminalId ?? null) !== (task.terminalId ?? null)) {
    throw new Error('Abandonment task/round/native binding changed during assessment');
  }
  const exactCommand = task.workerSessionId && journal?.envelope?.type === 'sendText'
    && journal.envelope.sessionId === task.workerSessionId && journal.envelope.commandId;
  const nativeBinding = exactCommand ? readiness.binding(task, journal) : {
    taskId: task.id, agent: task.agent, round: task.round, sessionId: task.workerSessionId ?? null, cwd: task.cwd,
    herdrSession: task.herdrSession, paneId: task.paneId ?? null, terminalId: task.terminalId ?? null,
    commandId: journal?.envelope?.commandId || null,
    commandSha256: journal?.envelope ? readiness.envelopeDigest(journal.envelope) : null,
  };
  return { eligible: true, source: 'local-uncertain-execution', nativeBinding, commandId: nativeBinding.commandId,
    originalExecutionMayContinue: true,
    resourceBinding: { zcodeBindingSha256: task.zcodeBindingSha256 || null, cwd: task.cwd,
      allowedWritePaths: [...(task.allowedWritePaths || task.taskSpec?.allowedChanges || [])],
      workerSessionId: task.workerSessionId ?? null, herdrSession: task.herdrSession,
      paneId: task.paneId ?? null, terminalId: task.terminalId ?? null },
    proof: { localWorkerExited: true, localWatcherExited: true, stateSha256: sha256File(stateFile),
      roundJournalStatus: journal?.status || 'absent', roundJournalSha256: fs.existsSync(readiness.files(task).journal)
        ? sha256File(readiness.files(task).journal) : null, taskBindingSha256: crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex') },
    scope: 'coordination only; native execution may continue; retain resource quarantine' };
}

async function cancellationState(task, dependencies = {}) {
  const { createRemote = current => new ZCodeRemote(readBinding(current.zcodeConfig)),
    createConversation = (remote, sessionId) => new Conversation(remote, sessionId), alive = processAlive } = dependencies;
  const unsubmitted = unsubmittedRoundZeroEvidence(task, { alive });
  if (unsubmitted) return unsubmitted;
  const terminal = terminalCommandEvidence(task, dependencies);
  if (terminal) return terminal;
  const rejected = rejectedCommandEvidence(task, { alive });
  if (rejected) return rejected;
  const journal = readJson(readiness.files(task).journal, null);
  let expected;
  try { expected = readiness.binding(task, journal); }
  catch (error) {
    return { confirmed: false, source: 'local-evidence-incomplete', reason: error.message,
      originalExecutionMayContinue: true, nativeBinding: { taskId: task.id, round: task.round,
        sessionId: task.workerSessionId ?? null, commandId: journal?.envelope?.commandId || null } };
  }
  const remote = createRemote(task); remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    conversation = createConversation(remote, task.workerSessionId); await conversation.subscribe();
    // The V4 client exposes session-wide stop only; an observed active turn is never stopped automatically. / V4客户端只公开会话级stop，观察到活动轮次时绝不自动中断。
    const snapshot = conversation.snapshot;
    if (snapshot.sessionId !== task.workerSessionId) throw new Error('ZCode cancellation snapshot session mismatch');
    const active = snapshot.control?.activeWorks;
    if (!Array.isArray(active)) throw new Error('ZCode cancellation activity shape mismatch');
    if (active.length || snapshot.queue?.items?.length || snapshot.pendingInteractions?.length || snapshot.workspaceHookAdmission) {
      return { confirmed: false, reason: 'native-work-or-interaction-active', source: 'zcode-v4-read-only',
        nativeBinding: expected, originalExecutionMayContinue: true,
        proof: { activeCommandIds: active.map(work => work.sourceCommandId || null), queuedCount: snapshot.queue?.items?.length ?? null,
          pendingInteractionCount: snapshot.pendingInteractions?.length ?? null, seq: snapshot.seq, logEpoch: snapshot.logEpoch } };
    }
    const proof = await readiness.verifyNativeReady(task, journal, remote, conversation);
    const current = loadTask(task.id);
    if (!readiness.matches(expected, readiness.binding(current, readJson(readiness.files(current).journal, null)))) {
      throw new Error('ZCode cancellation command binding changed');
    }
    return { confirmed: true, reason: 'native_quiescent', source: 'zcode-v4-read-only', nativeBinding: expected, proof };
  } finally {
    try { await conversation?.dispose(); } finally { await remote.close(); }
  }
}

// The audited V4 envelope has no verifiable command-scoped/conditional stop contract. / 已审计V4 envelope没有可验证的命令级条件stop契约。
async function cancelWorker(task) {
  if (task.agent !== 'zcode' || task.status !== 'cancel_pending') throw new Error('ZCode cancel requires the bound cancel_pending task');
  const journal = readJson(readiness.files(task).journal, null);
  if (!journal?.envelope?.commandId || journal.envelope.sessionId !== task.workerSessionId) {
    throw new Error('ZCode cancel refused: current command identity is unavailable; no stop sent');
  }
  throw new Error('ZCode cancel refused: the available V4 stop is session-wide and cannot be atomically scoped to the current command; no stop sent');
}

async function reconcileCancellation(task, dependencies = {}) {
  if (task.status !== 'cancel_pending') throw new Error('ZCode cancellation reconciliation requires cancel_pending');
  return cancelNative(task, { reconcileOnly: true, worker: { id: 'zcode',
    verifyCancellationReceipt: (current, receipt) => {
      if (!['local-not-submitted', 'persisted-command-ack', 'persisted-terminal-failure', 'persisted-terminal-outcome'].includes(receipt.source)) return;
      const checked = receipt.source === 'local-not-submitted' ? unsubmittedRoundZeroEvidence(current, dependencies)
        : ['persisted-terminal-failure', 'persisted-terminal-outcome'].includes(receipt.source)
          ? terminalCommandEvidence(current, dependencies) : rejectedCommandEvidence(current, dependencies);
      if (!checked || JSON.stringify(checked) !== JSON.stringify(receipt)) {
        throw new Error('Persisted cancellation evidence changed before confirmation');
      }
    },
    cancellationState: current => cancellationState(current, dependencies) } });
}

module.exports = { cancellationState, cancelWorker, inspectAbandonment, reconcileCancellation,
  rejectedCommandEvidence, terminalCommandEvidence, unsubmittedRoundZeroEvidence };
