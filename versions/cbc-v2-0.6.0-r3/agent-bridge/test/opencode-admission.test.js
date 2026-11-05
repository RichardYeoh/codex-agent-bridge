'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshot, prepareWorker, prepareSubmission, refreshWorker, idleBelongsToRound } = require('../lib/opencode');
const { saveTask, loadTask, taskDir } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-oc-admission-'));
let counter = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dir = path.join(root, `case-${++counter}`); fs.mkdirSync(dir);
  process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'oc-admission-test', agent: 'opencode', cwd: dir, stateDir: dir,
    workerSessionId: 'ses_original', herdrSession: 'fixture', paneId: 'w1:p2', terminalId: 'terminal-original',
    agentName: 'oc', round: 0, status: 'blocked', submission: null, history: [], createdAt: '2026-11-01T00:00:00Z',
    error: 'OpenCode blocked: execution_failed', permissionMode: 'native', skipPermissions: false,
    initialPromptPath: path.join(dir, 'initial.md'), workerPolicyPath: path.join(dir, 'rules.md') };
  fs.writeFileSync(task.initialPromptPath, 'Only an isolated test task');
  fs.writeFileSync(task.workerPolicyPath, 'Stable policy / 稳定规则');
  saveTask(task); writeLease(task);
  const info = { id: task.workerSessionId, location: { directory: dir }, outcome: 'failed', time: { idle: 1000 } };
  const values = { 'session.get': info, 'session.active': {}, 'session.permission.list': [], 'session.form.list': [],
    'experimental.session.instructions.entry.list': [] };
  const calls = [], reports = [];
  const request = (op, params, body) => { calls.push({ op, params, body }); return values[op] ?? null; };
  return { task, info, values, calls, reports, request, report: (task, state) => reports.push(state) };
}

test('unsubmitted round zero attaches to an idle failed native session without rewriting its history', () => {
  const f = fixture(), original = structuredClone(f.task);
  const state = snapshot(f.task, f.request);
  assert.deepEqual(state, { state: 'idle', reason: 'previous_execution_failed', outcome: 'failed', idleAt: 1000 });
  assert.equal(idleBelongsToRound({ ...f.task, status: 'running' }, state), true);
  assert.deepEqual(f.task, original);
  assert.ok(f.calls.every(call => /^(session.get|session.active|session.permission.list|session.form.list)$/.test(call.op)));
});

test('reattachment preflight retains the original session and its failure without new model execution', () => {
  const f = fixture(); prepareWorker(f.task, 'ses_original', f.request);
  assert.equal(snapshot(f.task, f.request).reason, 'previous_execution_failed');
  assert.equal(f.info.outcome, 'failed'); assert.equal(f.task.workerSessionId, 'ses_original');
  assert.equal(f.calls.some(call => /prompt|create|interrupt|switchModel/.test(call.op)), false);
});

test('current failure or initial admission uncertainty never becomes historical readiness', () => {
  for (const mutate of [
    f => { f.task.round = 1; f.task.status = 'running'; f.task.submission = { status: 'observed' }; },
    f => { f.task.submission = { status: 'sending' }; },
    f => { f.task.status = 'submission_unknown'; },
    f => { f.task.history.push({ round: 0, status: 'submitted' }); },
    f => fs.writeFileSync(path.join(taskDir(f.task.id), 'round-001-opencode-admission.json'), '{}'),
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(snapshot(f.task, f.request).reason, 'execution_failed');
    if (f.task.round === 0) assert.throws(() => refreshWorker(f.task, { forSubmission: true }, f.request, f.report), /uncertain/);
  }
});

test('active work, approvals and forms take precedence over old failed outcomes, including the second observation', () => {
  for (const [field, value, expected] of [
    ['session.active', { ses_original: {} }, 'working'],
    ['session.permission.list', [{ id: 'approval' }], 'blocked'],
    ['session.form.list', [{ id: 'question' }], 'blocked'],
  ]) {
    const f = fixture(); f.values[field] = value;
    assert.equal(snapshot(f.task, f.request).state, expected);
    assert.throws(() => prepareSubmission(f.task, f.request), /running|user input/);
    assert.equal(f.calls.some(call => /update|put|prompt|interrupt/.test(call.op)), false);
  }
  const f = fixture(); let gets = 0;
  const request = (...args) => {
    if (args[0] === 'session.get' && ++gets === 2) f.values['session.form.list'] = [{ id: 'late-question' }];
    return f.request(...args);
  };
  assert.equal(snapshot(f.task, request).reason, 'user_input_required');
});

test('identity, directory and malformed API observations fail closed', () => {
  for (const mutate of [
    f => { f.info.id = 'ses_other'; },
    f => { f.info.location.directory = path.join(root, 'other'); },
    f => { f.values['session.active'] = null; },
    f => { f.values['session.permission.list'] = {}; },
    f => { f.values['session.form.list'] = {}; },
    f => { f.task.workerSessionId = null; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => refreshWorker(f.task, {}, f.request, f.report), /mismatch|malformed|saved session/);
    assert.equal(f.reports.length, 0);
  }
});

function admit(f) {
  f.task.round = 1; prepareSubmission(f.task, f.request);
  f.task.status = 'running'; f.task.submission = { status: 'observed' };
  f.task.history.push({ round: 1, status: 'submitted', timestamp: '2026-11-01T00:00:01Z' });
}

test('a bound pre-admission failure cannot settle or fabricate activity for the newly admitted round', () => {
  const f = fixture(); admit(f);
  const state = refreshWorker(f.task, {}, f.request, f.report);
  assert.equal(state.reason, 'previous_execution_failed');
  assert.equal(idleBelongsToRound(f.task, state), false); assert.equal(f.reports.length, 0);
  f.task.status = 'submission_unknown'; f.task.submission.status = 'uncertain';
  assert.equal(idleBelongsToRound(f.task, snapshot(f.task, f.request)), false);
  assert.throws(() => refreshWorker(f.task, { forSubmission: true }, f.request, f.report), /uncertain/);
});

test('a new native failure is still blocked and is reported with the current round', () => {
  const f = fixture(); admit(f); f.info.time.idle += 1;
  const state = refreshWorker(f.task, {}, f.request, f.report);
  assert.equal(state.reason, 'execution_failed'); assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].originalExecutionMayContinue, false);
});

test('missing failure time or mismatched baseline binding cannot suppress a current failure', () => {
  for (const mutate of [
    f => { delete f.info.time.idle; },
    f => { f.task.opencodeSubmissionBaseline.idleAt = 0; },
    ...['taskId', 'round', 'sessionId', 'cwd', 'herdrSession', 'paneId', 'terminalId'].map(key =>
      f => { f.task.opencodeSubmissionBaseline[key] = 'different'; }),
  ]) {
    const f = fixture(); admit(f); mutate(f);
    assert.equal(snapshot(f.task, f.request).reason, 'execution_failed');
  }
});

test('lease reassignment and another unresolved native-session owner prevent admission', () => {
  const f = fixture(); writeLease({ ...f.task, id: 'other-owner' });
  assert.throws(() => refreshWorker(f.task, { forSubmission: true }, f.request, f.report), /lease mismatch/);
  writeLease(f.task); saveTask({ ...f.task, id: 'other-owner', status: 'running' });
  assert.throws(() => refreshWorker(f.task, { forSubmission: true }, f.request, f.report), /another unresolved/);
  assert.equal(f.reports.length, 0);
});

function runCLI(f, { observer = false, mutate = () => {} } = {}) {
  const file = path.join(f.task.stateDir, 'transport.json');
  const transport = { task: f.task, info: f.info, active: {}, permissions: [], forms: [], calls: [],
    agent: { agent: 'opencode', name: 'oc', terminal_id: f.task.terminalId, agent_status: 'blocked', completion_seq: 7 } };
  mutate(transport); fs.writeFileSync(file, JSON.stringify(transport));
  const args = ['--require', path.join(__dirname, 'fixtures/opencode-admission-preload.cjs'),
    path.join(__dirname, observer ? '../bin/opencode-worker.js' : '../bin/agent-bridge.js'),
    ...(observer ? [f.task.workerSessionId] : ['resume', f.task.id])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 12000,
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.task.stateDir, AGENT_BRIDGE_HERDR_SESSION: f.task.herdrSession,
      HERDR_PANE_ID: f.task.paneId, AGENT_BRIDGE_TASK_ID: f.task.id, OC_ADMISSION_TEST_STATE: file,
      ...(observer ? { OC_ADMISSION_TEST_OBSERVER: '1' } : {}) } });
  return { result, transport: JSON.parse(fs.readFileSync(file)), saved: loadTask(f.task.id) };
}

test('real CLI resume with isolated transports admits the pending initial brief exactly once in the saved session', () => {
  const f = fixture(); const { result, transport, saved } = runCLI(f);
  assert.equal(result.status, 0, result.stderr); assert.equal(saved.status, 'running'); assert.equal(saved.round, 1);
  assert.equal(saved.submission.status, 'observed'); assert.equal(saved.workerSessionId, 'ses_original');
  assert.equal(saved.opencodeSubmissionBaseline.outcome, 'failed');
  const prompts = transport.calls.filter(call => call.op === 'session.prompt'); assert.equal(prompts.length, 1);
  assert.equal(prompts[0].params.sessionID, 'ses_original');
  assert.equal(transport.calls.some(call => /interrupt|create|tui.spawn/.test(call.op)), false);
  assert.equal(transport.calls.filter(call => call.op === 'watcher.start').length, 1);
});

test('real CLI initial resume denial preserves blocked round zero and sends no prompt on approvals or wrong terminal', () => {
  for (const mutate of [
    state => { state.permissions = [{ id: 'approval' }]; },
    state => { state.forms = [{ id: 'question' }]; },
    state => { state.active = { ses_original: {} }; },
    state => { state.agent.terminal_id = 'other-terminal'; },
    state => { state.info.id = 'ses_other'; },
  ]) {
    const f = fixture(); const { result, saved, transport } = runCLI(f, { mutate });
    assert.equal(result.status, 1); assert.equal(saved.status, 'blocked'); assert.equal(saved.round, 0);
    assert.equal(saved.submission, null); assert.equal(transport.calls.some(call => call.op === 'session.prompt'), false);
  }
});

test('a native occupancy race during preparation preserves round zero and the original pending brief', () => {
  const f = fixture(); const { result, saved, transport } = runCLI(f, { mutate: state => { state.occupyOnPolicyWrite = true; } });
  assert.equal(result.status, 1); assert.match(result.stderr, /changed before admission/);
  assert.equal(saved.status, 'blocked'); assert.equal(saved.round, 0); assert.equal(saved.submission, null);
  assert.equal(saved.initialPromptPath, f.task.initialPromptPath); assert.equal(saved.promptPath, undefined);
  assert.equal(saved.opencodeSubmissionBaseline, undefined);
  assert.equal(transport.calls.some(call => call.op === 'session.prompt'), false);
});

test('a lost native admission acknowledgement remains uncertain and ordinary resume never resends', () => {
  const f = fixture(); const first = runCLI(f, { mutate: state => { state.promptError = true; } });
  assert.equal(first.result.status, 1); assert.equal(first.saved.status, 'submission_unknown');
  assert.equal(first.saved.round, 1); assert.equal(first.saved.submission.status, 'uncertain');
  assert.equal(first.transport.calls.filter(call => call.op === 'session.prompt').length, 1);
  f.task = first.saved;
  const second = runCLI(f);
  assert.equal(second.result.status, 1); assert.equal(second.saved.status, 'submission_unknown');
  assert.equal(second.transport.calls.some(call => call.op === 'session.prompt'), false);
});

test('the real observer entry projects prior failure as initial readiness using fixture TUI and transports', () => {
  const f = fixture(); const { result, transport } = runCLI(f, { observer: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(transport.calls.filter(call => call.op === 'tui.spawn.fixture').length, 1);
  assert.deepEqual(transport.calls.filter(call => call.op === 'herdr.report').map(call => call.state), ['idle']);
  assert.equal(transport.calls.some(call => /prompt|interrupt|create/.test(call.op)), false);
});

test('the real observer neither settles a stale failure nor suppresses a newly failed admitted round', () => {
  for (const changed of [false, true]) {
    const f = fixture(); admit(f); saveTask(f.task); writeLease(f.task);
    if (changed) f.info.time.idle += 1;
    const { result, transport } = runCLI(f, { observer: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(transport.calls.filter(call => call.op === 'herdr.report').map(call => call.state), changed ? ['blocked'] : []);
  }
});
