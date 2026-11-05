'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { eventKey } = require('../lib/notification-control');
const { assertSingleActive } = require('../lib/worker-scheduling');
const { snapshot: opencodeSnapshot } = require('../lib/opencode');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-coordinator-recovery-'));
const cli = path.join(__dirname, '../bin/agent-bridge.js');
const preload = path.join(__dirname, 'fixtures/hark-coordinator-recovery-preload.cjs');
const modules = {
  herdr: require.resolve('../lib/herdr'),
  opencode: require.resolve('../lib/opencode'),
  codex: require.resolve('../lib/codex-client'),
  util: require.resolve('../lib/util'),
};
let serial = 0;

test.after(() => {
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(temp + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function worker(task, agent = task.agent === 'cbc' ? 'codebuddy' : task.agent) {
  return { agent, name: task.agentName || 'bridge-worker', pane_id: task.paneId, terminal_id: task.terminalId,
    workspace_id: 'workspace-fixture', tab_id: 'tab-fixture', agent_session: { value: task.workerSessionId },
    agent_status: 'idle', completion_seq: 18 };
}

function fixture({ agent = 'cbc', status = 'blocked', task: overrides = {}, herdr = {}, opencode = {}, queueItems = [] } = {}) {
  const id = `coord-recovery-${++serial}`;
  const stateDir = path.join(root, `case-${serial}`), cwd = path.join(root, `project-${serial}`);
  const taskRoot = path.join(stateDir, 'tasks', id);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const task = { id, stateDir, cwd, agent, status, herdrSession: `fixture-session-${serial}`,
    paneId: `w1:p${serial}`, terminalId: `term-${serial}`, agentName: 'bridge-worker',
    workerSessionId: `native-${serial}`, workerStartedAt: new Date(Date.now() - 5000).toISOString(),
    workerKey: 'main', allowedWritePaths: ['src'], round: 3, observerGeneration: 4,
    submission: { status: 'observed' }, history: [{ round: 3, status: 'submitted',
      timestamp: new Date(Date.now() - 4000).toISOString() }], ...overrides };
  fs.writeFileSync(path.join(taskRoot, 'task.json'), JSON.stringify(task, null, 2));
  const stateFile = path.join(stateDir, 'fixture.json');
  fs.writeFileSync(stateFile, JSON.stringify({ worker: worker(task), herdrCalls: [], opencodeCalls: [],
    lockCalls: [], reentrantLocks: [], watchersStarted: [], queueItems, ...herdr,
    opencode: { info: { id: task.workerSessionId, location: { directory: cwd }, outcome: 'success',
      time: { idle: Date.now() } }, active: {}, permissions: [], forms: [], inbox: [], messages: [], ...opencode } }));
  return { id, task, taskRoot, stateDir, stateFile, cwd };
}

function writeTask(f, task = f.task) {
  fs.writeFileSync(path.join(f.taskRoot, 'task.json'), JSON.stringify(task, null, 2));
  f.task = task;
  return task;
}

function taskFrom(f) { return JSON.parse(fs.readFileSync(path.join(f.taskRoot, 'task.json'), 'utf8')); }
function fixtureState(f) { return JSON.parse(fs.readFileSync(f.stateFile, 'utf8')); }
function writeState(f, state) { fs.writeFileSync(f.stateFile, JSON.stringify(state)); }

function launch(f, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AGENT_BRIDGE_STATE_DIR: f.stateDir,
      HARK_COORDINATION_FIXTURE: f.stateFile, HARK_COORD_HERDR_MODULE: modules.herdr,
      HARK_COORD_OPENCODE_MODULE: modules.opencode, HARK_COORD_CODEX_MODULE: modules.codex,
      HARK_COORD_UTIL_MODULE: modules.util,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${preload.replaceAll('\\', '/')}"` };
    const child = spawn(process.execPath, [cli, ...args], { cwd: path.resolve(__dirname, '..', '..'), env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}; ${stderr}`)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function writeAdmission(f, { attempt = 0, status = 'confirmed', id = `msg_bridge${String(serial).padStart(32, '0')}` } = {}) {
  const name = attempt === 0 ? 'round-003-opencode-admission.json'
    : `round-003-opencode-retry-${String(attempt).padStart(3, '0')}.json`;
  const file = path.join(f.taskRoot, name);
  fs.writeFileSync(file, JSON.stringify({ id, sessionId: f.task.workerSessionId, round: 3,
    attemptNumber: attempt, status, requestStartedAt: new Date(Date.now() - 3000).toISOString(),
    timestamp: new Date(Date.now() - 3000).toISOString(), turnFingerprint: 'fixture-fingerprint' }));
  return { id, file };
}

function writeDelivery(f, task = f.task) {
  const dir = path.join(f.taskRoot, 'deliveries'); fs.mkdirSync(dir, { recursive: true });
  task.deliveryPath = path.join(dir, 'round-003.md');
  fs.writeFileSync(task.deliveryPath, 'isolated fixture delivery');
  writeTask(f, task);
}

test('observe reattaches only a known submitted round and never sends a business prompt', async () => {
  const f = fixture({ status: 'blocked' });
  const result = await launch(f, ['observe', f.id, '--wait-timeout-ms', '7000']);
  assert.equal(result.code, 0, result.stderr);
  const current = taskFrom(f), state = fixtureState(f);
  assert.equal(current.status, 'running');
  assert.equal(current.observerGeneration, 5);
  assert.equal(current.watcherPid, 9382);
  assert.deepEqual(state.watchersStarted, [f.id]);
  assert.equal(state.herdrCalls.some(args => ['prompt', 'send-text', 'send-keys'].includes(args[1])), false);
});

test('settle refuses admitted OpenCode input that remains queued and accepts only confirmed native success', async () => {
  const f = fixture({ agent: 'opencode', status: 'blocked', task: { opencodeSubmissionBaseline: {
    taskId: 'placeholder', round: 3, sessionId: 'placeholder', cwd: 'placeholder', idleAt: Date.now() - 8000 } } });
  f.task.opencodeSubmissionBaseline = { taskId: f.id, round: 3, sessionId: f.task.workerSessionId,
    cwd: f.cwd, herdrSession: f.task.herdrSession, paneId: f.task.paneId,
    terminalId: f.task.terminalId, idleAt: Date.now() - 8000 };
  writeDelivery(f);
  const admission = writeAdmission(f);
  const state = fixtureState(f);
  state.opencode.inbox = [{ id: admission.id, type: 'user', sessionID: f.task.workerSessionId }];
  state.opencode.messages = [{ id: admission.id, type: 'user' }];
  writeState(f, state);

  const queued = await launch(f, ['settle', f.id]);
  assert.equal(queued.code, 1);
  assert.match(queued.stderr, /queued native input/);
  assert.equal(taskFrom(f).status, 'blocked');
  assert.equal(fixtureState(f).opencodeCalls.some(call => call.operation === 'session.prompt'), false);
  assert.equal(fixtureState(f).opencodeCalls.filter(call => call.operation === 'session.message.list').length, 1);

  const clear = fixtureState(f);
  clear.opencodeCalls = [];
  clear.opencode.inbox = [];
  clear.opencode.info.time.idle = Date.now();
  writeState(f, clear);
  const settled = await launch(f, ['settle', f.id]);
  assert.equal(settled.code, 0, settled.stderr);
  const current = taskFrom(f), calls = fixtureState(f).opencodeCalls;
  assert.equal(current.status, 'review_pending');
  assert.equal(current.history.at(-1).source, 'late-delivery-settle');
  assert.equal(calls.filter(call => call.operation === 'session.message.list').length, 2);
  assert.equal(calls.some(call => call.operation === 'session.prompt'), false);
});

test('adopt-restored verifies the native owner and resumes observation without input', async () => {
  const f = fixture({ status: 'blocked' });
  const owner = { ...worker(f.task), pane_id: 'w2:p9', terminal_id: 'term-restored' };
  const state = fixtureState(f);
  state.panes = [{ pane_id: owner.pane_id, terminal_id: owner.terminal_id,
    workspace_id: owner.workspace_id, tab_id: owner.tab_id }];
  state.agents = [owner];
  writeState(f, state);
  const result = await launch(f, ['adopt-restored', f.id, '--pane', owner.pane_id]);
  assert.equal(result.code, 0, result.stderr);
  const current = taskFrom(f), calls = fixtureState(f).herdrCalls;
  assert.equal(current.status, 'running');
  assert.equal(current.paneId, owner.pane_id);
  assert.equal(current.terminalId, owner.terminal_id);
  assert.equal(current.observerGeneration, 5);
  assert.equal(current.watcherPid, 9382);
  assert.equal(calls.some(args => ['prompt', 'send-text', 'send-keys'].includes(args[1])), false);
});

test('adopt-restored fails closed when a ZCode native session appears on a different terminal', async () => {
  const f = fixture({ agent: 'zcode', status: 'blocked' });
  const owner = { ...worker(f.task, 'zcode'), pane_id: 'w2:p10', terminal_id: 'term-replaced' };
  const state = fixtureState(f);
  state.panes = [{ pane_id: owner.pane_id, terminal_id: owner.terminal_id }];
  state.agents = [owner];
  writeState(f, state);
  const result = await launch(f, ['adopt-restored', f.id, '--pane', owner.pane_id]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ZCode wrapper terminal changed/);
  assert.equal(taskFrom(f).status, 'blocked');
  assert.equal(taskFrom(f).paneId, f.task.paneId);
  assert.deepEqual(fixtureState(f).watchersStarted, []);
});

test('retry-failed submits only after a confirmed newer native failure', async () => {
  const f = fixture({ agent: 'opencode', status: 'blocked', task: { opencodeSubmissionBaseline: null } });
  f.task.promptPath = path.join(f.taskRoot, 'round-003-prompt.md');
  fs.writeFileSync(f.task.promptPath, 'isolated retry specification');
  f.task.opencodeSubmissionBaseline = { taskId: f.id, round: 3, sessionId: f.task.workerSessionId,
    cwd: f.cwd, herdrSession: f.task.herdrSession, paneId: f.task.paneId,
    terminalId: f.task.terminalId, outcome: 'failed', idleAt: Date.now() - 8000 };
  writeTask(f);
  const admission = writeAdmission(f);
  const state = fixtureState(f);
  state.opencode.info.outcome = 'failed';
  state.opencode.info.time.idle = Date.now() - 1000;
  state.opencode.messages = [{ id: admission.id, type: 'user' }];
  writeState(f, state);

  const result = await launch(f, ['resume', f.id, '--retry-failed']);
  assert.equal(result.code, 0, result.stderr);
  const current = taskFrom(f), after = fixtureState(f);
  assert.equal(current.status, 'running');
  assert.equal(current.opencodeRetry.status, 'confirmed');
  assert.equal(current.opencodeRetry.attemptNumber, 1);
  assert.equal(after.opencodeCalls.filter(call => call.operation === 'session.prompt').length, 1);
  assert.deepEqual(after.watchersStarted, [f.id]);

  const previousStateDir = process.env.AGENT_BRIDGE_STATE_DIR;
  process.env.AGENT_BRIDGE_STATE_DIR = f.stateDir;
  try {
    const request = operation => {
      const native = fixtureState(f).opencode;
      if (operation === 'session.get') return native.info;
      if (operation === 'session.active') return native.active;
      if (operation === 'session.permission.list') return native.permissions;
      if (operation === 'session.form.list') return native.forms;
      throw new Error(`Unexpected isolated snapshot operation: ${operation}`);
    };
    const staleSnapshot = opencodeSnapshot(current, request);
    assert.equal(staleSnapshot.state, 'working');
    assert.equal(staleSnapshot.reason, 'awaiting_retry_execution');

    const stale = fixtureState(f);
    const retryFile = path.join(f.taskRoot, 'round-003-opencode-retry-001.json');
    const retryJournal = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
    const oldIdle = Date.now() - 120000;
    retryJournal.requestStartedAt = new Date(oldIdle + 1000).toISOString();
    stale.opencode.info.time.idle = oldIdle;
    fs.writeFileSync(retryFile, JSON.stringify(retryJournal));
    writeState(f, stale);
    const agedSnapshot = opencodeSnapshot(current, request);
    assert.equal(agedSnapshot.state, 'blocked');
    assert.equal(agedSnapshot.reason, 'retry_execution_unconfirmed');
    assert.equal(agedSnapshot.originalExecutionMayContinue, true);
  } finally {
    if (previousStateDir === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
    else process.env.AGENT_BRIDGE_STATE_DIR = previousStateDir;
  }
});

test('uncertain retry admission is not replayed by resume --retry-failed', async () => {
  const f = fixture({ agent: 'opencode', status: 'blocked' });
  const retry = writeAdmission(f, { attempt: 1, status: 'sending', id: `msg_bridge${'1'.repeat(32)}` });
  const result = await launch(f, ['resume', f.id, '--retry-failed']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Retry admission is uncertain/);
  assert.equal(taskFrom(f).status, 'blocked');
  assert.equal(fixtureState(f).opencodeCalls.some(call => call.operation === 'session.prompt'), false);
  assert.equal(JSON.parse(fs.readFileSync(retry.file, 'utf8')).status, 'sending');
});

test('recover reconciles the exact already-admitted retry ID without another prompt', async () => {
  const retryId = `msg_bridge${'2'.repeat(32)}`;
  const f = fixture({ agent: 'opencode', status: 'submission_unknown', task: {
    submission: { status: 'uncertain' }, opencodeRetry: { round: 3, attemptNumber: 1,
      admissionId: retryId, status: 'uncertain' } }, opencode: { inbox: [] } });
  writeAdmission(f);
  writeAdmission(f, { attempt: 1, status: 'sending', id: retryId });
  const state = fixtureState(f);
  state.opencode.inbox = [{ id: retryId, type: 'user', sessionID: f.task.workerSessionId }];
  writeState(f, state);

  const result = await launch(f, ['recover', f.id]);
  assert.equal(result.code, 0, result.stderr);
  const current = taskFrom(f), calls = fixtureState(f).opencodeCalls;
  assert.equal(current.status, 'running');
  assert.equal(current.submission.status, 'observed');
  assert.equal(current.opencodeRetry.status, 'confirmed');
  assert.equal(current.opencodeRetry.admissionId, retryId);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.taskRoot, 'round-003-opencode-retry-001.json'), 'utf8')).status === 'confirmed');
  assert.equal(calls.some(call => call.operation === 'session.prompt'), false);
});

test('force cannot authorize replay of an unreconciled unknown initial submission', async () => {
  const f = fixture({ agent: 'opencode', status: 'submission_unknown', task: { submission: { status: 'uncertain' } } });
  writeAdmission(f, { status: 'sending' });
  const result = await launch(f, ['resume', f.id, '--force']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /force never authorizes replay/);
  assert.equal(taskFrom(f).status, 'submission_unknown');
  assert.equal(fixtureState(f).opencodeCalls.some(call => call.operation === 'session.prompt'), false);
});

test('abandonment records evidence and keeps overlapping resources quarantined', async () => {
  const f = fixture({ status: 'blocked' });
  const evidenceFile = path.join(root, `evidence-${serial}.txt`);
  fs.writeFileSync(evidenceFile, 'isolated operator evidence');
  const result = await launch(f, ['abandon', f.id, '--reason', 'fixture unresolved execution',
    '--actor', 'fixture-operator', '--evidence-file', evidenceFile]);
  assert.equal(result.code, 0, result.stderr);
  const abandoned = taskFrom(f);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.originalExecutionMayContinue, true);
  assert.equal(abandoned.abandonment.resourceFence.active, true);
  assert.equal(abandoned.abandonment.evidence.sha256.length, 64);
  const overlap = { ...abandoned, id: `coord-next-${serial}`, workerKey: 'other',
    workerSessionId: 'other-native', herdrSession: 'other-session', paneId: 'other-pane',
    terminalId: 'other-terminal', allowedWritePaths: ['src/changed.js'] };
  assert.throws(() => assertSingleActive(overlap, [abandoned]), /resource conflict/);
  const disjoint = { ...overlap, allowedWritePaths: ['docs/only.md'] };
  assert.doesNotThrow(() => assertSingleActive(disjoint, [abandoned]));
});

test('message-retire CLI takes task and message locks once and preserves uncertainty audit', async () => {
  const f = fixture({ agent: 'agy', status: 'review_pending' });
  const messageId = 'message-uncertain';
  const dir = path.join(f.taskRoot, 'messages'); fs.mkdirSync(dir, { recursive: true });
  const message = { taskId: f.id, round: f.task.round, agent: f.task.agent,
    herdrSession: f.task.herdrSession, workerSessionId: f.task.workerSessionId,
    paneId: f.task.paneId, terminalId: f.task.terminalId, messageId, mode: 'queue', transport: 'tui',
    status: 'uncertain', deliveryUncertain: true, text: 'private fixture text', rendered: 'private fixture payload',
    marker: 'private marker', evidence: { type: 'transport_or_state_uncertain' }, history: [{ status: 'uncertain' }] };
  fs.writeFileSync(path.join(dir, `${messageId}.json`), JSON.stringify(message, null, 2));
  const result = await launch(f, ['message-retire', f.id, '--message-id', messageId,
    '--reason', 'fixture manually checked', '--evidence', 'fixture native transcript reviewed', '--actor', 'fixture-operator']);
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${messageId}.json`), 'utf8'));
  assert.equal(saved.status, 'operator-retired');
  assert.equal(saved.operatorResolution.priorStatus, 'uncertain');
  assert.equal(saved.operatorResolution.deliveryUncertain, true);
  assert.equal(saved.operatorResolution.actor, 'fixture-operator');
  assert.equal(saved.text, undefined);
  assert.equal(saved.rendered, undefined);
  const state = fixtureState(f);
  assert.equal(state.lockCalls.filter(key => key === f.id).length, 1);
  assert.equal(state.lockCalls.filter(key => key.startsWith('message-')).length, 1);
  assert.deepEqual(state.reentrantLocks, []);
});

test('ack CLI does not wrap the self-locking acknowledgment API in a second task lock', async () => {
  const f = fixture({ status: 'review_pending', task: { codexThread: `thread-fixture-${serial}`,
    settlementSeq: 3, completionSeq: 18 } });
  const key = eventKey(f.task);
  f.task.notification = { key, round: f.task.round, codexThread: f.task.codexThread, status: 'consumed' };
  writeTask(f);
  const result = await launch(f, ['ack', f.id, '--key', key]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(taskFrom(f).notification.status, 'acknowledged');
  const state = fixtureState(f);
  assert.equal(state.lockCalls.filter(value => value === f.id).length, 1);
  assert.equal(state.lockCalls.filter(value => value.startsWith('notify-')).length, 1);
  assert.deepEqual(state.reentrantLocks, []);
});
