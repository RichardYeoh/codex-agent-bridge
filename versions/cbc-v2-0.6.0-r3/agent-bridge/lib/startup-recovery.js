'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config, taskDir, readJson, loadTask, saveTask, now, event, processAlive } = require('./util');

function candidate(task) {
  return ['cbc', 'agy', 'opencode', 'zcode'].includes(task.agent) && ['failed', 'blocked', 'created', 'cancel_pending'].includes(task.status)
    && task.round === 0 && !task.workerSessionId && !task.paneId && !task.terminalId;
}

function proveNotStarted(task) {
  if (!candidate(task) || !['failed', 'blocked', 'created', 'cancel_pending'].includes(task.status)
      || path.resolve(task.stateDir) !== path.resolve(config().stateDir)) throw new Error('Not an unstarted worker task');
  for (const key of ['submission', 'workerStartedAt', 'promptPath', 'promptBody', 'deliveryPath',
    'restoredContextSessionId', 'reusedFromTaskId', 'createdLocation']) {
    if (task[key] != null) throw new Error(`Startup cancellation refused: ${key} indicates possible worker activity`);
  }
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('Startup observer is still active');
  if (task.startup?.ownerPid && processAlive(task.startup.ownerPid)) throw new Error('Startup owner is still active');
  if (task.history?.some(item => item.round !== 0 || !['created', 'failed', 'blocked'].includes(item.status))) {
    throw new Error('Startup history contains execution or submission evidence');
  }
  const dir = taskDir(task.id), allowed = new Set(['task.json', 'initial-request.md', 'worker-label.txt']);
  if (fs.readdirSync(dir).some(name => !allowed.has(name))) throw new Error('Startup task has worker or round artifacts; inspect before cancellation');
  const eventsFile = path.join(task.stateDir, 'events.ndjson');
  const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(item => item.taskId === task.id) : [];
  if (events.some(item => item.round !== 0 || !item.type.startsWith('notification_') && !['dispatch_failed',
    'worker_reuse_unavailable', 'worker_context_resume_planned'].includes(item.type))) {
    throw new Error('Startup events contain activity or unrecognized evidence');
  }
  let source;
  if (task.startup) {
    if (task.startup.protocol !== 1 || !['checking-server', 'reuse-check'].includes(task.startup.phase) || task.startup.workerEffectsPossible !== false
        || !task.startup.attemptId) throw new Error('Startup effect boundary is uncertain');
    source = 'startup-effect-boundary';
  } else {
    // Legacy recovery needs the exact server-check failure, not merely missing session fields. / 旧任务须有精确服务检查失败证据，不能仅凭会话字段缺失放行。
    const message = `Herdr server for session "${task.herdrSession}" did not start; if this is a new named session, run \`herdr session attach ${task.herdrSession}\` once to initialize it`;
    if (task.error !== message || !task.history?.some(item => item.status === 'failed' && item.message === message)
        || !events.some(item => item.type === 'dispatch_failed' && item.message === message)) {
      throw new Error('Legacy startup has no attested pre-worker server failure');
    }
    source = 'legacy-server-check-failure';
  }
  for (const folder of ['worker-contexts', 'pane-leases']) {
    const root = path.join(task.stateDir, folder);
    for (const name of fs.existsSync(root) ? fs.readdirSync(root).filter(value => value.endsWith('.json')) : []) {
      const entry = readJson(path.join(root, name));
      if (entry.taskId === task.id || entry.lastTaskId === task.id) throw new Error('Startup task has context or Pane ownership evidence');
    }
  }
  const current = loadTask(task.id);
  if (JSON.stringify(current) !== JSON.stringify(task)) throw new Error('Startup task changed; no state overwritten');
  return { confirmed: true, source, taskId: task.id, round: 0, agent: task.agent,
    taskSha256: crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex'),
    noNativeSessionCreated: true, noTaskSubmitted: true };
}

function cancelNotStarted(task) {
  const proof = proveNotStarted(task);
  const current = loadTask(task.id);
  if (JSON.stringify(proveNotStarted(current)) !== JSON.stringify(proof)) throw new Error('Startup proof changed; no state overwritten');
  current.status = 'cancelled'; current.error = null; current.watcherPid = null;
  current.cancellation = { phase: 'confirmed', source: 'startup-not-started', confirmedAt: now(),
    interruptAttempted: false, evidence: proof };
  current.history ||= [];
  current.history.push({ round: 0, status: 'cancelled', timestamp: now(), source: 'startup-not-started' });
  saveTask(current); event(current, 'cancelled', { source: 'startup-not-started' });
  return current;
}

module.exports = { candidate, proveNotStarted, cancelNotStarted };
