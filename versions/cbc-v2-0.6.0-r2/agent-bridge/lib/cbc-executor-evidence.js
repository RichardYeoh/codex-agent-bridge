'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha, readRegular } = require('./protocol-v2');
const { withLock, writeJsonAtomic } = require('./util');
function key(task) {
  if (!task.herdrSession || !task.paneId || !task.terminalId) throw new Error('Missing executor identity');
  return sha(JSON.stringify([task.herdrSession, task.paneId, task.terminalId]));
}
function file(task) { return path.join(task.stateDir, 'cbc-executors', key(task), 'latest.json'); }
function read(task) {
  if (!fs.existsSync(file(task))) return [];
  const value = JSON.parse(readRegular(file(task), 1024 * 1024));
  if (value.executorKey !== key(task) || !Array.isArray(value.events)) throw new Error('Executor evidence identity is invalid');
  return value.events;
}
async function append(task, entry) {
  return withLock('cbc-executor-' + key(task).slice(0, 40), () => {
    const entries = read(task), directory = path.dirname(file(task));
    fs.mkdirSync(directory, { recursive: true });
    // This bounded projection is only for live readiness; immutable task events live elsewhere. / 此有界投影仅用于实时就绪，任务不可变证据独立存储。
    const events = [...entries, entry].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-64);
    writeJsonAtomic(file(task), { schema: 2, executorKey: key(task), events });
  });
}
module.exports = { read, append, file };
