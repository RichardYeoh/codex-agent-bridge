'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { reconcileCancellation } = require('../lib/zcode-cancellation');
const { saveTask, loadTask, writeJsonAtomic } = require('../lib/util');
const { files } = require('../lib/zcode-readiness');
const { writeLease } = require('../lib/worker-lease');
const { assertSingleActive } = require('../lib/worker-scheduling');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-cancel-confirm-')); let count = 0;
test.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dir = path.join(root, 'case-' + ++count); fs.mkdirSync(dir); process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'old-zcode-task', agent: 'zcode', stateDir: dir, cwd: dir, workerSessionId: 'original-session',
    herdrSession: 'stub', paneId: 'closed-pane', terminalId: 'old-terminal', round: 1, status: 'cancel_pending', history: [],
    submission: { status: 'observed' }, error: 'agent_not_found', watcherPid: null };
  const journal = { envelope: { type: 'sendText', commandId: 'old-command', sessionId: task.workerSessionId, payload: { text: 'old task' } },
    status: 'acknowledged', ack: { status: 'failed', commandId: 'old-command', reasonCode: 'modelUnavailable' } };
  const snapshot = { ...structuredClone(require('./fixtures/zcode-snapshot.json')), sessionId: task.workerSessionId };
  saveTask(task); writeJsonAtomic(files(task).journal, journal);
  writeJsonAtomic(path.join(dir, 'tasks', task.id, 'zcode-state.json'), { taskId: task.id, round: task.round,
    sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
    commandId: journal.envelope.commandId, state: 'blocked', reason: 'modelUnavailable', workerPid: 99999991 });
  const calls = [], remote = new EventEmitter();
  remote.connect = async () => { calls.push('connect'); };
  remote.attachProject = async (_cwd, options) => { assert.equal(options.create, false); calls.push('attach'); };
  remote.query = async envelope => { calls.push('query'); return { results: [{ key: { sessionId: envelope.sessionId, commandId: envelope.commandId }, result: journal.ack }] }; };
  remote.close = () => calls.push('close');
  const conversation = { snapshot, subscribe: async () => calls.push('subscribe'), dispose: async () => calls.push('unsubscribe') };
  return { task, journal, snapshot, remote, conversation, calls, dependencies: { createRemote: () => remote, createConversation: () => conversation } };
}

test('closed Pane cancellation confirms exact failed native command and releases the serial gate without writes to native runtime', async () => {
  const f = fixture(), bytes = fs.readFileSync(files(f.task).journal);
  const result = await reconcileCancellation(f.task, f.dependencies);
  assert.equal(result.status, 'cancelled'); assert.equal(result.workerSessionId, 'original-session');
  assert.equal(result.cancellation.evidence.proof.previous.reason, 'modelUnavailable');
  assert.equal(result.cancellation.evidence.nativeBinding.commandId, 'old-command');
  assert.deepEqual(f.calls, ['connect', 'attach', 'subscribe', 'query', 'unsubscribe', 'close']);
  assert.deepEqual(fs.readFileSync(files(f.task).journal), bytes);
  assert.doesNotThrow(() => assertSingleActive({ id: 'next-cbc-task', stateDir: f.task.stateDir }));
});

test('unknown admission cannot be declared cancelled even with a draft and empty activity', async () => {
  const f = fixture(); f.journal.ack = 'unknown';
  const result = await reconcileCancellation(f.task, f.dependencies);
  assert.equal(result.status, 'cancel_pending'); assert.match(result.error, /unconfirmed/);
});

test('foreign activity, pending queue or approval keeps cancellation unconfirmed and does not stop anything', async () => {
  for (const mutate of [s => { s.control.activeWorks = [{ sourceCommandId: 'foreign' }]; },
    s => { s.queue.items = [{ id: 'queued' }]; }, s => { s.pendingInteractions = [{ interactionId: 'approval' }]; }]) {
    const f = fixture(); mutate(f.snapshot);
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
    assert.equal(f.calls.includes('query'), false); assert.equal(f.calls.filter(x => x === 'connect').length, 1);
  }
});

test('Relay contention or KICKED is reported once without a reconnect or forced close of another owner', async () => {
  for (const reason of ['ZCODE_RELAY_LOCAL_BUSY', 'KICKED']) {
    const f = fixture(); f.remote.connect = async () => { f.calls.push('connect'); const error = new Error(reason); error.code = reason; throw error; };
    const result = await reconcileCancellation(f.task, f.dependencies);
    assert.equal(result.status, 'cancel_pending'); assert.match(result.error, new RegExp(reason));
    assert.deepEqual(f.calls, ['connect', 'close']);
  }
});

test('session mismatch and concurrent replacement are never overwritten with a manufactured terminal state', async () => {
  const f = fixture(); f.snapshot.sessionId = 'wrong';
  assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
  const g = fixture(), query = g.remote.query;
  g.remote.query = async envelope => { const value = await query(envelope); saveTask({ ...loadTask(g.task.id), round: 2, status: 'running', workerSessionId: 'new-session' }); return value; };
  await assert.rejects(reconcileCancellation(g.task, g.dependencies), /binding changed/);
  assert.equal(loadTask(g.task.id).status, 'running'); assert.equal(loadTask(g.task.id).workerSessionId, 'new-session');
});

test('actual coordinator recover routes cancel_pending through read-only native confirmation using isolated transports', () => {
  const f = fixture(), transport = path.join(f.task.stateDir, 'transport.json');
  writeJsonAtomic(transport, { snapshot: f.snapshot, ack: f.journal.ack, calls: [], agent: {} });
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-readiness-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id], { env: { ...process.env,
      AGENT_BRIDGE_STATE_DIR: f.task.stateDir, ZCODE_READY_TEST_STATE: transport }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(loadTask(f.task.id).status, 'cancelled');
  const calls = JSON.parse(fs.readFileSync(transport)).calls;
  assert.equal(calls.some(call => call.op === 'command' || call.op === 'herdr'), false);
});

function offlineFixture() {
  const f = fixture();
  f.journal.timestamp = '2026-11-03T00:00:00.000Z'; f.journal.ack.revisionAtDecision = 0;
  writeJsonAtomic(files(f.task).journal, f.journal); writeLease(f.task);
  f.remote.connect = async () => { f.calls.push('connect'); throw new Error('ZCode Desktop pairing timeout'); };
  return f;
}

test('persisted model rejection closes cancellation with Desktop offline and no connection, preserving native history', async () => {
  const f = offlineFixture(), bytes = fs.readFileSync(files(f.task).journal);
  const result = await reconcileCancellation(f.task, f.dependencies);
  assert.equal(result.status, 'cancelled'); assert.deepEqual(f.calls, []);
  assert.equal(result.cancellation.evidence.source, 'persisted-command-ack');
  assert.equal(result.cancellation.evidence.reason, 'original_command_not_admitted');
  assert.match(result.cancellation.evidence.scope, /session-wide quiescence not asserted/);
  assert.deepEqual(fs.readFileSync(files(f.task).journal), bytes);
  assert.doesNotThrow(() => assertSingleActive({ id: 'next-cbc-task', stateDir: f.task.stateDir }));
  await reconcileCancellation({ ...result, status: 'cancel_pending' }, f.dependencies);
  assert.equal(loadTask(f.task.id).history.length, 1);
});

test('missing, accepted, unknown, mismatched or incomplete acknowledgements never bypass offline reconciliation', async () => {
  for (const mutate of [j => { j.ack = null; }, j => { j.ack.status = 'accepted'; },
    j => { j.ack.status = 'unknown'; }, j => { j.ack.commandId = 'other'; },
    j => { j.ack.result = { accepted: true }; }, j => { delete j.ack.revisionAtDecision; },
    j => { j.timestamp = 'invalid'; }, j => { j.ack.reasonCode = 'runtimeFailure'; },
    j => { j.status = 'sending'; }]) {
    const f = offlineFixture(); mutate(f.journal); writeJsonAtomic(files(f.task).journal, f.journal);
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
  }
});

test('uncertain submission, active observer, worker or conflicting execution evidence refuses offline cancellation', async () => {
  for (const variant of ['submission', 'watcher', 'worker', 'working', 'seen', 'terminal', 'phase', 'binding']) {
    const f = offlineFixture();
    if (variant === 'submission') f.task.submission.status = 'uncertain';
    if (variant === 'watcher') f.task.watcherPid = process.pid;
    const state = { taskId: f.task.id, round: f.task.round, sessionId: f.task.workerSessionId,
      commandId: f.journal.envelope.commandId, paneId: f.task.paneId, terminalId: f.task.terminalId, state: 'blocked' };
    if (variant === 'worker') state.workerPid = process.pid;
    if (variant === 'working') state.state = 'working';
    if (variant === 'binding') state.commandId = 'other-command';
    if (['seen', 'terminal'].includes(variant)) state.result = { [variant]: true };
    if (variant === 'phase') state.phase = 'running';
    saveTask(f.task); writeJsonAtomic(path.join(path.dirname(files(f.task).journal), 'zcode-state.json'), state);
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending', variant);
    assert.deepEqual(f.calls, [], variant);
  }
});

test('a conservative old unconfirmed projection is not positive execution evidence against a native rejection', async () => {
  const f = offlineFixture();
  const state = { taskId: f.task.id, round: f.task.round, sessionId: f.task.workerSessionId,
    commandId: f.journal.envelope.commandId, paneId: f.task.paneId, terminalId: f.task.terminalId,
    state: 'blocked', reason: 'startup_failed', originalExecutionMayContinue: true, workerPid: 99999991 };
  writeJsonAtomic(path.join(path.dirname(files(f.task).journal), 'zcode-state.json'), state);
  writeJsonAtomic(path.join(path.dirname(files(f.task).journal), 'round-001-zcode-observation.json'),
    { ...state, phase: 'draft', result: { seen: false, terminal: false, evidence: 'history-unconfirmed' } });
  assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancelled');
  assert.deepEqual(f.calls, []);
});

test('another lease owner or unresolved task on the same native session blocks offline cancellation', async () => {
  for (const variant of ['lease', 'task']) {
    const f = offlineFixture(), other = { ...f.task, id: 'other-task', status: 'running' };
    if (variant === 'lease') writeLease(other); else saveTask(other);
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
    assert.deepEqual(f.calls, []);
  }
});

test('actual recover CLI releases the serial gate from persisted rejection with zero Relay, TUI or model operations', () => {
  const f = offlineFixture(), transport = path.join(f.task.stateDir, 'transport.json');
  writeJsonAtomic(transport, { connectionError: 'ZCode Desktop pairing timeout', calls: [] });
  const before = fs.readFileSync(files(f.task).journal);
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-readiness-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id], { env: { ...process.env,
      AGENT_BRIDGE_STATE_DIR: f.task.stateDir, ZCODE_READY_TEST_STATE: transport }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(loadTask(f.task.id).status, 'cancelled');
  assert.deepEqual(JSON.parse(fs.readFileSync(transport)).calls, []);
  assert.deepEqual(fs.readFileSync(files(f.task).journal), before);
  assert.doesNotThrow(() => assertSingleActive({ id: 'new-cbc-task', stateDir: f.task.stateDir }));
});
