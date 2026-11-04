'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeLease } = require('../lib/worker-lease');
const { renderSubmissionPointer } = require('../lib/worker-policy');
const reconciliation = require('../lib/cbc-reconciliation');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-cbc-reconciliation-'));
let serial = 0;
test.after(() => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture({ phase = 'stopped', delivery = true } = {}) {
  const dir = path.join(root, 'case-' + ++serial), stateDir = path.join(dir, 'state'), id = 'cbc-uncertain-case';
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const taskRoot = path.join(stateDir, 'tasks', id), cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(taskRoot, 'deliveries'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const home = path.join(dir, 'home'), transcriptRoot = path.join(home, '.codebuddy/projects');
  fs.mkdirSync(path.join(transcriptRoot, 'project'), { recursive: true });
  const native = 'native-cbc-fixture', transcript = path.join(transcriptRoot, 'project', native + '.jsonl');
  const npm = path.join(dir, 'npm'), cbcScript = path.join(npm, 'node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
  fs.mkdirSync(path.dirname(cbcScript), { recursive: true }); fs.writeFileSync(cbcScript, '');
  const shim = path.join(npm, 'cbc.cmd'); fs.writeFileSync(shim, '@CALL node "%~dp0\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*');
  const base = Date.now() - 10000, iso = delta => new Date(base + delta).toISOString();
  const task = { id, stateDir, cwd, agent: 'cbc', round: 1, status: 'submission_unknown', workerKey: 'fixture',
    herdrSession: 'fixture', paneId: 'fixture-pane', terminalId: 'fixture-terminal', workerSessionId: native,
    agentName: 'cbc', workerStartedAt: iso(-60000), workerPid: null, watcherPid: null,
    cbcBinary: shim, nodeExecutable: process.execPath,
    promptPath: path.join(taskRoot, 'round-001-prompt.md'), deliveryPath: path.join(taskRoot, 'deliveries/round-001.md'),
    submission: { status: 'uncertain', attemptId: 'attempt-fixture', file: path.join(taskRoot, 'round-001-submission-attempt-fixture.json') },
    history: [{ round: 1, status: 'submitted', timestamp: iso(0) }] };
  fs.writeFileSync(task.promptPath, 'Frozen task brief, not a technical acceptance.');
  const attempt = { protocol: 1, attemptId: task.submission.attemptId, taskId: task.id, round: 1, agent: 'cbc',
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId, workerSessionId: native,
    promptSha256: hash(fs.readFileSync(task.promptPath)), status: 'uncertain', inputAccepted: false, createdAt: iso(0) };
  write(task.submission.file, attempt); write(path.join(taskRoot, 'task.json'), task); writeLease(task);
  const user = { id: 'native-user-fixture', type: 'message', role: 'user', sessionId: native, cwd,
    timestamp: base + 100, content: [{ type: 'input_text', text: renderSubmissionPointer(task) }] };
  fs.writeFileSync(transcript, JSON.stringify(user) + '\n');
  const hook = (name, delta) => ({ timestamp: iso(delta), name, identityBound: true, sessionId: native, taskId: id,
    round: 1, herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId });
  const hooks = [hook('UserPromptSubmit', 200), hook('PostToolUse', 300), hook(phase === 'stopped' ? 'Stop' : phase === 'blocked' ? 'Notification' : 'PreToolUse', 1000)];
  const hookFile = path.join(stateDir, 'hook-events.ndjson'); fs.writeFileSync(hookFile, hooks.map(JSON.stringify).join('\n') + '\n');
  if (delivery) { fs.writeFileSync(task.deliveryPath, 'FAIL: offline controls require rework; NOT_ESTABLISHED'); fs.utimesSync(task.deliveryPath, (base + 900) / 1000, (base + 900) / 1000); }
  const agent = { agent: 'codebuddy', name: 'cbc', pane_id: task.paneId, terminal_id: task.terminalId,
    agent_status: phase === 'stopped' ? 'idle' : phase === 'blocked' ? 'blocked' : 'working', state_change_seq: 123 };
  const pane = { pane_id: task.paneId, terminal_id: task.terminalId };
  const workerProcess = { kind: 'cbc', pid: 10002, shellPid: 10001, processStartedAt: iso(-30000) };
  const calls = []; let watchers = 0;
  const call = (_s, args) => {
    calls.push(args); const [scope, op] = args;
    const data = scope === 'agent' && op === 'get' ? { agent } : scope === 'agent' && op === 'list' ? { agents: [agent] }
      : scope === 'pane' && op === 'get' ? { pane } : scope === 'pane' && op === 'list' ? { panes: [pane] }
        : op === 'process-info' ? { process_info: { shell_pid: 10001 } } : op === 'read' ? { text: 'CBC ready' } : null;
    assert.ok(data, 'no fixture permits terminal input'); return { result: data };
  };
  return { dir, stateDir, taskRoot, task, attempt, transcript, transcriptRoot, home, user, hooks, hookFile, process: workerProcess, agent,
    pane, cbcScript, call, calls, options: { nativeTranscript: transcript, transcriptRoot },
    deps: { call, proveProcess: async () => workerProcess, startWatcher: () => { watchers++; return 90001; } },
    watchers: () => watchers, load: () => JSON.parse(fs.readFileSync(path.join(taskRoot, 'task.json'), 'utf8')) };
}

test('exact native user pointer plus bound execution/Stop proves the current failed delivery without acceptance', async () => {
  const f = fixture(), original = fs.readFileSync(f.task.submission.file), originalHistory = structuredClone(f.task.history);
  const proof = reconciliation.inspect(f.task, f.options);
  assert.equal(proof.phase, 'stopped'); assert.equal(proof.delivery.sha256, hash(fs.readFileSync(f.task.deliveryPath)));
  const result = await reconciliation.recover(f.task, f.options, f.deps);
  assert.equal(result.status, 'review_pending'); assert.equal(result.round, 1);
  assert.equal(result.submission.status, 'observed'); assert.equal(result.submission.reconciledFrom, 'uncertain');
  assert.deepEqual(result.history.slice(0, originalHistory.length), originalHistory);
  assert.deepEqual(fs.readFileSync(f.task.submission.file), original); assert.equal(f.watchers(), 0);
  assert.equal(f.calls.some(x => ['run', 'prompt', 'send-text', 'send-keys', 'stop'].includes(x[1])), false);
});

test('precise active execution attaches one local watcher; approval and missing delivery stay distinct', async () => {
  for (const phase of ['active', 'blocked', 'stopped']) {
    const f = fixture({ phase, delivery: false });
    const result = await reconciliation.recover(f.task, f.options, f.deps);
    assert.equal(result.status, phase === 'active' ? 'running' : phase === 'blocked' ? 'blocked' : 'delivery_missing');
    assert.equal(f.watchers(), phase === 'active' ? 1 : 0);
    assert.ok(f.calls.every(x => ['get', 'list', 'read', 'process-info'].includes(x[1])));
  }
});

test('an intermediate Stop followed by same-turn tool activity cannot settle a legacy round', () => {
  const f = fixture();
  const next = { ...f.hooks[2], name: 'PostToolUse', timestamp: new Date(Date.parse(f.hooks[2].timestamp) + 100).toISOString() };
  fs.appendFileSync(f.hookFile, JSON.stringify(next) + '\n');
  const proof = reconciliation.inspect(f.task, f.options);
  assert.equal(proof.phase, 'active'); assert.equal(proof.delivery, null);
});

test('a later native question cannot replace the original Stop or hide a currently busy session', async () => {
  const f = fixture();
  fs.appendFileSync(f.transcript, JSON.stringify({ ...f.user, id: 'later-question', timestamp: Date.now() - 1000,
    content: [{ type: 'input_text', text: 'Has the work finished?' }] }) + '\n');
  const proof = reconciliation.inspect(f.task, f.options);
  assert.equal(proof.hook.at, f.hooks[2].timestamp); assert.ok(proof.laterNativeInputAt);
  f.agent.agent_status = 'working';
  await assert.rejects(reconciliation.recover(f.task, f.options, f.deps), /current worker/);
  assert.equal(f.load().status, 'submission_unknown');
  f.agent.agent_status = 'idle';
  const recovered = await reconciliation.recover(f.task, f.options, f.deps);
  assert.equal(recovered.status, 'review_pending'); assert.equal(recovered.contextInvalidatedAt, proof.laterNativeInputAt);
});

test('wrong prompt/session/directory, another user input and a second uncertain attempt cannot be reconciled', async () => {
  for (const mutate of [
    f => { f.user.content[0].text += ' extra'; write(f.transcript, f.user); },
    f => { f.user.sessionId = 'other-native'; write(f.transcript, f.user); },
    f => { f.user.cwd = f.dir; write(f.transcript, f.user); },
    f => fs.appendFileSync(f.transcript, JSON.stringify({ ...f.user, id: 'foreign-user', timestamp: Date.now() }) + '\n'),
    f => fs.appendFileSync(f.task.promptPath, ' changed'),
    f => write(path.join(f.taskRoot, 'round-001-submission-other.json'), { ...f.attempt, attemptId: 'other' }),
  ]) {
    const f = fixture(); mutate(f); const before = fs.readFileSync(path.join(f.taskRoot, 'task.json'));
    await assert.rejects(reconciliation.recover(f.task, f.options, f.deps), /CBC reconciliation refused/);
    assert.deepEqual(fs.readFileSync(path.join(f.taskRoot, 'task.json')), before); assert.equal(f.watchers(), 0);
  }
});

test('old/unbound/foreign Hook and late changed report never substitute for the exact current Stop', async () => {
  for (const mutate of [
    f => { f.hooks[2].round = 0; }, f => { f.hooks[2].identityBound = false; },
    f => { f.hooks[2].sessionId = 'foreign-native'; }, f => { f.hooks.splice(0, 1); },
    f => fs.utimesSync(f.task.deliveryPath, new Date(), new Date()),
  ]) {
    const f = fixture(); mutate(f); fs.writeFileSync(f.hookFile, f.hooks.map(JSON.stringify).join('\n'));
    await assert.rejects(reconciliation.recover(f.task, f.options, f.deps), /CBC reconciliation refused/);
    assert.equal(f.load().status, 'submission_unknown');
  }
});

test('live foreign activity, approval, changed process and task race preserve uncertainty', async () => {
  for (const mutate of [
    f => { f.agent.agent_status = 'working'; }, f => { f.agent.agent_status = 'blocked'; },
    f => { f.agent.terminal_id = 'replacement-terminal'; },
    f => { f.agent.agent_session = { value: 'other-native' }; },
    f => { let reads = 0; f.deps.proveProcess = async () => ({ ...f.process, pid: ++reads === 1 ? 10002 : 10003 }); },
    f => { f.deps.proveProcess = async () => {
      const current = f.load(); current.concurrentNote = 'preserve newer metadata';
      write(path.join(f.taskRoot, 'task.json'), current); return f.process;
    }; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(reconciliation.recover(f.task, f.options, f.deps), /CBC reconciliation refused/);
    assert.equal(f.load().status, 'submission_unknown'); assert.equal(f.watchers(), 0);
  }
});

test('transcript outside native store, wrong filename or partial JSON is rejected without native access', () => {
  const f = fixture();
  assert.throws(() => reconciliation.inspect(f.task, { ...f.options, transcriptRoot: f.taskRoot }), /outside/);
  assert.throws(() => reconciliation.inspect(f.task, { ...f.options, nativeTranscript: path.join(f.dir, 'other.jsonl') }), /filename/);
  fs.appendFileSync(f.transcript, '{partial');
  assert.throws(() => reconciliation.inspect(f.task, f.options), SyntaxError);
  assert.equal(f.calls.length, 0);
});

test('real CLI read-only reconciliation then recover reaches review_pending without a single native write or replay', () => {
  const f = fixture(), transport = path.join(f.dir, 'transport.json');
  write(transport, { agent: f.agent, pane: f.pane, panes: [f.pane], visibleText: 'CBC idle',
    processInfo: { shell_pid: f.process.shellPid }, nodePid: f.process.pid, processStartedAt: f.process.processStartedAt,
    nodeExecutable: process.execPath, cbcScript: f.cbcScript, calls: [], processProofCalls: 0 });
  const run = args => spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/cbc-terminal-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), ...args], { env: { ...process.env, USERPROFILE: f.home,
    CODEX_THREAD_ID: '', AGENT_BRIDGE_STATE_DIR: f.stateDir, CBC_TERMINAL_TEST_STATE: transport },
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  const taskBefore = fs.readFileSync(path.join(f.taskRoot, 'task.json')), attemptBefore = fs.readFileSync(f.task.submission.file);
  const read = run(['reconcile-submission', f.task.id, '--cbc-transcript', f.transcript]);
  assert.equal(read.status, 0, read.stderr); assert.equal(JSON.parse(read.stdout).phase, 'stopped');
  assert.deepEqual(fs.readFileSync(path.join(f.taskRoot, 'task.json')), taskBefore);
  const recovered = run(['recover', f.task.id, '--cbc-transcript', f.transcript]);
  assert.equal(recovered.status, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout)[0].error, undefined);
  assert.equal(f.load().status, 'review_pending'); assert.deepEqual(fs.readFileSync(f.task.submission.file), attemptBefore);
  const state = JSON.parse(fs.readFileSync(transport));
  assert.ok(state.calls.every(x => ['get', 'list', 'read', 'process-info'].includes(x[1])));
  const repeat = run(['recover', f.task.id, '--cbc-transcript', f.transcript]);
  assert.equal(repeat.status, 0, repeat.stderr); assert.equal(f.load().status, 'review_pending');
});
