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
    const absolute = path.resolve(task.cwd, value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  });
}

function overlaps(a, b) { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }

function assertSingleActive(candidate, tasks) {
  const id = typeof candidate === 'string' ? candidate : candidate.id;
  const entries = tasks || taskList(typeof candidate === 'object' ? candidate.stateDir : undefined);
  const task = typeof candidate === 'string' ? entries.find(item => item.id === id) : candidate;
  if (task?.parallel && !writeScopes(task).length) throw new Error('Parallel tasks require explicit write scopes');
  for (const other of entries) {
    if (other.id === id) continue;
    // One context binding owns one unresolved task, including pending review. / 同一上下文绑定只持有一个未闭合任务，待验收也不能挤占。
    if (task && UNRESOLVED.has(other.status) && sameBinding(task, other)) {
      throw new Error(`Worker context binding is occupied by ${other.id} (${other.status}); accept, rework, recover or cancel it first`);
    }
    if (!EXECUTING.has(other.status)) continue;
    if (!task?.parallel || !other.parallel) throw new Error(`Another worker task is active: ${other.id} (${other.status})`);
    if (task.agent === 'zcode' && other.agent === 'zcode' && task.zcodeBindingSha256 === other.zcodeBindingSha256) {
      throw new Error('One ZCode Desktop relay binding supports one terminal connection; serialize these tasks');
    }
    const left = writeScopes(task), right = writeScopes(other);
    if (!left.length || !right.length) throw new Error('Parallel tasks require explicit write scopes');
    if (left.some(a => right.some(b => overlaps(a, b)))) throw new Error(`Parallel write scope overlaps ${other.id}`);
  }
}

module.exports = { taskList, assertSingleActive, writeScopes };
