'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { saveTask, loadTask } = require('../lib/util');
const { writeWorkerPolicy, normalizeTaskSpec } = require('../lib/worker-policy');
const { recordContext, contextPath, tryReuseContext, preparePromptContext, listContexts } = require('../lib/worker-context');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-terminal-context-'));
let count = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dir = path.join(root, 'case-' + ++count); fs.mkdirSync(dir); process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const source = { id: 'old-cbc-task', agent: 'cbc', stateDir: dir, cwd: dir, workerKey: 'input-sim',
    herdrSession: 'stub', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p2', terminalId: 'original-terminal',
    workerSessionId: 'original-native-session', status: 'review_pending', round: 1, history: [],
    submission: { status: 'observed' }, skipPermissions: false, permissionMode: 'acceptEdits', model: null, effort: null,
    taskSpec: normalizeTaskSpec({ goal: 'Fixture work', background: 'Fixture project', inputs: [{ path: 'README.md', purpose: 'Fixture contract' }],
      allowedChanges: ['result.txt'], requirements: ['Use original context'], acceptance: [{ command: 'node verify.cjs', expected: 'exit 0' }], deliverables: ['result.txt'] }) };
  writeWorkerPolicy(source); saveTask(source); recordContext(source);
  source.status = 'cancelled'; source.watcherPid = null; saveTask(source);
  const next = { ...source, id: 'new-cbc-task', status: 'created', round: 0, history: [], submission: null,
    placement: { mode: 'tab', workspaceId: 'w1' } };
  delete next.workerSessionId;
  const calls = [];
  const options = { inspect: () => ({ agent: 'codebuddy', agent_status: 'idle', terminal_id: source.terminalId }),
    attest: () => ({ sessionId: source.workerSessionId }),
    call: (_session, args) => { calls.push(args); return args[0] === 'agent' && args[1] === 'list' ? { result: { agents: [] } } : {}; } };
  return { source, next, options, calls, sourceBytes: fs.readFileSync(path.join(dir, 'tasks', source.id, 'task.json')) };
}

test('actual cancelled task overrides a stale review_pending ledger for CBC identity reuse only', () => {
  const f = fixture(); const ledgerBytes = fs.readFileSync(contextPath(f.source));
  assert.equal(JSON.parse(ledgerBytes).lastStatus, 'review_pending');
  assert.equal(listContexts(f.source.cwd, 'cbc', 'input-sim')[0].actualTaskStatus, 'cancelled');
  assert.equal(tryReuseContext(f.next, f.options), true);
  assert.equal(f.next.workerSessionId, f.source.workerSessionId); assert.equal(f.next.reusedTerminalStatus, 'cancelled');
  preparePromptContext(f.next, 'Next bounded task'); assert.equal(f.next.promptContext.mode, 'full');
  assert.deepEqual(fs.readFileSync(path.join(f.source.stateDir, 'tasks', f.source.id, 'task.json')), f.sourceBytes);
  assert.deepEqual(fs.readFileSync(contextPath(f.source)), ledgerBytes);
  assert.equal(loadTask(f.source.id).status, 'cancelled');
});

test('explicit resume-task uses the captured session even when the context ledger is absent', () => {
  const f = fixture(); fs.unlinkSync(contextPath(f.source)); f.next.resumeFromTaskId = f.source.id;
  assert.equal(tryReuseContext(f.next, f.options), true);
  assert.equal(f.next.workerSessionId, f.source.workerSessionId); assert.equal(f.next.forceFullContext, true);
});

test('a closed Pane plans native resume and never substitutes a fresh session', () => {
  const f = fixture(); f.next.resumeFromTaskId = f.source.id;
  f.options.inspect = () => { const error = new Error('closed Pane'); error.herdrCode = 'pane_not_found'; throw error; };
  assert.equal(tryReuseContext(f.next, f.options), false);
  assert.equal(f.next.resumeContextSessionId, f.source.workerSessionId);
  assert.equal(f.next.workerSessionId, f.source.workerSessionId); assert.equal(f.next.forceFullContext, true);
  assert.equal(loadTask(f.source.id).status, 'cancelled');
});

test('strict continuation refuses non-terminal source tasks without UI writes or accepted fabrication', () => {
  for (const status of ['running', 'review_pending', 'blocked', 'cancel_pending', 'submission_unknown', 'failed']) {
    const f = fixture(); f.source.status = status; saveTask(f.source); f.next.resumeFromTaskId = f.source.id;
    assert.throws(() => tryReuseContext(f.next, f.options), /source task is not accepted or cancelled/);
    assert.equal(loadTask(f.source.id).status, status); assert.equal(f.calls.length, 0);
  }
});

test('project, key, session ID, live terminal and watcher checks remain strict', () => {
  for (const mutate of [
    f => { f.source.cwd = path.join(f.source.cwd, 'other'); saveTask(f.source); },
    f => { f.next.workerKey = 'other-key'; },
    f => { delete f.source.workerSessionId; saveTask(f.source); },
    f => { f.source.watcherPid = process.pid; saveTask(f.source); },
    f => { f.options.attest = () => ({ sessionId: 'wrong-native' }); },
    f => { f.options.inspect = () => ({ agent: 'codebuddy', agent_status: 'idle', terminal_id: 'wrong-terminal' }); },
    f => { f.options.inspect = () => ({ agent: 'codebuddy', agent_status: 'working', terminal_id: f.source.terminalId }); },
  ]) {
    const f = fixture(); f.next.resumeFromTaskId = f.source.id; mutate(f);
    assert.throws(() => tryReuseContext(f.next, f.options));
    assert.equal(loadTask(f.source.id).status, 'cancelled');
  }
});

test('policy, permissions and explicit model mismatch do not silently fall back to a new session', () => {
  for (const mutate of [
    f => { f.source.workerPolicyVersion = 'old-policy'; saveTask(f.source); },
    f => { f.source.workerPolicySha256 = 'wrong'; saveTask(f.source); },
    f => { f.next.skipPermissions = true; },
    f => { f.next.model = 'different-model'; },
  ]) {
    const f = fixture(); f.next.resumeFromTaskId = f.source.id; mutate(f);
    assert.throws(() => tryReuseContext(f.next, f.options), /no new session created/);
    assert.equal(f.next.resumeContextSessionId, undefined);
  }
});

test('another unresolved native owner and a moved live terminal block continuation', () => {
  const f = fixture(); f.next.resumeFromTaskId = f.source.id;
  saveTask({ ...f.source, id: 'other-cbc-owner', status: 'blocked', workerKey: 'other' });
  assert.throws(() => tryReuseContext(f.next, f.options), /another unresolved owner/);
  const g = fixture(); g.next.resumeFromTaskId = g.source.id;
  g.options.inspect = () => { const error = new Error('closed Pane'); error.herdrCode = 'pane_not_found'; throw error; };
  g.options.call = () => ({ result: { agents: [{ terminal_id: g.source.terminalId }] } });
  assert.throws(() => tryReuseContext(g.next, g.options), /still present/);
});

test('explicit original-session mode does not apply to ZCode or explicit new-session requests', () => {
  const f = fixture(); f.next.resumeFromTaskId = f.source.id;
  assert.throws(() => tryReuseContext(f.next, { ...f.options, fresh: true }), /cannot be combined/);
  f.next.agent = 'zcode';
  assert.throws(() => tryReuseContext(f.next, f.options), /requires CBC/);
});

test('actual dispatch CLI carries resume-task through the original live CBC binding with exactly one submission', () => {
  const f = fixture(), transport = path.join(f.source.stateDir, 'transport.json'), specFile = path.join(f.source.stateDir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(f.source.taskSpec));
  fs.writeFileSync(path.join(f.source.stateDir, 'hook-events.ndjson'), JSON.stringify({ herdrSession: 'stub', paneId: f.source.paneId,
    sessionId: f.source.workerSessionId, taskId: f.source.id, timestamp: new Date().toISOString() }) + '\n');
  fs.writeFileSync(transport, JSON.stringify({ agent: f.options.inspect(), calls: [], submissions: 0 }));
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/cbc-terminal-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), 'dispatch', '--agent', 'cbc', '--task-id', f.next.id,
    '--cwd', f.source.cwd, '--session', 'stub', '--workspace', 'w1', '--worker-key', 'input-sim',
    '--resume-task', f.source.id, '--spec-file', specFile, '--no-skip-permissions', '--codex-thread', 'fixture-thread'],
  { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.source.stateDir, CBC_TERMINAL_TEST_STATE: transport },
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const next = loadTask(f.next.id), state = JSON.parse(fs.readFileSync(transport));
  assert.equal(next.workerSessionId, f.source.workerSessionId); assert.equal(next.resumeFromTaskId, f.source.id);
  assert.equal(next.promptContext.mode, 'full'); assert.equal(next.submission.status, 'observed');
  assert.equal(state.submissions, 1); assert.equal(state.calls.some(args => args[1] === 'run' || args[1] === 'create'), false);
  assert.equal(loadTask(f.source.id).status, 'cancelled');
  assert.deepEqual(fs.readFileSync(path.join(f.source.stateDir, 'tasks', f.source.id, 'task.json')), f.sourceBytes);
});
