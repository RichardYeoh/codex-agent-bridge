'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { config, readJson } = require('./util');
const { sameBinding } = require('./worker-binding');

const EXECUTING = new Set(['created', 'ready', 'running', 'blocked', 'recovering', 'submission_unknown', 'cancel_pending']);
const UNRESOLVED = new Set([...EXECUTING, 'review_pending', 'delivery_missing', 'failed']);

function taskList(stateDir = config().stateDir) {
  const root = path.join(stateDir, 'tasks');
  return (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .map(id => readJson(path.join(root, id, 'task.json'), null)).filter(Boolean);
}

function writeScopes(task) {
  return (task.allowedWritePaths || []).map(value => {
    if (/[*?\[\]{}]/.test(value)) throw new Error('Parallel write scopes must be explicit files or directories, without globs');
    return canonical(path.resolve(task.cwd, value));
  });
}

function overlaps(a, b) { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }

function canonical(value) {
  return require('./path-identity').canonicalPath(value);
}

function resourceScopes(task) {
  if (!task.cwd) return null;
  if (task.status === 'abandoned' && task.abandonment?.resourceFence?.active && task.abandonment.resourceFence.wholeProject) return [canonical(task.cwd)];
  if (!task.allowedWritePaths?.length || task.allowedWritePaths.some(value => /[*?\[\]{}]/.test(value))) return [canonical(task.cwd)];
  return writeScopes(task);
}

function conflict(task, other) {
  if (task.cwd && other.cwd && sameBinding(task, other)) return 'worker context binding';
  if (task.agent === other.agent && task.workerSessionId && task.workerSessionId === other.workerSessionId) return 'native session';
  if (task.herdrSession === other.herdrSession
      && (task.paneId && task.paneId === other.paneId || task.terminalId && task.terminalId === other.terminalId)) return 'Pane or terminal';
  if (task.agent === 'zcode' && other.agent === 'zcode'
      && (!task.zcodeBindingSha256 || !other.zcodeBindingSha256 || task.zcodeBindingSha256 === other.zcodeBindingSha256)) return 'ZCode Desktop relay';
  const left = resourceScopes(task), right = resourceScopes(other);
  if (!left || !right) return 'unconfirmed write scope';
  if (left.some(a => right.some(b => overlaps(a, b)))) return 'write scope';
  return null;
}

function assertSingleActive(candidate, tasks) {
  const id = typeof candidate === 'string' ? candidate : candidate.id;
  const entries = tasks || taskList(typeof candidate === 'object' ? candidate.stateDir : undefined);
  const task = typeof candidate === 'string' ? entries.find(item => item.id === id) : candidate;
  if (task?.parallel && !writeScopes(task).length) throw new Error('Parallel tasks require explicit write scopes');
  for (const other of entries) {
    if (other.id === id) continue;
    // One context binding owns one unresolved task, including pending review. / 同一上下文绑定只持有一个未闭合任务，待验收也不能挤占。
    if (task?.cwd && other.cwd && UNRESOLVED.has(other.status) && sameBinding(task, other)) {
      throw new Error(`Worker context binding is occupied by ${other.id} (${other.status}); accept, rework, recover or cancel it first`);
    }
    let protocolFence = false;
    if (other.taskProtocol === 2) {
      try {
        const layers = other.layeredRequestFile
          ? require('./protocol-v2').inspect(require('./cbc-protocol-v2').request(other)) : other.layers;
        protocolFence = Boolean(layers?.conflicts?.length || layers?.reviewIntegrity === 'contested'
          || other.originalExecutionMayContinue || other.cancellation?.originalExecutionMayContinue);
      } catch { protocolFence = true; }
    }
    const quarantined = protocolFence || other.status === 'abandoned' && other.abandonment?.resourceFence?.active;
    const uncertainFailure = other.status === 'failed' && (other.originalExecutionMayContinue
      || other.blocker?.originalExecutionMayContinue || other.startup?.workerEffectsPossible === true);
    if (!EXECUTING.has(other.status) && !quarantined && !uncertainFailure) continue;
    const reason = task && conflict(task, other);
    if (reason) throw new Error(`Worker resource conflict (${reason}) with ${other.id} (${other.status}); reconcile ownership or use a disjoint project/scope`);
    // Default serialization is project-scoped, never a cross-project global deadlock. / 默认在项目内串行，不把其他独立项目一并锁死。
    if (!quarantined && (!task?.cwd || !other.cwd || canonical(task.cwd) === canonical(other.cwd))
        && (!task?.parallel || !other.parallel)) throw new Error(`Another worker task is active: ${other.id} (${other.status})`);
    if (task?.parallel && other.parallel && (!writeScopes(task).length || !writeScopes(other).length)) {
      throw new Error('Parallel tasks require explicit write scopes');
    }
  }
}

module.exports = { taskList, assertSingleActive, writeScopes, conflict, resourceScopes };
