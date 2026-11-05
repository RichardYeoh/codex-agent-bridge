'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic, now } = require('./util');

function leasePath(stateDir, session, pane) {
  const key = crypto.createHash('sha256').update(`${session}\n${pane}`).digest('hex');
  return path.join(stateDir, 'pane-leases', `${key}.json`);
}

function writeLease(task) {
  if (!task.paneId || !task.terminalId) return;
  writeJsonAtomic(leasePath(task.stateDir, task.herdrSession, task.paneId), {
    taskId: task.id, paneId: task.paneId, herdrSession: task.herdrSession,
    terminalId: task.terminalId, workerSessionId: task.workerSessionId || null,
    workerStartedAt: task.workerStartedAt, updatedAt: now(),
  });
}

function leaseForEvent(stateDir, session, pane, workerSessionId) {
  const lease = readJson(leasePath(stateDir, session, pane), null);
  if (!lease || lease.herdrSession !== session || lease.paneId !== pane) return null;
  // A different session cannot inherit an earlier occupant's task. / 不同执行会话不得继承前占用者任务。
  if (lease.workerSessionId && lease.workerSessionId !== workerSessionId) return null;
  return lease;
}

module.exports = { leasePath, writeLease, leaseForEvent };
