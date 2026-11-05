'use strict';

const { loadTask, readJson, processAlive } = require('./util');
const { leasePath } = require('./worker-lease');
const { assertWorkerAbsent } = require('./worker-identity');

function cancellationState(task, { call, alive = processAlive } = {}) {
  if (!['cbc', 'agy'].includes(task.agent) || !task.workerSessionId || !task.paneId || !task.terminalId) {
    return { confirmed: false, reason: 'native_identity_missing' };
  }
  const lease = readJson(leasePath(task.stateDir, task.herdrSession, task.paneId), null);
  if (lease && (lease.taskId !== task.id || lease.workerSessionId !== task.workerSessionId || lease.terminalId !== task.terminalId)) {
    throw new Error('Cancellation Pane lease belongs to another owner');
  }
  if ([task.watcherPid, task.cancellation?.previousWatcherPid].some(pid => pid && alive(pid))) return { confirmed: false, reason: 'observer_still_active' };
  const before = JSON.stringify(task);
  let proof;
  try { proof = assertWorkerAbsent(task, { call, alive }); }
  catch (error) {
    if (['WORKER_SESSION_IN_USE', 'WORKER_PANE_AWAITING_RESTORE'].includes(error.code)) {
      return { confirmed: false, reason: 'registered_worker_present; stop or close the verified worker, then recover' };
    }
    throw error;
  }
  if (JSON.stringify(loadTask(task.id)) !== before) throw new Error('Cancellation task changed during closed-worker proof');
  // Only bridge ownership is closed; this does not assert all detached child jobs have stopped. / 仅确认桥接执行端已关闭，不声称所有脱离子任务均已停止。
  return { confirmed: true, reason: 'registered_worker_closed', source: 'herdr-closed-worker', proof,
    scope: 'registered-worker-only; detached child processes require explicit operator review' };
}

module.exports = { cancellationState };
