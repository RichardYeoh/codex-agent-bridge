'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
process.env.HERDR_BIN_PATH = path.join(__dirname, 'fixtures', 'herdr-stub.cjs');
process.env.BRIDGE_STUB_STATE = path.join(root, 'herdr.json');
process.env.BRIDGE_STUB_QUEUE = path.join(root, 'queue.ndjson');
process.env.AGENT_BRIDGE_CODEX_JS = path.join(__dirname, 'fixtures', 'codex-stub.cjs');
const { saveTask, loadTask, withLock, writeJsonAtomic } = require('../lib/util');
const { submit, recoverOne } = require('../bin/agent-bridge');
const { assertWorker, updateWorkerSession } = require('../lib/worker');
const { notifyTask, acknowledgeTask } = require('../lib/notify');
const { memoryQueue } = require('./fixtures/queue-client.cjs');
const queue = memoryQueue();
const notifyOptions = { clientFactory: queue.clientFactory };

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function task(id) {
  return { id, agent: 'cbc', stateDir: root, cwd: root, herdrSession: 'audit-test',
    paneId: 'w1:p1', terminalId: 'term-test', agentName: id, round: 0,
    status: 'ready', history: [], codexThread: 'audit-thread' };
}

function stub(value, mode) {
  fs.writeFileSync(process.env.BRIDGE_STUB_STATE, JSON.stringify({ mode, calls: [],
    agent: { agent: 'codebuddy', name: value.id, terminal_id: 'term-test',
      agent_status: 'idle', completion_seq: 1 } }));
}

test('fast completion is observed and a task is submitted exactly once', async () => {
  const value = task('audit-fast');
  stub(value, 'fast');
  await submit(value, 'small task', { activityTimeoutMs: 10, startWatcherFn: () => 123 });
  assert.equal(loadTask(value.id).submission.status, 'observed');
  const calls = JSON.parse(fs.readFileSync(process.env.BRIDGE_STUB_STATE)).calls;
  assert.equal(calls.filter(call => call[1] === 'send-text').length, 1);
  assert.equal(calls.filter(call => call[1] === 'send-keys').length, 1);
  value.status = 'accepted';
  saveTask(value);
});

test('uncertain submission is durable, never resent, and recover stays observational', async () => {
  const value = task('audit-uncertain');
  stub(value, 'idle');
  await assert.rejects(submit(value, 'small task', { activityTimeoutMs: 10 }), /Timed out/);
  assert.equal(loadTask(value.id).status, 'submission_unknown');
  const actions = await recoverOne(loadTask(value.id));
  assert.match(actions[0], /remains uncertain/);
  const calls = JSON.parse(fs.readFileSync(process.env.BRIDGE_STUB_STATE)).calls;
  assert.equal(calls.filter(call => call[1] === 'send-text').length, 1);
});

test('session recovery filters identical pane IDs by task, server and launch time', () => {
  const value = task('audit-session');
  value.workerStartedAt = '2026-10-27T02:00:00Z';
  const valid = { taskId: value.id, herdrSession: value.herdrSession, paneId: value.paneId,
    sessionId: 'correct-session', timestamp: '2026-10-27T03:00:00Z' };
  const entries = [valid, { ...valid, herdrSession: 'other', sessionId: 'wrong-server' },
    { ...valid, taskId: 'other-task', sessionId: 'wrong-task' },
    { ...valid, timestamp: '2026-10-27T01:00:00Z', sessionId: 'old-session' }];
  fs.writeFileSync(path.join(root, 'hook-events.ndjson'), entries.map(JSON.stringify).join('\n'));
  updateWorkerSession(value);
  assert.equal(value.workerSessionId, 'correct-session');
});

test('worker replacement cannot silently receive a follow-up', () => {
  const value = task('audit-identity');
  const agent = { agent: 'codebuddy', name: value.id, terminal_id: value.terminalId };
  assert.equal(assertWorker(value, agent), agent);
  assert.throws(() => assertWorker(value, { ...agent, terminal_id: 'replacement' }), /identity mismatch/);
  assert.throws(() => assertWorker(value, { ...agent, agent: 'codex' }), /identity mismatch/);
});

test('queue success is distinct from receipt, duplicate recovery does not send twice', async () => {
  const value = task('audit-notify');
  value.round = 1;
  value.status = 'review_pending';
  await notifyTask(value, notifyOptions);
  assert.equal(value.notification.status, 'queued');
  const key = value.notification.key;
  await notifyTask(value, notifyOptions);
  await acknowledgeTask(value, key, notifyOptions);
  assert.equal(loadTask(value.id).notification.status, 'acknowledged');
  await notifyTask(value, notifyOptions);
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);
  assert.equal(queue.items.length, 0);
  await assert.rejects(acknowledgeTask(value, 'old-event', notifyOptions), /Stale/);
});

test('queue failure can be repaired while an interrupted send is not blindly repeated', async () => {
  const value = task('audit-notify-failure');
  value.round = 1;
  value.status = 'review_pending';
  queue.fail = true;
  await notifyTask(value, notifyOptions);
  assert.equal(value.notification.status, 'pending');
  queue.fail = false;
  await notifyTask(value, notifyOptions);
  assert.equal(value.notification.status, 'queued');
  await acknowledgeTask(value, value.notification.key, notifyOptions);
  const interrupted = task('audit-interrupted-send');
  interrupted.round = 1;
  interrupted.status = 'review_pending';
  interrupted.notification = { key: '1:review_pending:none', round: 1, status: 'sending' };
  const before = queue.calls.filter(call => call.method === 'add').length;
  await notifyTask(interrupted, notifyOptions);
  assert.equal(interrupted.notification.status, 'uncertain');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, before);
});

test('task mutations serialize and abandoned locks can be recovered', async () => {
  const value = task('audit-lock');
  value.count = 0;
  saveTask(value);
  await Promise.all(Array.from({ length: 8 }, () => withLock(value.id, async () => {
    const current = loadTask(value.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    current.count += 1;
    saveTask(current);
  })));
  assert.equal(loadTask(value.id).count, 8);
  const lock = path.join(root, 'locks', 'audit-abandoned.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  assert.equal(await withLock('audit-abandoned', () => 42), 42);
});

test('a replacement failure preserves the last valid state instead of truncating it', () => {
  const file = path.join(root, 'atomic.json');
  writeJsonAtomic(file, { original: true });
  const rename = fs.renameSync;
  fs.renameSync = () => { const error = new Error('disk failure'); error.code = 'ENOSPC'; throw error; };
  try { assert.throws(() => writeJsonAtomic(file, { original: false }), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { original: true });
});
