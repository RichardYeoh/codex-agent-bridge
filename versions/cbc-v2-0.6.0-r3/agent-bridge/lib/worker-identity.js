'use strict';

const { api, resultPayload } = require('./herdr');
const { matchesHerdrAgent } = require('./agents');
const { readJson, processAlive } = require('./util');
const path = require('node:path');

function cbcProcessProof(task) {
  if (task.agent !== 'cbc') return null;
  if (task.submission?.inputReceipt?.processProof) return task.submission.inputReceipt.processProof;
  if (!task.stateDir || !task.submission?.attemptId || !/^[a-zA-Z0-9-]+$/.test(task.submission.attemptId)) return task.cbcPriorProcessProof || null;
  const file = path.join(task.stateDir, 'tasks', task.id,
    `round-${String(task.round).padStart(3, '0')}-submission-${task.submission.attemptId}.json`);
  const attempt = readJson(file, null);
  if (!attempt || attempt.taskId !== task.id || attempt.round !== task.round
      || attempt.workerSessionId !== task.workerSessionId) return null;
  return attempt.processProof || null;
}

function inventory(task, call = api) {
  const panes = resultPayload(call(task.herdrSession, ['pane', 'list']))?.panes;
  const agents = resultPayload(call(task.herdrSession, ['agent', 'list']))?.agents;
  if (!Array.isArray(panes) || !Array.isArray(agents)) throw new Error('Herdr ownership inventory is incomplete; no worker started');
  const records = new Map(panes.map(pane => [pane.pane_id, { ...pane }]));
  for (const agent of agents) records.set(agent.pane_id, { ...records.get(agent.pane_id), ...agent });
  return [...records.values()];
}

function findLiveOwners(task, { call = api } = {}) {
  return inventory(task, call).filter(item => task.workerSessionId && item.agent_session?.value === task.workerSessionId
    || task.terminalId && item.terminal_id === task.terminalId);
}

function assertWorkerAbsent(task, { call = api, alive = processAlive } = {}) {
  const records = inventory(task, call);
  const owners = records.filter(item => task.workerSessionId && item.agent_session?.value === task.workerSessionId
    || task.terminalId && item.terminal_id === task.terminalId);
  if (owners.length) {
    const error = new Error(`Original worker is present; use adopt-restored ${task.id} after verifying its native session; no process or prompt created`);
    error.code = 'WORKER_SESSION_IN_USE'; error.panes = owners.map(item => item.pane_id); throw error;
  }
  if (records.some(item => item.pane_id === task.paneId)) {
    const error = new Error('Original Pane still exists or awaits native restore; inspect it before rebuilding');
    error.code = 'WORKER_PANE_AWAITING_RESTORE'; throw error;
  }
  const processProof = cbcProcessProof(task);
  if (processProof && (!Number.isSafeInteger(processProof.pid) || processProof.pid <= 0
      || typeof processProof.processStartedAt !== 'string')) {
    throw new Error('Saved CBC process proof is malformed; no worker absence inferred');
  }
  // Missing Herdr session refs cannot hide a still-live original process after Pane migration. / Herdr缺原生引用时，Pane迁移也不能隐藏仍存活的原进程。
  if (processProof && alive(processProof.pid)) {
    const error = new Error('Original CBC process is still present despite missing Pane metadata; no new worker or cancellation confirmation');
    error.code = 'WORKER_SESSION_IN_USE'; throw error;
  }
  if (task.agent === 'cbc' && task.cbcTurnProtocol === 1 && !processProof) {
    throw new Error('CBC original process absence cannot be verified; inspect the saved worker before restoring or cancelling');
  }
  return { originalPaneAbsent: true, originalTerminalAbsent: true, nativeSessionNotRegistered: true };
}

function restoredOwner(task, { call = api, paneId } = {}) {
  const candidates = findLiveOwners(task, { call }).filter(item => !paneId || item.pane_id === paneId);
  if (candidates.length !== 1) throw new Error('Restored native session owner is missing or ambiguous');
  const owner = candidates[0];
  if (owner.agent_session?.value !== task.workerSessionId || !matchesHerdrAgent(task.agent, owner.agent) || !owner.terminal_id
      || !['working', 'idle', 'blocked', 'done'].includes(owner.agent_status)) {
    throw new Error('Restored worker native session or agent identity is unconfirmed');
  }
  return owner;
}

module.exports = { inventory, findLiveOwners, assertWorkerAbsent, restoredOwner, cbcProcessProof };
