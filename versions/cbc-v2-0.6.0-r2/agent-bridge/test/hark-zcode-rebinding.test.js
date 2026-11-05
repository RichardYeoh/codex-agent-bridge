'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-zcode-rebind-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
const { assertRebindableObserver } = require('../lib/zcode-rebinding');
const { taskDir, writeJsonAtomic } = require('../lib/util');

function fixture() {
  const task = { id: 'hark-zcode-rebind', agent: 'zcode', herdrSession: 'stub', paneId: 'old-pane', terminalId: 'terminal',
    workerSessionId: 'native-session', round: 3, status: 'running', submission: { status: 'observed' },
    watcherPid: process.pid, observerGeneration: 4 };
  const owner = { agent: 'zcode', agent_session: { value: task.workerSessionId }, terminal_id: task.terminalId, pane_id: 'new-pane' };
  const directory = taskDir(task.id); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'zcode-state.json'), JSON.stringify({ taskId: task.id, round: task.round,
    sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
    commandId: 'native-command', state: 'working', workerPid: process.pid }));
  fs.writeFileSync(path.join(directory, 'round-003-zcode-command.json'), JSON.stringify({ envelope: {
    type: 'sendText', sessionId: task.workerSessionId, commandId: 'native-command' },
  ack: { commandId: 'native-command', status: 'accepted' } }));
  return { task, owner };
}

test('automatic watcher may rebind its own exact live ZCode observer under root lock', () => {
  const { task, owner } = fixture();
  const proof = assertRebindableObserver(task, owner, { alive: pid => pid === process.pid || pid === 9001 });
  assert.equal(proof.workerPid, process.pid);
  assert.equal(proof.paneId, owner.pane_id);
  assert.equal(proof.observerGeneration, task.observerGeneration);
});

test('public adoption cannot race another live ZCode watcher', () => {
  const { task, owner } = fixture(); task.watcherPid = 9001;
  assert.throws(() => assertRebindableObserver(task, owner, { alive: pid => pid === process.pid || pid === 9001 }), /watcher is still active/);
});

test('ZCode rebind remains limited to the original terminal and native session', () => {
  const { task, owner } = fixture();
  assert.throws(() => assertRebindableObserver(task, { ...owner, terminal_id: 'restarted-terminal' },
    { alive: pid => pid === process.pid }), /original terminal and native session/);
  assert.throws(() => assertRebindableObserver(task, { ...owner, agent_session: { value: 'other-session' } },
    { alive: pid => pid === process.pid }), /original terminal and native session/);
});

function workerFixture({ create = false, agentAbsent = false, oldWorkerPid = null, omitNativeSession = false, wrongSnapshotSession = null, freshSaved = false } = {}) {
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-zcode-worker-bind-'));
  const id = create ? 'hark-zcode-bootstrap' : 'hark-zcode-worker-bind';
  const dir = path.join(workerRoot, 'tasks', id); fs.mkdirSync(dir, { recursive: true });
  const task = { id, agent: 'zcode', stateDir: workerRoot, cwd: workerRoot, herdrSession: 'stub', paneId: 'old-pane', terminalId: 'terminal',
    round: create || freshSaved ? 0 : 1, status: create ? 'ready' : 'running', workerSessionId: create ? null : 'native-session',
    observerGeneration: 4, promptPath: path.join(dir, 'submission.txt'), promptBody: 'fixture-only' };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
  fs.writeFileSync(task.promptPath, 'fixture-only');
  if (!create && !freshSaved) fs.writeFileSync(path.join(dir, 'round-001-zcode-command.json'), JSON.stringify({
    envelope: { type: 'sendText', sessionId: task.workerSessionId, commandId: 'native-command', payload: { text: 'fixture-only' } },
    status: 'acknowledged', ack: { commandId: 'native-command', status: 'accepted' },
  }));
  writeLease(task);
  const stateFile = path.join(workerRoot, 'transport.json');
  const snapshot = require('./fixtures/zcode-snapshot.json');
  const state = { snapshot: structuredClone(snapshot), ack: { commandId: 'native-command', status: 'accepted' }, agentAbsent,
    agent: { agent: 'zcode', pane_id: task.paneId, terminal_id: task.terminalId,
      agent_session: { value: task.workerSessionId }, agent_status: 'working' },
    pane: { pane_id: task.paneId, terminal_id: task.terminalId }, calls: [], omitNativeSession, wrongSnapshotSession };
  if (omitNativeSession) delete state.agent.agent_session;
  state.snapshot.sessionId = task.workerSessionId || null;
  state.snapshot.control.activeWorks = create || freshSaved ? [] : [{ sourceCommandId: 'native-command' }];
  state.snapshot.rows.window = [];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (oldWorkerPid) writeJsonAtomic(path.join(dir, 'zcode-state.json'), { taskId: task.id, round: task.round,
    sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
    commandId: 'native-command', state: 'idle', workerPid: oldWorkerPid,
    workerProcessStartedAt: new Date(Date.now() - 1000).toISOString() });
  const child = spawn(process.execPath, [
    '--require', path.join(__dirname, 'fixtures/zcode-readiness-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), ...(task.workerSessionId ? [task.workerSessionId] : []),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    AGENT_BRIDGE_STATE_DIR: workerRoot, AGENT_BRIDGE_TASK_ID: task.id, AGENT_BRIDGE_HERDR_SESSION: 'stub',
    HERDR_PANE_ID: task.paneId, ZCODE_READY_TEST_STATE: stateFile,
    ZCODE_READY_ALLOW_CREATE: create ? '1' : '', } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  return { root: workerRoot, dir, task, stateFile, child, output: () => output };
}

async function waitUntil(predicate, message, worker) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  const transport = worker ? JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')) : null;
  const savedTask = worker ? JSON.parse(fs.readFileSync(path.join(worker.dir, 'task.json'), 'utf8')) : null;
  throw new Error(`${message}: ${worker?.output() || ''}; exit=${worker?.child.exitCode}; task=${JSON.stringify(savedTask)}; agent=${JSON.stringify(transport?.agent)}; pane=${JSON.stringify(transport?.pane)}; calls=${JSON.stringify(transport?.calls || [])}`);
}

async function stopWorker(worker) {
  worker.child.stdin.end();
  await new Promise(resolve => { if (worker.child.exitCode !== null) return resolve(); worker.child.once('exit', resolve); });
}

test('same-process create bootstrap is authorized only by its exact acknowledged create journal', async () => {
  const worker = workerFixture({ create: true, agentAbsent: true });
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'initial create-session report did not complete', worker);
    const journal = JSON.parse(fs.readFileSync(path.join(worker.dir, 'zcode-create.json'), 'utf8'));
    assert.equal(journal.workerPid, worker.child.pid);
    assert.equal(journal.status, 'acknowledged');
    assert.equal(journal.ack.result.sessionId, 'created-fixture-session');
    const receipt = JSON.parse(fs.readFileSync(path.join(worker.dir, 'zcode-state.json'), 'utf8'));
    assert.equal(receipt.sessionId, 'created-fixture-session');
    const calls = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')).calls;
    assert.equal(calls.filter(call => call.op === 'command' && call.type === 'createSession').length, 1);
    assert.equal(calls.some(call => call.op === 'command' && call.type !== 'createSession'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test('saved-session wrapper registers only after exact lease and complete inventory prove no other owner', async () => {
  const worker = workerFixture({ agentAbsent: true });
  try {
    await waitUntil(() => worker.output().includes('zcode: working'), 'saved-session wrapper did not register');
    const receipt = JSON.parse(fs.readFileSync(path.join(worker.dir, 'zcode-state.json'), 'utf8'));
    assert.equal(receipt.sessionId, worker.task.workerSessionId);
    assert.equal(receipt.commandId, 'native-command');
    const state = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8'));
    const subscribeAt = state.calls.findIndex(call => call.op === 'subscribe');
    const registerAt = state.calls.findIndex(call => call.op === 'herdr' && call.args?.[1] === 'report-agent');
    const connectAt = state.calls.findIndex(call => call.op === 'connect');
    const inventoryCalls = state.calls.map((call, index) => ({ call, index }))
      .filter(item => item.call.op === 'herdr' && ['list'].includes(item.call.args?.[1]));
    assert.equal(inventoryCalls.length, 4);
    assert.ok(inventoryCalls.slice(0, 2).every(item => item.index < connectAt));
    assert.ok(inventoryCalls.slice(2).every(item => item.index > subscribeAt && item.index < registerAt));
    assert.ok(subscribeAt >= 0 && registerAt > subscribeAt);
    assert.equal(state.agentAbsent, false);
    assert.equal(state.calls.some(call => call.op === 'command'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test('first wrapper registration refuses an idle receipt owned by another live local worker', async () => {
  const worker = workerFixture({ agentAbsent: true, oldWorkerPid: process.pid });
  try {
    await waitUntil(() => worker.output().includes('local observer detached'), 'old live worker was not rejected', worker);
    assert.match(worker.output(), /Another live ZCode worker owns the saved local receipt/);
    const calls = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')).calls;
    assert.equal(calls.some(call => call.op === 'connect'), false);
    assert.equal(calls.some(call => call.op === 'herdr' && call.args?.[1] === 'report-agent'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test('formal same-terminal Pane adoption lets the exact live observer report the new Pane without resending', async () => {
  const worker = workerFixture();
  try {
    await waitUntil(() => worker.output().includes('zcode: working'), 'original observer did not start', worker);
    const receiptPath = path.join(worker.dir, 'zcode-state.json'), beforeBytes = fs.readFileSync(receiptPath);
    const before = JSON.parse(beforeBytes);
    const current = { ...worker.task, paneId: 'new-pane', observerGeneration: 5,
      restoredContextSessionId: worker.task.workerSessionId,
      workerLifecycle: { phase: 'adopted', previous: { paneId: worker.task.paneId, terminalId: worker.task.terminalId,
        workerSessionId: worker.task.workerSessionId } } };
    const transport = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8'));
    transport.agent.pane_id = 'new-pane'; transport.pane = { pane_id: 'new-pane', terminal_id: 'terminal' };
    fs.writeFileSync(worker.stateFile, JSON.stringify(transport));
    await waitUntil(() => worker.output().includes('waiting for the adopted task binding'), 'worker did not hold during the identity handoff', worker);
    assert.deepEqual(fs.readFileSync(receiptPath), beforeBytes);
    writeLease(current);
    writeJsonAtomic(path.join(worker.dir, 'task.json'), current);
    worker.child.stdin.write(':resume\n');
    await waitUntil(() => {
      const receipt = JSON.parse(fs.readFileSync(path.join(worker.dir, 'zcode-state.json'), 'utf8'));
      return receipt.paneId === 'new-pane' && receipt.observerRebound === true;
    }, 'rebound receipt was not written', worker);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.commandId, before.commandId);
    assert.equal(receipt.observerGeneration, 5);
    const calls = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')).calls;
    assert.equal(calls.some(call => call.op === 'command'), false);
    assert.equal(calls.filter(call => call.op === 'connect').length, 1);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test('replaced terminal retires the local observer without rewriting receipts or stopping native work', async () => {
  const worker = workerFixture();
  try {
    await waitUntil(() => worker.output().includes('zcode: working'), 'original observer did not start', worker);
    const receiptPath = path.join(worker.dir, 'zcode-state.json'), before = fs.readFileSync(receiptPath);
    const priorCalls = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')).calls.length;
    const current = { ...worker.task, paneId: 'replacement-pane', terminalId: 'replacement-terminal', observerGeneration: 5 };
    writeJsonAtomic(path.join(worker.dir, 'task.json'), current); writeLease(current);
    const transport = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8'));
    transport.agent.pane_id = 'replacement-pane'; transport.agent.terminal_id = 'replacement-terminal';
    transport.pane = { pane_id: 'replacement-pane', terminal_id: 'replacement-terminal' };
    fs.writeFileSync(worker.stateFile, JSON.stringify(transport));
    await waitUntil(() => worker.output().includes('local observer detached'), 'old observer did not detach');
    await new Promise(resolve => { if (worker.child.exitCode !== null) return resolve(); worker.child.once('exit', resolve); });
    assert.deepEqual(fs.readFileSync(receiptPath), before);
    const calls = JSON.parse(fs.readFileSync(worker.stateFile, 'utf8')).calls;
    assert.equal(calls.some(call => call.op === 'command'), false);
    assert.equal(calls.slice(priorCalls).some(call => call.op === 'herdr' && call.args?.[1] === 'report-agent'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const create of [true, false]) test('Herdr custom-source missing native ID supports exact wrapper ' + (create ? 'creation' : 'restore'), async () => {
  const worker = workerFixture({ create, agentAbsent: true, omitNativeSession: true });
  try {
    await waitUntil(() => worker.output().includes(create ? 'zcode: idle' : 'zcode: working'), 'custom wrapper failed', worker);
    const state = JSON.parse(fs.readFileSync(worker.stateFile));
    assert.equal(state.agent.agent_session?.value ?? null, null);
    assert.equal(state.calls.filter(c => c.op === 'command' && c.type === 'createSession').length, create ? 1 : 0);
    assert.equal(state.calls.some(c => c.op === 'command' && c.type !== 'createSession'), false);
    if (create) { worker.child.stdin.write(':resume\n'); await waitUntil(() => JSON.parse(fs.readFileSync(worker.stateFile)).calls.filter(c => c.op === 'subscribe').length === 2, 'second attach missing', worker); }
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});
test('missing Herdr native metadata never permits a foreign subscribed session', async () => {
  const worker = workerFixture({ agentAbsent: true, omitNativeSession: true, wrongSnapshotSession: 'foreign-native' });
  try {
    await waitUntil(() => worker.output().includes('local observer detached'), 'foreign session not refused', worker);
    const state = JSON.parse(fs.readFileSync(worker.stateFile));
    assert.equal(state.calls.some(c => c.op === 'command'), false);
    assert.equal(state.calls.some(c => c.op === 'herdr' && c.args?.[1] === 'report-agent'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});

test('failed round-zero startup resumes its already-created session without create or business command', async () => {
  const worker = workerFixture({ agentAbsent: true, omitNativeSession: true, freshSaved: true });
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'saved round-zero did not become idle', worker);
    const state = JSON.parse(fs.readFileSync(worker.stateFile));
    const receipt = JSON.parse(fs.readFileSync(path.join(worker.dir, 'zcode-state.json')));
    assert.equal(receipt.round, 0); assert.equal(receipt.sessionId, worker.task.workerSessionId);
    assert.equal(receipt.readinessProtocol, 1); assert.equal(state.calls.some(c => c.op === 'command'), false);
  } finally { await stopWorker(worker); fs.rmSync(worker.root, { recursive: true, force: true }); }
});
