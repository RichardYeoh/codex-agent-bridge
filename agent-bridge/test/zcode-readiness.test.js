'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ready = require('../lib/zcode-readiness');
const { saveTask, loadTask, writeJsonAtomic, readJson } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');
const { readExecution } = require('../lib/zcode-settlement');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-readiness-'));
let counter = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dir = path.join(root, 'case-' + ++counter); fs.mkdirSync(dir);
  process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'retry-fixture', agent: 'zcode', stateDir: dir, cwd: dir, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', workerSessionId: 'original-session', round: 1, status: 'blocked',
    model: 'GLM-5.3', effort: 'max', permissionMode: 'acceptEdits', skipPermissions: false,
    submission: { status: 'observed' }, history: [{ round: 1, status: 'submitted' }] };
  const journal = { envelope: { type: 'sendText', commandId: 'old-command', sessionId: task.workerSessionId,
    payload: { text: 'original task' } }, status: 'acknowledged',
    ack: { commandId: 'old-command', status: 'failed', reasonCode: 'modelUnavailable' } };
  saveTask(task); writeLease(task); writeJsonAtomic(ready.files(task).journal, journal);
  const snapshot = { ...structuredClone(require('./fixtures/zcode-snapshot.json')), sessionId: task.workerSessionId };
  const conversation = { snapshot }, calls = [];
  const remote = { query: async envelope => { calls.push('query'); return { results: [{
    key: { sessionId: envelope.sessionId, commandId: envelope.commandId }, result: journal.ack }] }; },
    call: async () => { calls.push('history'); return { rows: snapshot.rows.window, hasMore: false, atSeq: snapshot.seq, atLogEpoch: snapshot.logEpoch }; } };
  const agent = { agent: 'zcode', terminal_id: task.terminalId, agent_status: 'blocked', completion_seq: 2 };
  writeJsonAtomic(path.join(dir, 'tasks', task.id, 'zcode-state.json'), { ...ready.binding(task, journal),
    workerPid: process.pid, readinessProtocol: 1, state: 'blocked', timestamp: new Date().toISOString() });
  return { task, journal, snapshot, conversation, calls, remote, agent };
}

test('failed model admission with no header is independently retryable, not a successful turn', async () => {
  const f = fixture(), before = fs.readFileSync(ready.files(f.task).journal);
  const result = await ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation);
  assert.equal(result.previous.reason, 'modelUnavailable'); assert.equal(result.previous.state, 'failed');
  assert.deepEqual(f.calls, ['query']); assert.deepEqual(fs.readFileSync(ready.files(f.task).journal), before);
});

test('accepted commands require exact terminal projection; empty rows or another command cannot authorize retry', async () => {
  const f = fixture(); f.journal.ack = { commandId: 'old-command', status: 'accepted' };
  await assert.rejects(ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation), /terminal is unconfirmed/);
  f.snapshot.rows.window = [{ kind: 'turnHeader', rowId: 1, sourceCommandId: 'other', state: 'failed' }];
  await assert.rejects(ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation), /terminal is unconfirmed/);
  f.snapshot.rows.window[0].sourceCommandId = 'old-command';
  assert.equal((await ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation)).previous.state, 'failed');
});

test('unknown admission and mismatched query identity remain unconfirmed without replay', async () => {
  for (const result of ['unknown', { commandId: 'wrong', status: 'failed', reasonCode: 'modelUnavailable' }]) {
    const f = fixture(); let count = 0;
    f.remote.query = async () => { count++; return { results: [{ key: { commandId: 'old-command', sessionId: f.task.workerSessionId }, result }] }; };
    await assert.rejects(ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation), /unconfirmed/);
    assert.equal(count, 1);
  }
});

test('any active work, queue, interaction, routing, stopping or malformed snapshot rejects readiness before querying', async () => {
  for (const mutate of [
    s => { s.control.activeWorks = [{ sourceCommandId: 'foreign' }]; },
    s => { s.pendingInteractions = [{ interactionId: 'approval' }]; },
    s => { s.queue.items = [{ id: 'queued' }]; }, s => { s.control.canStop = true; },
    s => { s.control.phase = 'running'; }, s => { s.control.stopState = 'stopping'; },
    s => { s.control.apiRetry = {}; }, s => { s.workspaceHookAdmission = {}; },
    s => { s.inputRouting.mode = 'choice'; }, s => { delete s.control.activeWorks; },
    s => { s.sessionId = 'wrong'; },
  ]) {
    const f = fixture(); mutate(f.snapshot);
    await assert.rejects(ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation), /refused|mismatch/);
    assert.deepEqual(f.calls, []);
  }
});

test('native activity or epoch changes during query cannot produce a stale ready result', async () => {
  for (const mutate of [s => { s.control.activeWorks = [{ sourceCommandId: 'new' }]; },
    s => { s.logEpoch = 'new-epoch'; }]) {
    const f = fixture(); const query = f.remote.query;
    f.remote.query = async envelope => { const ack = await query(envelope); f.conversation.snapshot = structuredClone(f.snapshot); mutate(f.conversation.snapshot); return ack; };
    await assert.rejects(ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation), /refused|watermark changed/);
  }
});

test('ready projection remains the old failed outcome to execution watchers, even if a delivery exists', async () => {
  const f = fixture(); const state = { ...ready.binding(f.task, f.journal), readinessProtocol: 1,
    state: 'idle', purpose: 'submission_ready', previousExecution: { state: 'failed', reason: 'modelUnavailable' },
    readiness: await ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation) };
  writeJsonAtomic(path.join(f.task.stateDir, 'tasks', f.task.id, 'zcode-state.json'), state);
  assert.equal(readExecution(f.task).state, 'blocked'); assert.equal(readExecution(f.task).reason, 'modelUnavailable');
  delete state.readiness;
  writeJsonAtomic(path.join(f.task.stateDir, 'tasks', f.task.id, 'zcode-state.json'), state);
  assert.equal(readExecution(f.task), null);
});

test('coordinator checks session/lease/protocol/uncertainty before writing any terminal input', async () => {
  for (const mutate of [
    f => { f.task.status = 'submission_unknown'; },
    f => { f.task.submission.status = 'sending'; },
    f => writeLease({ ...f.task, terminalId: 'new-terminal' }),
    f => { f.agent.terminal_id = 'wrong'; },
    f => { const file = path.join(f.task.stateDir, 'tasks', f.task.id, 'zcode-state.json'); const s = readJson(file); delete s.readinessProtocol; writeJsonAtomic(file, s); },
  ]) {
    const f = fixture(); mutate(f); let sends = 0;
    await assert.rejects(ready.refreshWorker(f.task, { forSubmission: true }, { inspect: () => f.agent,
      send: () => { sends++; } }));
    assert.equal(sends, 0);
  }
});

test('coordinator accepts only the exact ready nonce; a lost terminal reply is not resent', async () => {
  const f = fixture(); let sends = 0;
  const proof = await ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation);
  const receipt = await ready.refreshWorker(f.task, { forSubmission: true }, { inspect: () => f.agent,
    send: () => {
      sends++;
      const request = readJson(ready.files(f.task).request);
      writeJsonAtomic(ready.files(f.task).receipt, { ...request, workerPid: process.pid, ready: true, proof });
      throw new Error('reply lost');
    } });
  assert.equal(receipt.ready, true); assert.equal(sends, 1);
});

test('stale receipts never authorize new submission', async () => {
  const f = fixture(); let clock = 0, sends = 0;
  writeJsonAtomic(ready.files(f.task).receipt, { requestId: 'old', ready: true });
  await assert.rejects(ready.refreshWorker(f.task, { forSubmission: true }, { inspect: () => f.agent,
    send: () => { sends++; }, clock: () => clock, pause: async () => { clock += 10; }, timeoutMs: 20 }), /not acknowledged/);
  assert.equal(sends, 2);
});

test('receipt identity, native proof and concurrent local binding changes are rejected', async () => {
  for (const mutate of [
    (receipt) => { receipt.workerPid++; }, (receipt) => { delete receipt.proof; },
    (receipt) => { receipt.commandSha256 = 'wrong'; },
    (_receipt, f) => { const current = loadTask(f.task.id); current.round++; saveTask(current); },
    (_receipt, f) => { const journal = readJson(ready.files(f.task).journal); journal.envelope.payload.text = 'changed'; writeJsonAtomic(ready.files(f.task).journal, journal); },
  ]) {
    const f = fixture(); const proof = await ready.verifyNativeReady(f.task, f.journal, f.remote, f.conversation);
    await assert.rejects(ready.refreshWorker(f.task, { forSubmission: true }, { inspect: () => f.agent,
      send: () => {
        const receipt = { ...readJson(ready.files(f.task).request), workerPid: process.pid, ready: true, proof };
        mutate(receipt, f); writeJsonAtomic(ready.files(f.task).receipt, receipt);
      } }));
  }
});

function startWorker(f, mutate = () => {}) {
  const stateFile = path.join(f.task.stateDir, 'transport.json'), inbox = path.join(f.task.stateDir, 'inbox.ndjson');
  const value = { snapshot: f.snapshot, ack: f.journal.ack, agent: f.agent, calls: [] }; mutate(value);
  writeJsonAtomic(stateFile, value);
  const env = { ...process.env, AGENT_BRIDGE_STATE_DIR: f.task.stateDir, AGENT_BRIDGE_TASK_ID: f.task.id,
    AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: f.task.paneId,
    ZCODE_READY_TEST_STATE: stateFile, ZCODE_READY_TEST_INBOX: inbox };
  const preload = path.join(__dirname, 'fixtures/zcode-readiness-preload.cjs');
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, '../bin/zcode-worker.js'), f.task.workerSessionId], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  return { child, env, preload, stateFile, inbox, output: () => output };
}
async function waitUntil(predicate, message) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(message);
}
async function stopWorker(worker) {
  worker.child.stdin.end();
  await new Promise(resolve => { if (worker.child.exitCode !== null) return resolve(); worker.child.once('exit', resolve); });
}

test('real worker restores a failed no-header command as rework-ready without command/create/stop or historical rewriting', async () => {
  const f = fixture(), journalBytes = fs.readFileSync(ready.files(f.task).journal), worker = startWorker(f);
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'worker did not become retry-ready: ' + worker.output());
    assert.deepEqual(fs.readFileSync(ready.files(f.task).journal), journalBytes);
    assert.equal(loadTask(f.task.id).status, 'blocked'); assert.equal(readExecution(f.task).reason, 'modelUnavailable');
    assert.equal(readJson(worker.stateFile).calls.some(call => call.op === 'command' || call.op === 'conversationRowsRangeV4'), false);
  } finally { await stopWorker(worker); }
});

test('real worker readiness refuses new external activity and deduplicates the same control request', async () => {
  const f = fixture(), worker = startWorker(f);
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'worker startup failed');
    const request = { protocol: 1, requestId: 'single-request', ...ready.binding(f.task, f.journal),
      createdAt: Date.now(), expiresAt: Date.now() + 10000 };
    writeJsonAtomic(ready.files(f.task).request, request);
    const value = readJson(worker.stateFile); value.snapshot.control.activeWorks = [{ sourceCommandId: 'foreign-command' }]; writeJsonAtomic(worker.stateFile, value);
    worker.child.stdin.write(':prepare-retry:single-request\n');
    await waitUntil(() => readJson(ready.files(f.task).receipt, null)?.requestId === request.requestId, 'request not answered');
    const denied = readJson(ready.files(f.task).receipt); assert.equal(denied.ready, false);
    const connections = readJson(worker.stateFile).calls.filter(call => call.op === 'connect').length;
    worker.child.stdin.write(':prepare-retry:single-request\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(readJson(worker.stateFile).calls.filter(call => call.op === 'connect').length, connections);
    assert.equal(readJson(worker.stateFile).calls.some(call => call.op === 'command'), false);
  } finally { await stopWorker(worker); }
});

test('busy original observer rejects readiness without another connection or stop', async () => {
  const f = fixture(); f.journal.ack = { commandId: 'old-command', status: 'accepted' };
  writeJsonAtomic(ready.files(f.task).journal, f.journal);
  const worker = startWorker(f, value => { value.snapshot.control.phase = 'running'; value.snapshot.control.canStop = true;
    value.snapshot.control.activeWorks = [{ sourceCommandId: 'old-command' }]; });
  try {
    await waitUntil(() => worker.output().includes('zcode: working'), 'observer did not start');
    const count = readJson(worker.stateFile).calls.filter(call => call.op === 'connect').length;
    writeJsonAtomic(ready.files(f.task).request, { protocol: 1, requestId: 'busy-request', ...ready.binding(f.task, f.journal),
      createdAt: Date.now(), expiresAt: Date.now() + 10000 });
    worker.child.stdin.write(':prepare-retry:busy-request\n');
    await waitUntil(() => readJson(ready.files(f.task).receipt, null)?.requestId === 'busy-request', 'busy request unanswered');
    assert.match(readJson(ready.files(f.task).receipt).reason, /worker_busy/);
    assert.equal(readJson(worker.stateFile).calls.filter(call => call.op === 'connect').length, count);
    assert.equal(readJson(worker.stateFile).calls.some(call => call.op === 'command'), false);
  } finally { await stopWorker(worker); }
});

test('a new task can reuse an accepted live worker and receives its own bound readiness receipt', async () => {
  const f = fixture(); f.task.status = 'accepted'; f.journal.ack = { commandId: 'old-command', status: 'accepted' };
  saveTask(f.task); writeJsonAtomic(ready.files(f.task).journal, f.journal);
  const worker = startWorker(f, value => {
    value.snapshot.control.phase = 'completedSuccess';
    value.snapshot.rows.window = [{ kind: 'turnHeader', rowId: 1, sourceCommandId: 'old-command', state: 'completedSuccess' }];
  });
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'accepted worker startup failed');
    const next = { ...f.task, id: 'next-task-fixture', round: 0, status: 'ready', submission: null, history: [], reusedFromTaskId: f.task.id };
    saveTask(next); writeLease(next); let input;
    const receipt = await ready.refreshWorker(next, { forSubmission: true }, { inspect: () => f.agent,
      send: (_session, args) => { if (args[1] === 'send-text') input = args[3]; else worker.child.stdin.write(input + '\n'); } });
    assert.equal(receipt.ready, true); assert.equal(receipt.taskId, next.id); assert.equal(receipt.workerPid, worker.child.pid);
    assert.equal(receipt.proof.previous, null);
    assert.equal(readJson(worker.stateFile).calls.some(call => call.op === 'command'), false);
  } finally { await stopWorker(worker); }
});

test('real CLI rework and real worker handshake preserve native context and admit only the explicit next round', async () => {
  const f = fixture(), oldBytes = fs.readFileSync(ready.files(f.task).journal), worker = startWorker(f);
  let timer, coordinator;
  try {
    await waitUntil(() => worker.output().includes('zcode: idle'), 'worker startup failed');
    const prompt = path.join(f.task.stateDir, 'approved-retry.md'); fs.writeFileSync(prompt, 'Only the approved fixture retry');
    let delivered = 0;
    timer = setInterval(() => {
      if (!fs.existsSync(worker.inbox)) return;
      const lines = fs.readFileSync(worker.inbox, 'utf8').split('\n').filter(Boolean);
      for (; delivered < lines.length; delivered++) worker.child.stdin.write(JSON.parse(lines[delivered]) + '\n');
    }, 15);
    coordinator = spawn(process.execPath, ['--require', worker.preload, path.join(__dirname, '../bin/agent-bridge.js'),
      'rework', f.task.id, '--prompt-file', prompt], { env: worker.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = ''; coordinator.stdout.on('data', data => { result += data; }); coordinator.stderr.on('data', data => { result += data; });
    await waitUntil(() => coordinator.exitCode !== null, 'CLI rework stalled: ' + result + worker.output());
    assert.equal(coordinator.exitCode, 0, result + worker.output());
    await waitUntil(() => readJson(ready.files({ ...f.task, round: 2 }).journal, null)?.status === 'terminal', 'new fixture round not observed');
    const saved = loadTask(f.task.id);
    assert.equal(saved.round, 2); assert.equal(saved.workerSessionId, f.task.workerSessionId); assert.equal(saved.paneId, f.task.paneId);
    assert.equal(saved.submission.status, 'observed'); assert.equal(saved.model, 'GLM-5.3'); assert.equal(saved.effort, 'max');
    assert.deepEqual(fs.readFileSync(ready.files(f.task).journal), oldBytes);
    const calls = readJson(worker.stateFile).calls.filter(call => call.op === 'command');
    assert.equal(calls.length, 1); assert.equal(calls[0].type, 'sendText');
    assert.ok(JSON.stringify(calls[0].modelSelection).includes('GLM-5.3'));
    assert.ok(JSON.stringify(calls[0].modelSelection).includes('max'));
  } finally {
    clearInterval(timer);
    if (coordinator && coordinator.exitCode === null) { coordinator.kill(); await new Promise(resolve => coordinator.once('exit', resolve)); }
    await stopWorker(worker);
  }
});
