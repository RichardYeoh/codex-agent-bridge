'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getAgent } = require('./agents');
const { agentInfo, startWatcher, api } = require('./herdr');
const { assertWorker } = require('./worker');
const { restoredOwner } = require('./worker-identity');
const { writeLease } = require('./worker-lease');
const { loadTask, saveTask, readJson, taskDir, now, event } = require('./util');
const { renderSubmissionPointer } = require('./worker-policy');

function timeout(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 86400000) throw new Error('wait-timeout-ms must be 0 or milliseconds up to one day');
  return number;
}

function rebind(task, owner) {
  if (task.agent === 'zcode') require('./zcode-rebinding').assertRebindableObserver(task, owner);
  const previous = { paneId: task.paneId, terminalId: task.terminalId, workerSessionId: task.workerSessionId };
  const lease = readJson(require('./worker-lease').leasePath(task.stateDir, task.herdrSession, owner.pane_id), null);
  if (lease && lease.taskId !== task.id) {
    const prior = loadTask(lease.taskId);
    if (!['accepted', 'cancelled'].includes(prior.status)) throw new Error('Restored Pane lease belongs to another unresolved task');
  }
  Object.assign(task, { paneId: owner.pane_id, terminalId: owner.terminal_id, workspaceId: owner.workspace_id,
    tabId: owner.tab_id, agentName: owner.name || null, agentNameReleased: false });
  task.observerGeneration = (task.observerGeneration || 0) + 1; task.watcherPid = null;
  task.restoredContextSessionId = task.workerSessionId;
  task.workerLifecycle = { phase: 'adopted', at: now(), previous };
  writeLease(task); saveTask(task); event(task, 'restored_worker_adopted', { previous });
  return task;
}

async function adoptRestored(task, options = {}) {
  if (task.taskProtocol === 2) throw new Error('V2 request binding is immutable; recover observes the original request only. Cold reuse is supported after coordination closure; no Pane was adopted');
  if (!task.workerSessionId || ['accepted', 'cancelled'].includes(task.status)) throw new Error('adopt-restored requires an unresolved captured native session');
  const owner = restoredOwner(task, { paneId: options.pane });
  if (task.agent === 'zcode' && owner.terminal_id !== task.terminalId) {
    throw new Error('ZCode wrapper terminal changed; verify and reload only the local observer before adopting, no business prompt authorized');
  }
  const others = require('./worker-scheduling').taskList(task.stateDir);
  if (others.some(other => other.id !== task.id && other.agent === task.agent && other.workerSessionId === task.workerSessionId
      && !['accepted', 'cancelled'].includes(other.status))) throw new Error('Native session has another unresolved task owner');
  const checked = restoredOwner(task, { paneId: owner.pane_id });
  if (checked.terminal_id !== owner.terminal_id || checked.agent_session?.value !== owner.agent_session?.value) {
    throw new Error('Restored worker identity changed during adoption');
  }
  rebind(task, owner);
  if (task.round > 0 && task.submission?.status === 'observed' && !['review_pending', 'delivery_missing'].includes(task.status)) {
    task.status = 'running'; task.error = null;
    if (task.abandonment) task.abandonment.resourceFence.active = false;
    saveTask(task); task.watcherPid = startWatcher(task.id); saveTask(task);
  }
  return task;
}

async function observe(task, options = {}) {
  if (!['running', 'blocked', 'failed', 'delivery_missing'].includes(task.status) || task.round < 1
      || task.submission?.status !== 'observed') throw new Error('observe requires a known submitted unresolved round; reconcile unknown admission first');
  const descriptor = getAgent(task.agent), agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
  if (agent.agent_session?.value && agent.agent_session.value !== task.workerSessionId) throw new Error('Native session identity changed');
  await descriptor.refreshWorker?.(task);
  const refreshed = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
  const blocker = descriptor.readBlocker?.(task);
  if (refreshed.agent_status === 'blocked' && task.agent !== 'zcode') {
    throw new Error(`${blocker?.message || 'Worker remains blocked'}; resolve input or use explicit resume --retry-failed for a confirmed failed OC turn`);
  }
  if (options['wait-timeout-ms'] !== undefined) task.waitTimeoutMs = timeout(options['wait-timeout-ms']);
  const previousStatus = task.status;
  task.observerGeneration = (task.observerGeneration || 0) + 1; task.watcherPid = null;
  task.observationRequestedAt = now();
  saveTask(task);
  try {
    if (descriptor.resumeInput) {
      api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'ctrl+u']);
      api(task.herdrSession, ['pane', 'send-text', task.paneId, descriptor.resumeInput]);
      api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
    }
  } catch (error) {
    task.status = previousStatus; task.error = `Observation request unconfirmed: ${error.message}; no business prompt sent`;
    saveTask(task); throw error;
  }
  task.status = 'running'; task.error = null; delete task.blocker;
  saveTask(task); task.watcherPid = startWatcher(task.id); saveTask(task);
  event(task, 'observation_attached', { observerGeneration: task.observerGeneration });
  return task;
}

async function settle(task) {
  if (!['delivery_missing', 'blocked', 'failed'].includes(task.status) || task.round < 1 || task.submission?.status !== 'observed') {
    throw new Error('settle requires an unresolved submitted round with a late delivery');
  }
  const relative = task.deliveryPath && path.relative(taskDir(task.id), path.resolve(task.deliveryPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(task.deliveryPath)
      || fs.statSync(task.deliveryPath).size === 0) throw new Error('Current-round delivery is absent, empty or outside this task');
  const descriptor = getAgent(task.agent);
  if (task.agent === 'opencode') {
    const proof = require('./opencode').confirmCompletion(task);
    if (proof.confirmed !== true) throw new Error('Native current-round completion is not confirmed');
  } else if (task.agent === 'zcode') {
    const receipt = require('./zcode-settlement').readExecution(task);
    if (receipt?.state !== 'idle') throw new Error('ZCode current-command successful terminal receipt is missing');
  } else if (task.agent === 'cbc' && task.cbcTurnProtocol === 1) {
    const turn = require('./cbc-turn').readTurn(task);
    if (turn.state !== 'stopped') throw new Error('CBC exact current-turn Stop is unavailable; no late delivery settlement');
    let absent = false;
    try {
      const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('CBC worker is not idle');
    } catch (error) {
      if (!['pane_not_found', 'agent_not_found', 'agent_not_registered'].includes(error.herdrCode)) throw error;
      const receipt = require('./pane-cancellation').cancellationState(task);
      if (receipt.confirmed !== true) throw new Error('CBC closed-worker evidence is incomplete; no late delivery settlement');
      absent = true;
    }
    if (!absent) await require('./cbc-observation').verifyProcess(task, turn);
    if (require('./cbc-turn').readTurn(task).state !== 'stopped') throw new Error('CBC worker changed before late delivery settlement');
  } else {
    const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('Native worker is not settled');
  }
  task.status = 'review_pending'; task.error = null; task.watcherPid = null;
  task.observerGeneration = (task.observerGeneration || 0) + 1;
  task.settlementSeq = (task.settlementSeq || 0) + 1;
  task.history.push({ round: task.round, status: 'review_pending', timestamp: now(), source: 'late-delivery-settle' });
  saveTask(task); require('./worker-context').recordContext(task); event(task, 'late_delivery_settled');
  return task;
}

async function retryFailed(task) {
  if (task.agent !== 'opencode' || !['blocked', 'failed'].includes(task.status) || task.round < 1) {
    throw new Error('retry-failed currently requires a failed submitted OpenCode round');
  }
  require('./worker-scheduling').assertSingleActive(task);
  const adapter = require('./opencode');
  const records = fs.readdirSync(taskDir(task.id)).filter(name => /^round-\d+-opencode-retry-\d+\.json$/.test(name))
    .map(name => readJson(path.join(taskDir(task.id), name))).filter(item => item.round === task.round)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
  const prior = records.at(-1);
  if (prior && ['sending', 'uncertain'].includes(prior.status)) throw new Error('Retry admission is uncertain; run recover without resending');
  const authorization = prior?.status === 'prepared'
    ? { attemptNumber: prior.attemptNumber, turnFingerprint: prior.turnFingerprint }
    : adapter.authorizeFailedRoundRetry(task, {});
  const attemptNumber = authorization.attemptNumber, expectedFingerprint = authorization.turnFingerprint;
  const prepared = adapter.prepareFailedRoundRetry(task, { attemptNumber, expectedFingerprint });
  task.opencodeRetry = { round: task.round, attemptNumber, admissionId: prepared.id, status: 'prepared', turnFingerprint: expectedFingerprint };
  task.history.push({ round: task.round, status: 'retry_prepared', attemptNumber, admissionId: prepared.id, timestamp: now() });
  saveTask(task);
  task.opencodeRetry.status = 'sending'; saveTask(task);
  try {
    adapter.submitFailedRoundRetry(task, renderSubmissionPointer(task), { attemptNumber, expectedFingerprint });
    task.opencodeRetry.status = 'confirmed'; task.status = 'running'; task.error = null;
    task.submission.status = 'observed'; task.observerGeneration = (task.observerGeneration || 0) + 1;
    task.history.push({ round: task.round, status: 'retry_submitted', attemptNumber, admissionId: prepared.id, timestamp: now() });
    saveTask(task); task.watcherPid = startWatcher(task.id); saveTask(task);
  } catch (error) {
    const current = readJson(prepared.file, null), unsent = current?.status === 'prepared';
    task.opencodeRetry.status = unsent ? 'prepared' : 'uncertain';
    if (!unsent) { task.status = 'submission_unknown'; task.submission.status = 'uncertain'; }
    task.error = error.message; saveTask(task); throw error;
  }
  return task;
}

module.exports = { timeout, rebind, adoptRestored, observe, settle, retryFailed };
