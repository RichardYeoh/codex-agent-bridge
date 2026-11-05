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
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const appData = path.join(dir, 'AppData Roaming');
  const cbcShim = path.join(appData, 'npm', 'cbc.cmd');
  const cbcScript = path.join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  fs.mkdirSync(path.dirname(cbcScript), { recursive: true });
  fs.writeFileSync(cbcShim, '@CALL "%_prog%" "%~dp0\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n');
  fs.writeFileSync(cbcScript, '# isolated CBC native script target\n');
  const source = { id: 'old-cbc-task', agent: 'cbc', stateDir: dir, cwd: dir, workerKey: 'input-sim',
    herdrSession: 'stub', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p2', terminalId: 'original-terminal',
    workerSessionId: 'original-native-session', workerStartedAt: startedAt, agentName: 'cbc-old',
    status: 'review_pending', round: 1, history: [],
    submission: { status: 'observed' }, skipPermissions: false, permissionMode: 'acceptEdits', model: null, effort: null,
    taskSpec: normalizeTaskSpec({ goal: 'Fixture work', background: 'Fixture project', inputs: [{ path: 'README.md', purpose: 'Fixture contract' }],
      allowedChanges: ['result.txt'], requirements: ['Use original context'], acceptance: [{ command: 'node verify.cjs', expected: 'exit 0' }], deliverables: ['result.txt'] }) };
  writeWorkerPolicy(source); saveTask(source); recordContext(source);
  source.status = 'cancelled'; source.watcherPid = null; saveTask(source);
  const next = { ...source, id: 'new-cbc-task', status: 'created', round: 0, history: [], submission: null,
    placement: { mode: 'tab', workspaceId: 'w1' } };
  delete next.workerSessionId;
  const calls = [];
  const native = { pane_id: source.paneId, agent: 'codebuddy', name: source.agentName,
    terminal_id: source.terminalId, agent_session: { value: source.workerSessionId },
    agent_status: 'idle', completion_seq: 8 };
  const options = { inspect: () => native,
    attest: () => ({ sessionId: source.workerSessionId }),
    call: (_session, args) => { calls.push(args); return args[1] === 'list' ? { result: { agents: [], panes: [] } } : {}; } };
  return { source, next, options, calls, native, cbcShim, cbcScript, appData,
    sourceBytes: fs.readFileSync(path.join(dir, 'tasks', source.id, 'task.json')) };
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
    f => { f.options.inspect = () => { const { agent_session, ...agent } = f.native; return agent; };
      f.options.attest = () => ({ sessionId: 'wrong-native' }); },
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
  g.options.call = () => ({ result: { panes: [], agents: [{ terminal_id: g.source.terminalId }] } });
  assert.throws(() => tryReuseContext(g.next, g.options), /present/);
});

test('explicit original-session mode does not apply to ZCode or explicit new-session requests', () => {
  const f = fixture(); f.next.resumeFromTaskId = f.source.id;
  assert.throws(() => tryReuseContext(f.next, { ...f.options, fresh: true }), /cannot be combined/);
  f.next.agent = 'zcode';
  assert.throws(() => tryReuseContext(f.next, f.options), /requires CBC/);
});

for (const mode of ['working', 'fast-hook', 'rejected-then-resume', 'timeout-then-resume']) test(`actual CBC CLI with optional Herdr metadata submits once (${mode})`, () => {
  const finishImmediately = mode === 'fast-hook';
  const f = fixture(), transport = path.join(f.source.stateDir, 'transport.json'), specFile = path.join(f.source.stateDir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(f.source.taskSpec));
  const hook = { herdrSession: 'stub', paneId: f.source.paneId, terminalId: f.source.terminalId,
    sessionId: f.source.workerSessionId, taskId: f.source.id, round: f.source.round,
    name: 'Stop', source: 'stop', identityBound: true, timestamp: new Date().toISOString() };
  fs.writeFileSync(path.join(f.source.stateDir, 'hook-events.ndjson'), `${JSON.stringify(hook)}\n`);
  const shellPid = 51001;
  const processStartedAt = new Date(Date.now() - 30_000).toISOString();
  const publicAgent = { ...f.native, state_change_seq: mode === 'rejected-then-resume' ? -1 : 1200 };
  delete publicAgent.agent_session;
  delete publicAgent.completion_seq;
  fs.writeFileSync(transport, JSON.stringify({ agent: publicAgent, finishImmediately, currentTaskId: f.next.id,
    pane: { pane_id: f.source.paneId, terminal_id: f.source.terminalId, workspace_id: f.source.workspaceId },
    panes: [{ pane_id: f.source.paneId, terminal_id: f.source.terminalId, workspace_id: f.source.workspaceId }],
    processInfo: { shell_pid: shellPid, foreground_processes: [
      { pid: shellPid, name: 'pwsh.exe', creationTime: processStartedAt },
    ] },
    visibleText: 'CodeBuddy ready for the next task', nodePid: 51002, processStartedAt,
    nodeExecutable: process.execPath, cbcScript: f.cbcScript,
    calls: [], submissions: 0, paneRuns: [], processProofCalls: 0,
    processProofFailure: mode === 'timeout-then-resume' ? 'query-timeout' : null }));
  const run = args => spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/cbc-terminal-preload.cjs'),
    // Legacy fixtures must not follow the enabled V2 default. / 旧版隔离夹具不得跟随已启用的V2默认路由。
    path.join(__dirname, fs.existsSync(path.join(__dirname, '../bin/agent-bridge-v1.js'))
      ? '../bin/agent-bridge-v1.js' : '../bin/agent-bridge.js'), ...args],
  { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.source.stateDir, CBC_TERMINAL_TEST_STATE: transport,
    AGENT_BRIDGE_CBC: f.cbcShim, AGENT_BRIDGE_CBC_NATIVE: f.cbcShim },
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  let result = run(['dispatch', '--agent', 'cbc', '--task-id', f.next.id,
    '--cwd', f.source.cwd, '--session', 'stub', '--workspace', 'w1', '--worker-key', 'input-sim',
    '--resume-task', f.source.id, '--spec-file', specFile, '--no-skip-permissions', '--codex-thread', 'fixture-thread']);
  let rejected;
  if (['rejected-then-resume', 'timeout-then-resume'].includes(mode)) {
    assert.equal(result.status, 1);
    const failed = loadTask(f.next.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.round, 0);
    rejected = { file: failed.lastSubmissionRejection.file, bytes: fs.readFileSync(failed.lastSubmissionRejection.file) };
    assert.equal(JSON.parse(rejected.bytes).status, 'rejected-before-input');
    if (mode === 'timeout-then-resume') {
      for (const record of [JSON.parse(result.stderr), JSON.parse(rejected.bytes), failed.lastSubmissionRejection]) {
        assert.equal(record.guardStage, 'process-query'); assert.equal(record.processProofCode, 'query-timeout');
        assert.equal(record.preflightReadAttempts, 2);
      }
      assert.doesNotMatch(result.stderr, /private process error/);
    }
    const state = JSON.parse(fs.readFileSync(transport));
    assert.equal(state.submissions, 0);
    state.agent.state_change_seq = 1200; state.calls = []; state.processProofFailure = null;
    fs.writeFileSync(transport, JSON.stringify(state));
    result = run(['resume', f.next.id]);
  }
  assert.equal(result.status, 0, result.stderr);
  const next = loadTask(f.next.id), state = JSON.parse(fs.readFileSync(transport));
  assert.equal(next.workerSessionId, f.source.workerSessionId); assert.equal(next.resumeFromTaskId, f.source.id);
  assert.equal(next.promptContext.mode, 'full'); assert.equal(next.submission.status, 'observed');
  assert.equal(next.submission.inputReceipt.transport, 'guarded-pane');
  assert.equal(next.submission.inputReceipt.nativeAcceptanceConfirmed, false);
  assert.equal(next.submission.baselineStateChange, 1200);
  assert.equal(next.submission.baselineCompletion, 0);
  assert.equal(state.submissions, 1); assert.equal(state.paneRuns.length, 1);
  assert.equal(state.processProofCalls, mode === 'timeout-then-resume' ? 4 : 2);
  assert.equal(state.calls.filter(args => args[0] === 'pane' && args[1] === 'run').length, 1);
  assert.equal(state.calls.filter(args => args[0] === 'pane' && args[1] === 'list').length, 2);
  assert.equal(state.calls.filter(args => args[0] === 'agent' && args[1] === 'list').length, ['rejected-then-resume', 'timeout-then-resume'].includes(mode) ? 2 : 3);
  assert.equal(state.calls.filter(args => args[0] === 'pane' && args[1] === 'process-info').length, 2);
  assert.equal(state.calls.filter(args => args[0] === 'pane' && args[1] === 'read').length, 2);
  assert.equal(state.calls.some(args => args[0] === 'agent' && args[1] === 'prompt'), false);
  assert.equal(state.calls.some(args => ['create', 'start'].includes(args[1])), false);
  assert.equal(state.calls.some(args => args[0] === 'pane' && args[1] === 'send-keys'), false);
  assert.equal(loadTask(f.source.id).status, 'cancelled');
  assert.deepEqual(fs.readFileSync(path.join(f.source.stateDir, 'tasks', f.source.id, 'task.json')), f.sourceBytes);
  if (rejected) assert.deepEqual(fs.readFileSync(rejected.file), rejected.bytes);
});
