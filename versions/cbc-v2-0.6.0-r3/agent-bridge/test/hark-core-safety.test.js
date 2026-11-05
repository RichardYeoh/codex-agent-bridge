'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-core-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
const herdr = require('../lib/herdr');
const { saveTask, loadTask } = require('../lib/util');
const agentRegistry = require('../lib/agents');
agentRegistry.agents['fixture-native'] = { ...agentRegistry.getAgent('cbc'), id: 'fixture-native', submitWorker: null };
let agent, calls = [], rejection, postInputError, inventoryRecords = [];
const realEnsureServer = herdr.ensureServer;
herdr.agentInfo = () => { if (agent instanceof Error) throw agent; return agent; };
herdr.ensureServer = async () => {};
herdr.api = (_session, args) => {
  calls.push(args);
  if (args[1] === 'prompt') {
    if (rejection) throw rejection;
    agent = { ...agent, agent_status: 'working' };
    if (postInputError) agent = postInputError;
  }
  return { result: { panes: inventoryRecords, agents: inventoryRecords } };
};
const bridge = require('../bin/agent-bridge');
const { assertSingleActive } = require('../lib/worker-scheduling');
const { assertWorkerAbsent, restoredOwner } = require('../lib/worker-identity');
const { ownedPanes } = require('../lib/location');
const { cancellationState } = require('../lib/pane-cancellation');
let seq = 0;
function fixture() {
  const dir = path.join(root, 'case-' + ++seq); fs.mkdirSync(dir); process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'core-task', agent: 'cbc', stateDir: dir, cwd: dir, workerKey: 'main',
    herdrSession: 'fixture', paneId: 'old-pane', terminalId: 'old-terminal', workerSessionId: 'native-one',
    round: 1, status: 'review_pending', history: [], submission: { status: 'observed' }, allowedWritePaths: ['src'] };
  agent = { agent: 'codebuddy', terminal_id: task.terminalId, agent_session: { value: task.workerSessionId }, agent_status: 'idle', completion_seq: 1 };
  calls = []; rejection = null; postInputError = null; inventoryRecords = []; saveTask(task); return task;
}
test.after(() => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });

test('independent projects progress while overlapping writes/native sessions/Relay remain fenced', () => {
  const task = fixture(), other = { ...task, id: 'old-task', status: 'cancel_pending' };
  const next = { ...task, id: 'new-task', cwd: path.join(root, 'independent'), workerKey: 'other', paneId: 'new-pane', terminalId: 'new-terminal', workerSessionId: 'native-two' };
  assert.doesNotThrow(() => assertSingleActive(next, [other]));
  for (const patch of [{ workerSessionId: other.workerSessionId }, { paneId: other.paneId },
    { allowedWritePaths: [path.join(other.cwd, 'src')] }]) assert.throws(() => assertSingleActive({ ...next, ...patch }, [other]), /resource conflict/);
  const quarantined = { ...other, status: 'abandoned', abandonment: { resourceFence: { active: true } } };
  assert.doesNotThrow(() => assertSingleActive({ ...next, cwd: task.cwd, allowedWritePaths: ['docs'] }, [quarantined]));
  assert.throws(() => assertSingleActive({ ...next, cwd: task.cwd, allowedWritePaths: ['src'] }, [quarantined]), /resource conflict/);
  assert.throws(() => assertSingleActive({ ...next, agent: 'zcode' }, [{ ...quarantined, agent: 'zcode' }]), /relay/);
});

test('native restored owner and old terminal block every reconstruction, even after Pane ID changes', () => {
  const task = fixture();
  const native = { pane_id: 'moved-pane', terminal_id: 'new-terminal', agent: 'codebuddy', agent_status: 'working', agent_session: { value: task.workerSessionId } };
  const call = (_s, args) => ({ result: args[0] === 'pane' ? { panes: [native] } : { agents: [native] } });
  assert.throws(() => assertWorkerAbsent(task, { call }), error => error.code === 'WORKER_SESSION_IN_USE');
  assert.equal(restoredOwner(task, { call }).pane_id, native.pane_id);
  assert.throws(() => restoredOwner(task, { call: (_s, args) => ({ result: args[0] === 'pane'
    ? { panes: [native] } : { agents: [{ ...native, agent_status: null }] } }) }), /unconfirmed/);
  const shell = (_s, args) => ({ result: args[0] === 'pane' ? { panes: [{ pane_id: task.paneId, terminal_id: 'restoring-shell' }] } : { agents: [] } });
  assert.throws(() => assertWorkerAbsent(task, { call: shell }), error => error.code === 'WORKER_PANE_AWAITING_RESTORE');
  assert.throws(() => assertWorkerAbsent(task, { call: () => ({}) }), /incomplete/);
});

test('resume, force resume and rework refuse a live restored owner before spawning or replaying', async () => {
  for (const command of ['resume', 'force', 'rework']) {
    const task = fixture(); task.status = command === 'rework' ? 'review_pending' : 'blocked'; saveTask(task);
    agent = Object.assign(new Error('old Pane is gone'), { herdrCode: 'pane_not_found' });
    inventoryRecords = [{ pane_id: 'new-pane', terminal_id: 'new-terminal', agent: 'codebuddy', agent_session: { value: task.workerSessionId } }];
    const options = { _: [task.id], prompt: 'minimal followup', force: command === 'force' };
    await assert.rejects(command === 'rework' ? bridge.rework(options) : bridge.resume(options), error => error.code === 'WORKER_SESSION_IN_USE');
    assert.equal(calls.some(args => ['create', 'split', 'run', 'prompt', 'send-text'].includes(args[1])), false);
    assert.equal(loadTask(task.id).status, task.status); assert.equal(loadTask(task.id).round, 1);
  }
});

test('closed CBC and AGY workers reconcile without Esc; live/restoring workers remain pending', () => {
  for (const kind of ['cbc', 'agy']) {
    const task = fixture(); task.agent = kind; saveTask(task);
    const empty = (_s, args) => ({ result: args[0] === 'pane' ? { panes: [] } : { agents: [] } });
    assert.equal(cancellationState(task, { call: empty }).confirmed, true);
    const present = (_s, args) => ({ result: args[0] === 'pane' ? { panes: [{ pane_id: task.paneId }] } : { agents: [] } });
    assert.equal(cancellationState(task, { call: present }).confirmed, false);
    task.cancellation = { previousWatcherPid: process.pid }; saveTask(task);
    assert.equal(cancellationState(task, { call: empty }).reason, 'observer_still_active');
  }
});

test('server-side input rejection preserves previous review/round; accepted input is never rolled back', async () => {
  const task = fixture(); task.agent = 'fixture-native'; saveTask(task);
  rejection = Object.assign(new Error('approval visible'), { herdrCode: 'agent_blocked' });
  await assert.rejects(bridge.submit(task, 'new work', { activityTimeoutMs: 1 }), /approval visible/);
  assert.equal(loadTask(task.id).status, 'review_pending'); assert.equal(loadTask(task.id).round, 1);
  assert.equal(loadTask(task.id).history.length, 0);
  assert.equal(calls.filter(args => args[1] === 'prompt').length, 1);
  assert.equal(calls.some(args => args[1] === 'send-text' || args[1] === 'send-keys'), false);
});

test('ordinary and force resume of unknown submission never send business input', async () => {
  const task = fixture(); task.status = 'submission_unknown'; task.submission.status = 'uncertain'; saveTask(task);
  for (const force of [false, true]) await assert.rejects(bridge.resume({ _: [task.id], force }), /remains uncertain/);
  assert.equal(calls.length, 0); assert.equal(loadTask(task.id).round, 1);
});

test('a worker identity failure after accepted input remains uncertain, never reverted to the old round', async () => {
  const task = fixture(); task.agent = 'fixture-native'; saveTask(task);
  postInputError = Object.assign(new Error('identity changed after write'), { code: 'WORKER_IDENTITY_MISMATCH' });
  await assert.rejects(bridge.submit(task, 'one pointer', { activityTimeoutMs: 100 }), /identity changed/);
  assert.equal(loadTask(task.id).status, 'submission_unknown'); assert.equal(loadTask(task.id).round, 2);
  assert.equal(calls.filter(args => args[1] === 'prompt').length, 1);
});

test('busy, timeout and malformed server probes never launch an extra server', async () => {
  for (const probe of [() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, () => ({}), () => 'busy']) {
    let starts = 0;
    await assert.rejects(realEnsureServer('fixture', { probe: () => herdr.serverRunning('fixture', { probe }), start: () => { starts++; } }));
    assert.equal(starts, 0);
  }
  assert.equal(herdr.serverRunning('fixture', { probe: () => ({ status: 'stopped' }) }), false);
});

test('CBC bridge launch pins its verified 1M settings without relying on an npm shim', () => {
  const task = fixture(), command = require('../lib/agents').getAgent('cbc').buildCommand(task, task.workerSessionId);
  assert.match(command, /--settings .*cbc-context-1m\.json/); assert.match(command, /--resume 'native-one'/);
});

test('recover preserves running and live observer on transport failure', async () => {
  const task = fixture(); task.status = 'running'; task.watcherPid = process.pid; saveTask(task);
  agent = new Error('temporary IPC disconnect');
  const actions = await bridge.recoverOne(task);
  assert.match(actions.join(' '), /running status.*retained/);
  assert.equal(loadTask(task.id).status, 'running'); assert.equal(loadTask(task.id).watcherPid, process.pid);
  assert.equal(loadTask(task.id).observationError.originalExecutionMayContinue, true);
  assert.equal(calls.length, 0);
});

test('restored Pane layout ownership follows unique native identity, never unknown or duplicate references', () => {
  const task = fixture(), records = [task];
  const pane = { pane_id: 'restored-pane', terminal_id: 'fresh-terminal', agent: 'codebuddy', agent_session: { value: task.workerSessionId } };
  assert.deepEqual([...ownedPanes(task, records, [pane])], [pane.pane_id]);
  assert.equal(ownedPanes(task, records, [pane, { ...pane, pane_id: 'duplicate' }]).size, 0);
  assert.equal(ownedPanes(task, records, [{ ...pane, agent: 'codex' }]).size, 0);
});
