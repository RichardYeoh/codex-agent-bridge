'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
process.env.AGENT_BRIDGE_STATE_DIR = stateDir;

const {
  appendJsonl, ensureDir, event, loadTask, makeTaskId, readJson, saveTask, taskDir, writeJsonAtomic,
} = require('../lib/util');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('writeJsonAtomic creates a file and leaves no temp/backup behind', () => {
  const file = path.join(stateDir, 'plain.json');
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  const leftovers = fs.readdirSync(stateDir).filter(name => name.startsWith('plain.json.'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonAtomic replaces existing content and survives stale backup files', () => {
  const file = path.join(stateDir, 'replace.json');
  writeJsonAtomic(file, { round: 1 });
  fs.writeFileSync(`${file}.999.previous`, '{"stale":true}');
  writeJsonAtomic(file, { round: 2 });
  assert.deepEqual(readJson(file), { round: 2 });
  writeJsonAtomic(file, { round: 3 });
  assert.deepEqual(readJson(file), { round: 3 });
  // 只清理本次进程产生的临时件；别人的 .previous 不动（避免误删）。
  const own = fs.readdirSync(stateDir)
    .filter(name => name.startsWith(`replace.json.${process.pid}.`));
  assert.deepEqual(own, []);
});

test('writeJsonAtomic creates parent directories', () => {
  const file = path.join(stateDir, 'deep', 'nested', 'value.json');
  writeJsonAtomic(file, { ok: true });
  assert.deepEqual(readJson(file), { ok: true });
});

test('task ids are validated, ids and dirs stay inside the state dir', () => {
  const id = makeTaskId();
  assert.match(id, /^task-[0-9]+-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.equal(taskDir(id), path.join(stateDir, 'tasks', id));
  for (const bad of ['../escape', 'A-upper', 'x', 'bad id', 'task/../x']) {
    assert.throws(() => taskDir(bad), /Invalid task id/);
  }
});

test('saveTask/loadTask round-trips and updates updatedAt', () => {
  const task = { id: 'test-roundtrip', round: 1, status: 'running', history: [] };
  saveTask(task);
  const loaded = loadTask('test-roundtrip');
  assert.equal(loaded.status, 'running');
  assert.ok(loaded.updatedAt);
});

test('appendJsonl appends one line per call and stays parseable', () => {
  const file = path.join(stateDir, 'events-test.ndjson');
  appendJsonl(file, { n: 1 });
  appendJsonl(file, { n: 2 });
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(line => JSON.parse(line).n), [1, 2]);
});

test('readJson returns fallback only for missing files', () => {
  assert.equal(readJson(path.join(stateDir, 'missing.json'), 'fallback'), 'fallback');
  const bad = path.join(stateDir, 'broken.json');
  fs.writeFileSync(bad, '{not json');
  assert.throws(() => readJson(bad), /JSON/);
});

test('event() writes taskId, round and type', () => {
  const task = { id: 'test-event', round: 2 };
  event(task, 'settled', { status: 'review_pending' });
  const line = JSON.parse(fs.readFileSync(path.join(stateDir, 'events.ndjson'), 'utf8').trim());
  assert.equal(line.taskId, 'test-event');
  assert.equal(line.round, 2);
  assert.equal(line.type, 'settled');
  assert.equal(line.status, 'review_pending');
  ensureDir(path.join(stateDir, 'x'));
});
