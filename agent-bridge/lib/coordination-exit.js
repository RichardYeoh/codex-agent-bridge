'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgent } = require('./agents');
const { loadTask, saveTask, processAlive, now, event } = require('./util');
const { assertWorkerAbsent } = require('./worker-identity');

async function abandon(task, { reason, actor, evidenceFile, rejectionReceipt } = {}) {
  evidenceFile ||= rejectionReceipt;
  if (!reason?.trim() || !actor?.trim() || !evidenceFile) throw new Error('abandon requires --reason, --actor and --evidence-file');
  if (['accepted', 'cancelled', 'abandoned'].includes(task.status)) throw new Error('Task is already terminal');
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('A watcher still owns this task; do not abandon active observation');
  const initial = JSON.stringify(task), descriptor = getAgent(task.agent);
  const evidence = fs.readFileSync(path.resolve(evidenceFile));
  const rejection = rejectionReceipt ? require('./submission-rejection').inspectRejection(task, { receiptFile: rejectionReceipt }) : null;
  if (rejection && (rejection.state !== 'not_sent' || !['herdr-pre-input-rejection', 'legacy-rpc-crosscheck'].includes(rejection.source))) {
    throw new Error('Pre-input rejection is not proved; no coordination state changed');
  }
  const proof = rejection ? { eligible: true, ...rejection, originalExecutionMayContinue: true }
    : descriptor.inspectAbandonment ? await descriptor.inspectAbandonment(task) : {
    eligible: true, source: 'local-worker-absence', proof: assertWorkerAbsent(task), originalExecutionMayContinue: true,
  };
  if (!proof.eligible || JSON.stringify(loadTask(task.id)) !== initial) throw new Error('Abandonment identity changed or proof unavailable');
  if (rejection && JSON.stringify(require('./submission-rejection').inspectRejection(task, { receiptFile: rejectionReceipt })) !== JSON.stringify(rejection)) {
    throw new Error('Pre-input rejection evidence changed during reconciliation');
  }
  const priorStatus = task.status;
  task.status = 'abandoned'; task.watcherPid = null; task.originalExecutionMayContinue = true;
  task.error = 'Coordination abandoned; native outcome remains unconfirmed and resources are quarantined';
  if (rejection) {
    task.submissionReconciliation = { ...rejection, recordedAt: now(), actor: actor.trim(), reason: reason.trim() };
    task.error = 'Original bridge prompt was rejected before input; native worker is preserved and resources remain quarantined';
  }
  task.abandonment = { reason: reason.trim(), actor: actor.trim(), at: now(), priorStatus, proof,
    evidence: { path: path.resolve(evidenceFile), sha256: crypto.createHash('sha256').update(evidence).digest('hex') },
    resourceFence: { active: true, cwd: task.cwd, nativeSession: task.workerSessionId || null,
      wholeProject: Boolean(rejection),
      herdrSession: task.herdrSession, paneId: task.paneId || null, terminalId: task.terminalId || null,
      relay: task.zcodeBindingSha256 || null, allowedWritePaths: task.allowedWritePaths || null } };
  task.history ||= [];
  task.history.push({ round: task.round, status: 'abandoned', timestamp: now(), source: 'operator', reason: reason.trim() });
  saveTask(task); event(task, 'coordination_abandoned', { resourceFenceActive: true });
  return task;
}

module.exports = { abandon };
