'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cancelNative } = require('../lib/cancellation');
const { cancellationState } = require('../lib/opencode');
const { getAgent } = require('../lib/agents');
const { saveTask, loadTask } = require('../lib/util');
const { assertSingleActive, taskList } = require('../lib/worker-scheduling');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cancellation-'));
let counter = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(status = 'cancel_pending') {
  const dir = path.join(root, `case-${++counter}`); fs.mkdirSync(dir);
  process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'cancel-test', agent: 'opencode', workerKey: 'original-context', round: 1, status, history: [],
    cwd: dir, stateDir: dir, workerSessionId: 'ses_original', herdrSession: 'test', paneId: 'w1:p1', terminalId: 'terminal-original' };
  saveTask(task);
  const calls = [], info = { id: task.workerSessionId, location: { directory: dir }, outcome: 'interrupted' };
  const values = { 'session.get': info, 'session.active': {}, 'session.permission.list': [], 'session.form.list': [] };
  let interrupts = 0, inspections = 0;
  const request = op => { calls.push(op); if (!(op in values)) throw new Error('Unexpected native operation'); return values[op]; };
  const worker = { id: 'opencode', cancellationState: t => cancellationState(t, request), cancelWorker: () => { interrupts++; } };
  const dependencies = { worker, inspect: () => { inspections++; throw Object.assign(new Error('closed pane'), { herdrCode: 'pane_not_found' }); } };
  return { dir, task, calls, values, info, worker, dependencies, counts: () => ({ interrupts, inspections }) };
}

test('closed Pane with two native idle observations reconciles legacy cancellation, preserving the session and releasing scheduling', async () => {
  const f = fixture(); const result = await cancelNative(f.task, { ...f.dependencies, reconcileOnly: true });
  assert.equal(result.status, 'cancelled'); assert.equal(result.workerSessionId, 'ses_original');
  assert.deepEqual(f.counts(), { interrupts: 0, inspections: 0 }); assert.equal(f.calls.length, 8);
  assert.equal(result.cancellation.phase, 'confirmed'); assert.equal(result.history.length, 1);
  assert.doesNotThrow(() => assertSingleActive({ ...f.task, id: 'next-task' }, taskList(f.dir)));
  const count = f.calls.length; await cancelNative(result, f.dependencies);
  assert.equal(f.calls.length, count); assert.equal(loadTask(f.task.id).history.length, 1);
});

test('already stopped or failed native execution can be cancelled without a Pane or another interrupt', async () => {
  for (const outcome of ['interrupted', 'failed', 'completed']) {
    const f = fixture('running'); f.info.outcome = outcome;
    assert.equal((await cancelNative(f.task, f.dependencies)).status, 'cancelled');
    assert.deepEqual(f.counts(), { interrupts: 0, inspections: 0 });
  }
});

test('active legacy cancellation remains pending on cancel/recover without interrupting newer native work', async () => {
  const f = fixture(); f.values['session.active'] = { ses_original: { type: 'running' } };
  for (const reconcileOnly of [true, false]) {
    const result = await cancelNative(loadTask(f.task.id), { ...f.dependencies, reconcileOnly });
    assert.equal(result.status, 'cancel_pending'); assert.match(result.error, /native_active/);
  }
  assert.deepEqual(f.counts(), { interrupts: 0, inspections: 0 });
  assert.throws(() => assertSingleActive({ ...f.task, id: 'next-task' }, taskList(f.dir)), /occupied/);
});

test('pending approvals/forms, unavailable API, identity mismatch and malformed observations cannot become cancelled', async () => {
  for (const variant of ['permission', 'form', 'api', 'session', 'directory', 'active-shape', 'permissions-shape']) {
    const f = fixture();
    if (variant === 'permission') f.values['session.permission.list'] = [{}];
    if (variant === 'form') f.values['session.form.list'] = [{}];
    if (variant === 'api') f.worker.cancellationState = () => { throw new Error('API unavailable'); };
    if (variant === 'session') f.info.id = 'ses_other';
    if (variant === 'directory') f.info.location.directory = root;
    if (variant === 'active-shape') f.values['session.active'] = null;
    if (variant === 'permissions-shape') f.values['session.permission.list'] = null;
    assert.equal((await cancelNative(f.task, { ...f.dependencies, reconcileOnly: true })).status, 'cancel_pending', variant);
    assert.deepEqual(f.counts(), { interrupts: 0, inspections: 0 });
  }
});

test('native activity appearing during the second idle observation prevents cancellation', () => {
  const f = fixture(); let reads = 0;
  const result = cancellationState(f.task, op => {
    if (op === 'session.active' && ++reads === 2) return { ses_original: { type: 'running' } };
    return f.values[op];
  });
  assert.equal(result.confirmed, false); assert.equal(result.reason, 'native_active');
});

test('a live owned worker interrupts once; a lost reply is reconciled without replay', async () => {
  const f = fixture('running'); f.values['session.active'] = { ses_original: {} }; let interrupts = 0;
  f.worker.cancelWorker = () => { interrupts++; f.values['session.active'] = {}; throw new Error('reply lost'); };
  const result = await cancelNative(f.task, { worker: f.worker, inspect: () => ({}), verify: () => ({}),
    lease: () => ({ taskId: f.task.id, terminalId: f.task.terminalId, workerSessionId: f.task.workerSessionId }) });
  assert.equal(result.status, 'cancelled'); assert.equal(interrupts, 1);
  assert.equal(result.cancellation.interruptAttempted, true);
});

test('an uncertain interrupt still running is never resent by repeated cancel or recover', async () => {
  const f = fixture('running'); f.values['session.active'] = { ses_original: {} }; let interrupts = 0;
  f.worker.cancelWorker = () => { interrupts++; throw new Error('reply unknown'); };
  const deps = { worker: f.worker, inspect: () => ({}), verify: () => ({}),
    lease: () => ({ taskId: f.task.id, terminalId: f.task.terminalId, workerSessionId: f.task.workerSessionId }) };
  assert.equal((await cancelNative(f.task, deps)).status, 'cancel_pending');
  assert.equal((await cancelNative(loadTask(f.task.id), deps)).status, 'cancel_pending');
  assert.equal((await cancelNative(loadTask(f.task.id), { ...deps, reconcileOnly: true })).status, 'cancel_pending');
  assert.equal(interrupts, 1);
});

test('a closed/mismatched Pane or reassigned lease cannot authorize a native interrupt', async () => {
  for (const variant of ['missing', 'identity', 'lease']) {
    const f = fixture('running'); f.values['session.active'] = { ses_original: {} };
    const deps = { ...f.dependencies };
    if (variant !== 'missing') deps.inspect = () => ({});
    if (variant === 'identity') deps.verify = () => { throw new Error('Worker identity mismatch'); };
    if (variant === 'lease') { deps.verify = () => ({}); deps.lease = () => ({ taskId: 'new-task' }); }
    assert.equal((await cancelNative(f.task, deps)).status, 'cancel_pending');
    assert.equal(f.counts().interrupts, 0);
  }
});

test('another unresolved owner of an active native session prevents an old task from interrupting it', async () => {
  const f = fixture('running'); saveTask({ ...f.task, id: 'new-task', round: 2, status: 'running' });
  f.values['session.active'] = { ses_original: { type: 'running' } };
  const result = await cancelNative(f.task, f.dependencies);
  assert.equal(result.status, 'cancel_pending'); assert.match(result.error, /another unresolved task/);
  assert.equal(f.counts().interrupts, 0); assert.equal(loadTask('new-task').status, 'running');
});

test('native idle reconciliation closes only the old cancellation and leaves a newer task/lease untouched', async () => {
  const f = fixture(); const newer = { ...f.task, id: 'new-task', round: 2, status: 'review_pending' }; saveTask(newer);
  const before = fs.readFileSync(path.join(f.dir, 'tasks/new-task/task.json'), 'utf8');
  assert.equal((await cancelNative(f.task, { ...f.dependencies, reconcileOnly: true })).status, 'cancelled');
  assert.equal(fs.readFileSync(path.join(f.dir, 'tasks/new-task/task.json'), 'utf8'), before);
  assert.deepEqual(f.counts(), { interrupts: 0, inspections: 0 });
});

test('a receipt from another round cannot authorize cancellation or overwrite unrelated metadata', async () => {
  const f = fixture(); f.task.cancellation = { binding: { taskId: f.task.id, round: 0 } }; saveTask(f.task);
  await assert.rejects(cancelNative(f.task, f.dependencies), /different task round/); assert.equal(f.calls.length, 0);
  const g = fixture(); g.worker.cancellationState = () => {
    const latest = loadTask(g.task.id); latest.auditNote = 'preserve concurrent metadata'; saveTask(latest); return { confirmed: true };
  };
  assert.equal((await cancelNative(g.task, g.dependencies)).status, 'cancelled');
  assert.equal(loadTask(g.task.id).auditNote, 'preserve concurrent metadata');
});

test('concurrent round/session changes are preserved rather than overwritten by an old cancellation result', async () => {
  const f = fixture(); f.worker.cancellationState = () => {
    saveTask({ ...loadTask(f.task.id), round: 2, workerSessionId: 'ses_new', status: 'running' }); return { confirmed: true };
  };
  await assert.rejects(cancelNative(f.task, f.dependencies), /binding changed/);
  const result = loadTask(f.task.id); assert.equal(result.round, 2); assert.equal(result.workerSessionId, 'ses_new'); assert.equal(result.status, 'running');
});

test('CLI cancel/recover reconcile a closed-Pane fixture without native interrupts or service startup', () => {
  for (const command of ['cancel', 'recover']) {
    const f = fixture();
    const cli = path.join(f.dir, 'native-api.cjs'), operations = path.join(f.dir, 'native-operations.jsonl');
    fs.writeFileSync(cli, `const fs=require('fs');const op=process.argv[3];fs.appendFileSync(process.env.CANCEL_TEST_OPERATIONS,JSON.stringify(op)+'\\n');
      const data={'session.get':{id:'ses_original',location:{directory:process.env.AGENT_BRIDGE_STATE_DIR},outcome:'failed'},
      'session.active':{},'session.permission.list':[],'session.form.list':[]};
      if(!(op in data)){process.stderr.write('Unexpected native write');process.exit(3)}process.stdout.write(JSON.stringify({data:data[op]}));`);
    const env = { ...process.env, AGENT_BRIDGE_STATE_DIR: f.dir, AGENT_BRIDGE_OPENCODE: cli,
      CANCEL_TEST_OPERATIONS: operations, HERDR_BIN_PATH: path.join(f.dir, 'must-not-start-herdr.exe') };
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/agent-bridge.js'), command, f.task.id], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(loadTask(f.task.id).status, 'cancelled');
    const calls = fs.readFileSync(operations, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 8); assert.ok(calls.every(op => /^(session.get|session.active|session.permission.list|session.form.list)$/.test(op)));
    assert.equal(loadTask(f.task.id).workerSessionId, 'ses_original');
  }
  assert.equal(getAgent('cbc').cancellationState, undefined);
});
