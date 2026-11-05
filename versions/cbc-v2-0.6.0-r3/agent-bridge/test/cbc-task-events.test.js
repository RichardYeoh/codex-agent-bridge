'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const priorStateDir = process.env.AGENT_BRIDGE_STATE_DIR;
const priorUserProfile = process.env.USERPROFILE;
const priorAppData = process.env.APPDATA;
const priorLocalAppData = process.env.LOCALAPPDATA;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-task-events-test-'));
const isolatedStateDir = path.join(root, 'bridge-state');
const isolatedUserProfile = path.join(root, 'user-profile');
// The test process and each Hook child use fixture-only state and home paths. / 测试进程及每个Hook子进程只使用夹具状态目录和用户目录。
process.env.AGENT_BRIDGE_STATE_DIR = isolatedStateDir;
process.env.USERPROFILE = isolatedUserProfile;
process.env.APPDATA = path.join(isolatedUserProfile, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(isolatedUserProfile, 'AppData', 'Local');
fs.mkdirSync(isolatedStateDir, { recursive: true });
fs.mkdirSync(isolatedUserProfile, { recursive: true });

const protocol = require('../lib/protocol-v2');
const executorEvidence = require('../lib/cbc-executor-evidence');
const { leasePath, writeLease } = require('../lib/worker-lease');
const { renderSubmissionPointer } = require('../lib/worker-policy');

const HOOK_PATH = path.resolve(__dirname, '../hooks/cbc-task-events.js');
const FIXTURE_TIME = new Date(Date.now() - 5000).toISOString();
const SPEC = {
  version: 'task-spec-v1',
  goal: 'synthetic hook fixture',
  background: 'synthetic test only',
  inputs: ['input.txt'],
  allowedChanges: ['.'],
  requirements: ['record exact native evidence'],
  acceptance: [{ command: 'node fixture-check.js', expected: 'exit 0' }],
  deliverables: ['output.txt'],
};

let serial = 0;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function taskFixture({ round = 1, bound = true, terminalId } = {}) {
  const n = ++serial;
  const stateDir = path.join(isolatedStateDir, `case-${n}`);
  const taskId = `cbc-task-events-${n}`;
  const taskRoot = path.join(stateDir, 'tasks', taskId);
  const cwd = path.join(root, `project-${n}`);
  const herdrSession = `fixture-herdr-${n}`;
  const paneId = `workspace:pane-${n}`;
  const workerSessionId = `native-session-${n}`;
  const requestId = `request-${n}`;
  const promptPath = path.join(taskRoot, `round-${String(Math.max(1, round)).padStart(3, '0')}-prompt.md`);
  const deliveryPath = path.join(taskRoot, 'deliveries', `round-${String(Math.max(1, round)).padStart(3, '0')}.md`);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(deliveryPath), { recursive: true });
  fs.writeFileSync(promptPath, 'Synthetic round prompt\n', 'utf8');

  const task = {
    id: taskId,
    agent: 'cbc',
    taskProtocol: 2,
    cbcTurnProtocol: 1,
    round,
    stateDir,
    cwd,
    workerSessionId: bound ? workerSessionId : null,
    terminalId: terminalId || `terminal-${n}`,
    paneId,
    herdrSession,
    workerStartedAt: FIXTURE_TIME,
    promptPath,
    deliveryPath,
    allowedWritePaths: [cwd],
    history: [],
    status: round === 0 ? 'ready' : 'running',
    promptContext: { mode: 'full' },
    taskSpec: SPEC,
    submission: round > 0 ? { attemptId: requestId, phase: 'sending', status: 'sending' } : null,
  };
  const taskFile = path.join(taskRoot, 'task.json');
  writeJson(taskFile, task);
  writeLease(task);

  let request = null;
  if (round > 0 && bound) {
    const pointer = renderSubmissionPointer(task);
    const requestDirectory = path.join(taskRoot, `round-${String(round).padStart(3, '0')}-request-${requestId}`);
    task.layeredRequestId = requestId;
    task.layeredRequestFile = path.join(requestDirectory, 'request.json');
    task.submission = { attemptId: requestId, phase: 'sending', status: 'sending' };
    writeJson(taskFile, task);
    request = {
      schema: protocol.SCHEMA,
      taskId,
      round,
      requestId,
      specSha256: protocol.digest(task.taskSpec),
      promptSha256: protocol.sha(fs.readFileSync(promptPath)),
      pointerSha256: protocol.sha(Buffer.from(pointer, 'utf8')),
      createdAt: FIXTURE_TIME,
      cwd: fs.realpathSync.native(cwd),
      stateDir: fs.realpathSync.native(stateDir),
      reportPath: deliveryPath,
      allowedArtifacts: [cwd],
      binding: {
        agent: 'cbc',
        sessionId: workerSessionId,
        herdrSession,
        paneId,
        terminalId: task.terminalId,
        workerStartedAt: FIXTURE_TIME,
      },
    };
    assert.equal(task.layeredRequestFile, protocol.requestDirectory(request) + path.sep + 'request.json');
  }

  return { n, stateDir, taskRoot, taskFile, task, request, cwd, workerSessionId, herdrSession, paneId };
}

function writeHerdrStub(f) {
  const stubPath = path.join(root, `herdr-stub-${f.n}.js`);
  const stubSource = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.HERDR_STUB_LOG, JSON.stringify(args) + '\\n');",
    "const command = args[0] === '--session' ? args.slice(2) : args;",
    "if (command.length !== 3 || command[0] !== 'pane' || command[1] !== 'get' || command[2] !== process.env.HERDR_PANE_ID) { process.exit(91); }",
    "process.stdout.write(JSON.stringify({ result: { pane: { pane_id: process.env.HERDR_PANE_ID, terminal_id: process.env.HERDR_TEST_TERMINAL_ID } } }));",
  ].join('\n');
  fs.writeFileSync(stubPath, stubSource, 'utf8');
  return stubPath;
}

function herdrCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function childEnvironment(f, { terminalId = f.task.terminalId } = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('HERDR_')) delete env[name];
  const stubPath = writeHerdrStub(f);
  const stubLog = path.join(root, `herdr-calls-${f.n}.jsonl`);
  return {
    env: {
      ...env,
      USERPROFILE: path.join(root, `home-${f.n}`),
      APPDATA: path.join(root, `home-${f.n}`, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(root, `home-${f.n}`, 'AppData', 'Local'),
      AGENT_BRIDGE_STATE_DIR: f.stateDir,
      HERDR_ENV: '1',
      HERDR_PANE_ID: f.paneId,
      HERDR_BIN_PATH: stubPath,
      HERDR_STUB_LOG: stubLog,
      HERDR_TEST_TERMINAL_ID: terminalId,
      AGENT_BRIDGE_HERDR_SESSION: f.herdrSession,
    },
    stubLog,
  };
}

function runHook(f, raw, options) {
  const child = childEnvironment(f, options);
  fs.mkdirSync(child.env.USERPROFILE, { recursive: true });
  fs.mkdirSync(child.env.APPDATA, { recursive: true });
  fs.mkdirSync(child.env.LOCALAPPDATA, { recursive: true });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(raw),
    encoding: 'utf8',
    env: child.env,
    timeout: 10000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'The hook must not emit allow/deny or other stdout content');
  assert.doesNotMatch(result.stderr || '', /\b(?:allow|deny)\b/i);
  return { ...result, stubLog: child.stubLog, calls: herdrCalls(child.stubLog) };
}

function assertReadOnlyHerdr(calls) {
  assert.ok(calls.length > 0, 'The local Herdr stub should observe pane get');
  assertNoHerdrMutator(calls);
}

function assertNoHerdrMutator(calls) {
  for (const args of calls) {
    const command = args[0] === '--session' ? args.slice(2) : args;
    assert.deepEqual(command.slice(0, 2), ['pane', 'get']);
    assert.ok(!command.includes('report-agent'));
    assert.ok(!command.includes('release-agent'));
  }
}

function hookEvent(name, f, overrides = {}) {
  return {
    hook_event_name: name,
    source: 'fixture',
    session_id: f.workerSessionId,
    ...overrides,
  };
}

async function protocolFixture(options = {}) {
  const f = taskFixture(options);
  await protocol.create(f.request);
  const nativeDir = path.join(root, `home-${f.n}`, '.codebuddy', 'projects', 'fixture');
  fs.mkdirSync(nativeDir, { recursive: true });
  f.nativePath = path.join(nativeDir, `${f.workerSessionId}.jsonl`);
  f.pointer = renderSubmissionPointer(f.task);
  f.nativeRow = {
    id: `native-input-${f.n}`,
    type: 'message',
    role: 'user',
    timestamp: new Date().toISOString(),
    cwd: f.cwd,
    sessionId: f.workerSessionId,
    content: [{ type: 'input_text', text: f.pointer }],
  };
  fs.writeFileSync(f.nativePath, '', 'utf8');
  return f;
}

function persistNativeRow(f) {
  fs.appendFileSync(f.nativePath, JSON.stringify(f.nativeRow) + '\n', 'utf8');
}

test('round-zero SessionStart binds the first native session in the lease only', () => {
  const f = taskFixture({ round: 0, bound: false });
  const beforeTask = fs.readFileSync(f.taskFile);
  const run = runHook(f, hookEvent('SessionStart', f, { source: 'startup' }));
  const leaseFile = leasePath(f.stateDir, f.herdrSession, f.paneId);
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));

  assert.equal(lease.workerSessionId, f.workerSessionId);
  assert.equal(lease.taskId, f.task.id);
  assert.deepEqual(fs.readFileSync(f.taskFile), beforeTask);
  const evidence = executorEvidence.read(f.task);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].name, 'SessionStart');
  assert.equal(evidence[0].round, 0);
  assert.equal(evidence[0].sessionId, f.workerSessionId);
  assert.equal(evidence[0].identityBound, true);
  assertReadOnlyHerdr(run.calls);
});

test('unbound human SessionStart/UserPromptSubmit writes no task evidence and calls no Herdr mutator', () => {
  const n = ++serial;
  const f = {
    n,
    stateDir: path.join(isolatedStateDir, `unbound-${n}`),
    task: { terminalId: `terminal-unbound-${n}` },
    paneId: `workspace:unbound-${n}`,
    herdrSession: `fixture-herdr-unbound-${n}`,
    workerSessionId: `human-session-${n}`,
  };
  fs.mkdirSync(f.stateDir, { recursive: true });
  const run = runHook(f, hookEvent('UserPromptSubmit', f, {
    prompt: 'ordinary human input without a task lease',
    transcript_path: path.join(root, 'nonexistent-native-transcript.jsonl'),
  }));

  assert.equal(fs.existsSync(path.join(f.stateDir, 'tasks')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'cbc-executors')), false);
  assertNoHerdrMutator(run.calls);
  assert.equal(run.calls.length, 0);
});

test('matching UserPromptSubmit and Stop are captured in the exact immutable request', async () => {
  const f = await protocolFixture();
  const prompt = hookEvent('UserPromptSubmit', f, {
    transcript_path: f.nativePath,
    prompt: f.pointer,
  });
  const submit = runHook(f, prompt);
  const pending = protocol.inspect(f.request);
  assert.equal(pending.transport, 'prepared');
  assert.equal(pending.execution, 'not_started');
  assert.equal(protocol.load(f.request).events.filter(item => item.kind === 'native.admitted').length, 0);
  const rawBoundary = protocol.load(f.request).events.find(item => item.kind === 'evidence.hook');
  assert.equal(rawBoundary.payload.name, 'UserPromptSubmit');
  assert.equal(Object.hasOwn(rawBoundary.payload, 'prompt'), false);
  assertReadOnlyHerdr(submit.calls);

  persistNativeRow(f);
  const progress = runHook(f, hookEvent('PreToolUse', f, { transcript_path: f.nativePath }));
  const admitted = protocol.inspect(f.request);
  assert.equal(admitted.transport, 'admitted');
  assert.equal(admitted.execution, 'running');
  assert.equal(protocol.load(f.request).events.filter(item => item.kind === 'native.admitted').length, 1);
  assertReadOnlyHerdr(progress.calls);

  const stop = runHook(f, hookEvent('Stop', f, { transcript_path: f.nativePath }));
  const stopped = protocol.inspect(f.request);
  const events = protocol.load(f.request).events;
  assert.equal(stopped.execution, 'ended');
  assert.deepEqual(events.filter(item => item.kind.startsWith('native.')).map(item => item.kind), ['native.admitted', 'native.stopped']);
  assert.ok(events.every(item => item.requestId === f.request.requestId && item.round === f.request.round));
  assert.equal(executorEvidence.read(f.task).filter(item => item.name === 'UserPromptSubmit').length, 1);
  assert.equal(executorEvidence.read(f.task).filter(item => item.name === 'PreToolUse').length, 1);
  assert.equal(executorEvidence.read(f.task).filter(item => item.name === 'Stop').length, 1);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'layered-hook-error.json')), false);
  assertReadOnlyHerdr(stop.calls);
});

test('another native session and a changed terminal are refused without task evidence', async () => {
  const otherSession = await protocolFixture();
  const sessionRun = runHook(otherSession, hookEvent('UserPromptSubmit', otherSession, {
    session_id: `unrelated-session-${otherSession.n}`,
    transcript_path: otherSession.nativePath,
    prompt: otherSession.pointer,
  }));
  assert.equal(protocol.load(otherSession.request).events.length, 0);
  assert.equal(fs.existsSync(executorEvidence.file(otherSession.task)), false);
  assertNoHerdrMutator(sessionRun.calls);

  const otherTerminal = await protocolFixture();
  const terminalRun = runHook(otherTerminal, hookEvent('UserPromptSubmit', otherTerminal, {
    transcript_path: otherTerminal.nativePath,
    prompt: otherTerminal.pointer,
  }), { terminalId: `unrelated-terminal-${otherTerminal.n}` });
  assert.equal(protocol.load(otherTerminal.request).events.length, 0);
  assert.equal(fs.existsSync(executorEvidence.file(otherTerminal.task)), false);
  assertReadOnlyHerdr(terminalRun.calls);
});

test('corrupt evidence for another executor does not block this terminal request', async () => {
  const f = await protocolFixture();
  const otherExecutor = {
    stateDir: f.stateDir,
    herdrSession: f.herdrSession,
    paneId: `other-pane-${f.n}`,
    terminalId: `other-terminal-${f.n}`,
  };
  const otherEvidenceFile = executorEvidence.file(otherExecutor);
  fs.mkdirSync(path.dirname(otherEvidenceFile), { recursive: true });
  fs.writeFileSync(otherEvidenceFile, '{corrupt evidence for a different executor', 'utf8');
  const corruptBefore = fs.readFileSync(otherEvidenceFile);

  const submit = runHook(f, hookEvent('UserPromptSubmit', f, {
    transcript_path: f.nativePath,
    prompt: f.pointer,
  }));
  persistNativeRow(f);
  const progress = runHook(f, hookEvent('PreToolUse', f, { transcript_path: f.nativePath }));
  const stop = runHook(f, hookEvent('Stop', f, { transcript_path: f.nativePath }));

  assert.equal(protocol.inspect(f.request).execution, 'ended');
  const requestEvents = protocol.load(f.request).events;
  assert.deepEqual(requestEvents.filter(item => item.kind.startsWith('native.')).map(item => item.kind), ['native.admitted', 'native.stopped']);
  assert.ok(requestEvents.every(item => item.requestId === f.request.requestId));
  assert.deepEqual(fs.readFileSync(otherEvidenceFile), corruptBefore);
  assertReadOnlyHerdr(submit.calls);
  assertReadOnlyHerdr(progress.calls);
  assertReadOnlyHerdr(stop.calls);
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
  else process.env.AGENT_BRIDGE_STATE_DIR = priorStateDir;
  if (priorUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = priorUserProfile;
  if (priorAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = priorAppData;
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = priorLocalAppData;
});
