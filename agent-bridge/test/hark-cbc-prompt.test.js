'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeLease } = require('../lib/worker-lease');
const { submit, resolveCbcExecutable, nativeCbcBinary, readSubmissionActivity } = require('../lib/cbc-prompt');
const { proveWorkerProcess, readWindowsDescendants } = require('../lib/windows-worker-process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-cbc-prompt-'));
let serial = 0;
test.after(() => {
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
});

function fixture({ status = 'idle', round = 1, hookName = 'SessionStart', hookRound = round - 1,
  hookTaskId = null, reuseSource = null } = {}) {
  const stateDir = path.join(root, `state-${++serial}`);
  const id = `cbc-prompt-${serial}`;
  const taskDir = path.join(stateDir, 'tasks', id);
  const npmRoot = path.join(root, 'AppData Roaming', `npm-${serial}`);
  const shimDir = npmRoot;
  const shimPath = path.join(shimDir, 'cbc.cmd');
  const nodeModules = path.join(npmRoot, 'node_modules');
  const scriptPath = path.join(nodeModules, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  const nodePath = path.join(root, 'Program Files', 'nodejs', 'node.exe');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(shimPath, '@CALL "%_prog%" "%~dp0\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n');
  fs.writeFileSync(scriptPath, '# isolated CodeBuddy shim target\n');
  fs.writeFileSync(nodePath, '');
  const started = new Date(Date.now() - 60_000).toISOString();
  const task = { id, agent: 'cbc', stateDir, cwd: path.join(root, 'project'), herdrSession: `hark-service-${serial}`,
    paneId: `w1:p${serial}`, terminalId: `terminal-${serial}`, workerSessionId: `native-session-${serial}`,
    cbcBinary: shimPath, nodeExecutable: nodePath,
    workerStartedAt: started, round, status: 'running', agentName: `cbc-${serial}`,
    submission: { status: 'sending', attemptId: `attempt-${serial}`, baselineCompletion: 8 },
    ...(reuseSource ? { reusedFromTaskId: reuseSource.id } : {}) };
  fs.mkdirSync(task.cwd, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task));
  writeLease(task);

  const hookTask = hookTaskId || task.id;
  const hook = { timestamp: new Date().toISOString(), name: hookName, source: 'startup',
    sessionId: task.workerSessionId, taskId: hookTask, herdrSession: task.herdrSession,
    paneId: task.paneId, terminalId: task.terminalId, round: hookRound, identityBound: true };
  fs.writeFileSync(path.join(stateDir, 'hook-events.ndjson'), `${JSON.stringify(hook)}\n`);

  const completionTime = new Date(Date.now() - 20_000).toISOString();
  const processInfo = { shell_pid: 100 + serial, foreground_processes: [
    { pid: 100 + serial, name: 'powershell.exe', creationTime: completionTime },
  ] };
  const native = { pane_id: task.paneId, agent: 'codebuddy', name: task.agentName, terminal_id: task.terminalId,
    agent_session: { value: task.workerSessionId }, agent_status: status, completion_seq: 8 };
  const pane = { pane_id: task.paneId, terminal_id: task.terminalId, workspace_id: `workspace-${serial}` };
  const commandTime = new Date(Date.now() - 30_000).toISOString();
  const nodeOne = { pid: 200 + serial, parentPid: processInfo.shell_pid, name: 'node.exe',
    executablePath: nodePath, creationTime: commandTime };
  const nodeTwo = { pid: 201 + serial, parentPid: processInfo.shell_pid, name: 'node.exe',
    executablePath: nodePath, creationTime: commandTime };
  const commandLines = new Map([
    [nodeOne.pid, { pid: nodeOne.pid, parentPid: nodeOne.parentPid, name: nodeOne.name,
      executablePath: nodePath, creationTime: commandTime,
      commandLine: `"${nodePath}" --no-warnings "${scriptPath}" --model glm --append-system-prompt "policy line one\r\npolicy line two"` }],
    [nodeTwo.pid, { pid: nodeTwo.pid, parentPid: nodeTwo.parentPid, name: nodeTwo.name,
      executablePath: nodePath, creationTime: commandTime,
      commandLine: `node "${path.join(root, 'unrelated.js')}" --prompt "${scriptPath}"` }],
  ]);
  return { task, taskDir, shimPath, scriptPath, nodePath, pane, native, processInfo, nodeOne, nodeTwo, commandLines,
    sourceTask: reuseSource };
}

function dependencies(f, overrides = {}) {
  const calls = [];
  const runs = [];
  let native = structuredClone(f.native);
  let visible = 'CodeBuddy ready for the next task';
  let tree = [f.nodeOne, f.nodeTwo];
  let commandLines = f.commandLines;
  const call = (session, args) => {
    calls.push({ session, args });
    const [scope, action] = args;
    if (scope === 'pane' && action === 'get') return { result: { pane: f.pane } };
    if (scope === 'agent' && action === 'get') return { result: { agent: native } };
    if (scope === 'pane' && action === 'list') return { result: { panes: [f.pane] } };
    if (scope === 'agent' && action === 'list') return { result: { agents: [native] } };
    if (scope === 'pane' && action === 'process-info') return { result: { process_info: f.processInfo } };
    if (scope === 'pane' && action === 'read') return { result: { text: visible } };
    if (scope === 'pane' && action === 'run') { runs.push({ session, pane: args[2], text: args[3] }); return { result: { queued: true } }; }
    throw new Error('unexpected isolated Herdr call');
  };
  return {
    calls, runs,
    setNative(value) { native = value; },
    setVisible(value) { visible = value; },
    setTree(value) { tree = value; },
    setCommandLines(value) { commandLines = value; },
    deps: {
      call, cbcBinary: f.shimPath, platform: 'win32',
      resolveCbcOptions: { nodeExecutable: f.nodePath, realpath: value => path.resolve(value) },
      readDescendants: shellPid => {
        assert.equal(shellPid, f.processInfo.shell_pid);
        return tree;
      },
      readCommandLine: pid => commandLines.get(pid),
      ...overrides,
    },
  };
}

function expectPreflight(error) {
  assert.equal(error.code, 'CBC_PROMPT_GUARD_REJECTED');
  assert.equal(error.origin, 'bridge-preflight');
  assert.equal(error.requestSent, false);
  assert.match(error.message, /no input was sent/);
  assert.equal(/policy line|native-session|CodeBuddy/.test(error.message), false);
  return true;
}

function optionalMetadataFixture({ explicitNull = false } = {}) {
  const f = fixture();
  const capture = require('./fixtures/herdr-cbc-095-metadata.json');
  f.native = { ...capture.agent.result.agent, cwd: f.task.cwd, pane_id: f.task.paneId,
    terminal_id: f.task.terminalId, name: f.task.agentName };
  f.pane = { ...capture.pane.result.pane, cwd: f.task.cwd, pane_id: f.task.paneId,
    terminal_id: f.task.terminalId, workspace_id: f.pane.workspace_id };
  if (explicitNull) { f.native.agent_session = null; f.native.completion_seq = null; }
  f.native.state_change_seq = 1290;
  f.task.submission.baselineCompletion = 0;
  f.task.submission.baselineStateChange = 1290;
  fs.writeFileSync(path.join(f.taskDir, 'task.json'), JSON.stringify(f.task));
  return f;
}

test('Herdr 0.9.5 optional native/completion metadata uses exact Hook and process identity, not an invented reference', async () => {
  for (const explicitNull of [false, true]) {
    const f = optionalMetadataFixture({ explicitNull });
    const deps = dependencies(f);
    const result = await submit(f.task, 'Prepared isolated task pointer', deps.deps);
    assert.equal(deps.runs.length, 1);
    assert.equal(result.status, 'text_queued');
    assert.equal(result.nativeAcceptanceConfirmed, false);
    assert.equal(result.processProof.pid, f.nodeOne.pid);
    assert.equal(f.task.submission.baselineCompletion, 0);
    assert.equal(f.task.submission.baselineStateChange, 1290);
  }
});

test('optional metadata cannot replace missing native Hook, foreign session or a newer CBC process', async () => {
  for (const mutate of [
    (f, d) => { d.deps.readEvents = () => []; },
    (f, d) => { d.deps.readEvents = () => [{ timestamp: new Date().toISOString(), name: 'SessionStart',
      taskId: f.task.id, round: 0, sessionId: 'other-native', herdrSession: f.task.herdrSession,
      paneId: f.task.paneId, terminalId: f.task.terminalId, identityBound: true }]; },
    (f, d) => { d.deps.readEvents = () => [{ timestamp: new Date(Date.now() - 45000).toISOString(), name: 'SessionStart',
      taskId: f.task.id, round: 0, sessionId: f.task.workerSessionId, herdrSession: f.task.herdrSession,
      paneId: f.task.paneId, terminalId: f.task.terminalId, identityBound: true }]; },
    (f, d) => { d.setNative({ ...f.native, agent_session: { value: 'different-native' } }); },
    (f, d) => { f.pane.agent_session = { value: 'different-native' }; },
    (f, d) => { d.setNative({ ...f.native, agent_session: {} }); },
    (f, d) => { d.setNative({ ...f.native, agent_status: 'blocked' }); },
    (f, d) => { d.setVisible('Permission required: Allow once?'); },
  ]) {
    const f = optionalMetadataFixture(), d = dependencies(f); mutate(f, d);
    await assert.rejects(submit(f.task, 'No input', d.deps), expectPreflight);
    assert.equal(d.runs.length, 0);
  }
});

test('state-change sequence is a separate nonnegative stability baseline and never a completion fallback', async () => {
  for (const value of [undefined, -1, '1290', NaN, 1291]) {
    const f = optionalMetadataFixture(), d = dependencies(f);
    d.setNative({ ...f.native, state_change_seq: value });
    await assert.rejects(submit(f.task, 'No input', d.deps), expectPreflight);
    assert.equal(d.runs.length, 0);
  }
  const f = optionalMetadataFixture(), d = dependencies(f), call = d.deps.call;
  let reads = 0;
  d.deps.call = (s, args) => {
    if (args[0] === 'agent' && args[1] === 'get' && ++reads === 2) d.setNative({ ...f.native, state_change_seq: 1291 });
    return call(s, args);
  };
  await assert.rejects(submit(f.task, 'No input', d.deps), expectPreflight);
  assert.equal(d.runs.length, 0);
});

test('explicit conflicting native owner elsewhere remains blocked when current public session is absent', async () => {
  const f = optionalMetadataFixture(), d = dependencies(f), call = d.deps.call;
  d.deps.call = (s, args) => args[0] === 'agent' && args[1] === 'list'
    ? { result: { agents: [f.native, { ...f.native, pane_id: 'other-pane', terminal_id: 'other-terminal',
      agent_session: { value: f.task.workerSessionId } }] } } : call(s, args);
  await assert.rejects(submit(f.task, 'No input', d.deps), expectPreflight);
  assert.equal(d.runs.length, 0);
});

test('fast current-round Hook proves activity without requiring completion metadata or claiming completion', () => {
  const f = optionalMetadataFixture();
  f.task.history = [{ round: f.task.round, status: 'submitted', timestamp: new Date(Date.now() - 1000).toISOString() }];
  const event = { timestamp: new Date().toISOString(), name: 'Stop', identityBound: true,
    taskId: f.task.id, round: f.task.round, sessionId: f.task.workerSessionId,
    herdrSession: f.task.herdrSession, paneId: f.task.paneId, terminalId: f.task.terminalId };
  const file = path.join(f.task.stateDir, 'hook-events.ndjson');
  fs.writeFileSync(file, JSON.stringify(event) + '\n');
  assert.equal(readSubmissionActivity(f.task).source, 'cbc-native-hook');
  assert.equal(f.task.status, 'running');
  for (const patch of [{ round: f.task.round - 1 }, { taskId: 'old-task' }, { sessionId: 'foreign-session' },
    { identityBound: false }, { name: 'SessionStart' }, { terminalId: 'old-terminal' },
    { timestamp: new Date(Date.now() - 10000).toISOString() }]) {
    fs.writeFileSync(file, JSON.stringify({ ...event, ...patch }) + '\n');
    assert.equal(readSubmissionActivity(f.task), null);
  }
});

test('global npm cbc.cmd resolves only its referenced CodeBuddy package script without executing the shim', () => {
  const f = fixture();
  const resolved = resolveCbcExecutable(f.shimPath, { nodeExecutable: f.nodePath,
    realpath: value => path.resolve(value) });
  assert.deepEqual(resolved, { executablePath: path.resolve(f.nodePath), scriptPath: path.resolve(f.scriptPath) });

  const wrongShim = path.join(path.dirname(f.shimPath), 'wrong.cmd');
  fs.writeFileSync(wrongShim, '@CALL node "node_modules\\@someone-else\\package\\bin\\cli" %*\r\n');
  assert.throws(() => resolveCbcExecutable(wrongShim, { nodeExecutable: f.nodePath,
    realpath: value => path.resolve(value) }), /known CodeBuddy package script/);
});

test('CBC guarded submit proves exact npm-shim Node script under the PowerShell Pane before one atomic pane.run', async () => {
  const f = fixture();
  const deps = dependencies(f);
  const result = await submit(f.task, 'Read the prepared task brief from the supplied path.', deps.deps);
  assert.equal(result.status, 'text_queued');
  assert.equal(result.transport, 'guarded-pane');
  assert.equal(result.inputAccepted, true);
  assert.equal(result.nativeAcceptanceConfirmed, false);
  assert.equal(result.guard.checkSendAtomic, false);
  assert.equal(result.processProof.pid, f.nodeOne.pid);
  assert.equal(result.processProof.processStartedAt, f.nodeOne.creationTime);
  assert.equal(Object.hasOwn(result.processProof, 'commandLine'), false);
  assert.equal(deps.runs.length, 1);
  assert.equal(deps.runs[0].text, 'Read the prepared task brief from the supplied path.');
  assert.deepEqual(deps.runs[0].session, f.task.herdrSession);
  assert.ok(deps.calls.filter(call => call.args[0] === 'pane' && call.args[1] === 'run').length === 1);
  assert.equal(deps.calls.some(call => call.args[0] === 'agent' && call.args[1] === 'prompt'), false);
});

test('CBC 1M PowerShell launcher proves its pinned npm shim target without parsing or executing the launcher', async () => {
  const f = fixture();
  const wrapper = path.join(root, 'delegation', `cbc-context-1m-${serial}.ps1`);
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, "$cbcNative=Join-Path $env:APPDATA 'npm/cbc.cmd'; & $cbcNative --settings $cbcPreset @args\n");
  f.task.cbcBinary = wrapper;
  f.task.cbcNativeBinary = f.shimPath;
  fs.writeFileSync(path.join(f.taskDir, 'task.json'), JSON.stringify(f.task));
  const deps = dependencies(f);
  const result = await submit(f.task, 'Use the prepared brief.', deps.deps);
  assert.equal(result.status, 'text_queued');
  assert.equal(result.processProof.pid, f.nodeOne.pid);

  const appData = path.join(root, `legacy-appdata-${serial}`);
  const legacyShim = path.join(appData, 'npm', 'cbc.cmd');
  fs.mkdirSync(path.dirname(legacyShim), { recursive: true });
  fs.writeFileSync(legacyShim, '@CALL node "%~dp0\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n');
  fs.mkdirSync(path.join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'), '');
  assert.equal(nativeCbcBinary({ cbcBinary: wrapper }, { appData }), legacyShim);
});

test('CBC initial startup r0 authorizes first round r1 and same-task Stop r3 authorizes rework r4', async () => {
  const first = fixture({ round: 1, hookName: 'SessionStart', hookRound: 0 });
  const firstResult = await submit(first.task, 'round one', dependencies(first).deps);
  assert.equal(firstResult.status, 'text_queued');

  const rework = fixture({ round: 4, hookName: 'Stop', hookRound: 3 });
  const reworkResult = await submit(rework.task, 'round four', dependencies(rework).deps);
  assert.equal(reworkResult.status, 'text_queued');
});

test('current round boundary works after cold restore even when reusedFromTaskId points to a closed old Pane', async () => {
  const f = fixture();
  const source = { ...f.task, id: 'cbc-prompt-old-source', status: 'accepted', paneId: 'old-pane',
    terminalId: 'old-terminal', workerStartedAt: new Date(Date.now() - 120_000).toISOString() };
  f.task.reusedFromTaskId = source.id;
  fs.writeFileSync(path.join(f.taskDir, 'task.json'), JSON.stringify(f.task));
  const sourceDir = path.join(f.task.stateDir, 'tasks', source.id);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'task.json'), JSON.stringify(source));
  const deps = dependencies(f);
  const result = await submit(f.task, 'restore round', deps.deps);
  assert.equal(result.status, 'text_queued');
});

test('accepted and cancelled reusedFromTaskId sources may supply their exact original Hook boundary', async () => {
  for (const sourceStatus of ['accepted', 'cancelled']) {
    const f = fixture();
    const source = { ...f.task, id: `cbc-prompt-source-${sourceStatus}-${serial}`, status: sourceStatus,
      round: 2, workerStartedAt: new Date(Date.now() - 120_000).toISOString() };
    f.task.reusedFromTaskId = source.id;
    fs.writeFileSync(path.join(f.taskDir, 'task.json'), JSON.stringify(f.task));
    const sourceDir = path.join(f.task.stateDir, 'tasks', source.id);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'task.json'), JSON.stringify(source));
    const priorHook = { timestamp: new Date().toISOString(), name: 'Stop', source: 'stop',
      sessionId: f.task.workerSessionId, taskId: source.id, herdrSession: f.task.herdrSession,
      paneId: source.paneId, terminalId: source.terminalId, round: source.round, identityBound: true };
    fs.writeFileSync(path.join(f.task.stateDir, 'hook-events.ndjson'), `${JSON.stringify(priorHook)}\n`);
    const result = await submit(f.task, `reuse ${sourceStatus}`, dependencies(f).deps);
    assert.equal(result.status, 'text_queued');
  }
});

test('blocked agent, visible approval dialog, missing registration, and process proof failure send no input', async () => {
  const blocked = fixture({ status: 'blocked' });
  const blockedDeps = dependencies(blocked);
  await assert.rejects(submit(blocked.task, 'no send', blockedDeps.deps), expectPreflight);
  assert.equal(blockedDeps.runs.length, 0);

  const dialog = fixture();
  const dialogDeps = dependencies(dialog);
  dialogDeps.setVisible('Do you trust this folder? Press Enter to continue.');
  await assert.rejects(submit(dialog.task, 'no send', dialogDeps.deps), expectPreflight);
  assert.equal(dialogDeps.runs.length, 0);

  const unregistered = fixture();
  const unregisteredDeps = dependencies(unregistered, { call: (session, args) => {
    if (args[0] === 'agent' && args[1] === 'list') return { result: { agents: [] } };
    return dependencies(unregistered).deps.call(session, args);
  } });
  await assert.rejects(submit(unregistered.task, 'no send', unregisteredDeps.deps), expectPreflight);
  assert.equal(unregisteredDeps.runs.length, 0);

  const noCbc = fixture();
  const noCbcDeps = dependencies(noCbc);
  noCbcDeps.setTree([{ pid: 300 + serial, parentPid: noCbc.processInfo.shell_pid, name: 'powershell.exe',
    executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    creationTime: new Date().toISOString() }]);
  await assert.rejects(submit(noCbc.task, 'no send', noCbcDeps.deps), expectPreflight);
  assert.equal(noCbcDeps.runs.length, 0);

  const unavailable = fixture();
  const unavailableDeps = dependencies(unavailable, { readDescendants: () => { throw new Error('query failure'); } });
  await assert.rejects(submit(unavailable.task, 'no send', unavailableDeps.deps), error => {
    expectPreflight(error);
    assert.equal(error.guardStage, 'process-query');
    assert.equal(error.processProofCode, 'query-failed');
    return true;
  });
  assert.equal(unavailableDeps.runs.length, 0);

  const timedOut = fixture();
  const timedOutDeps = dependencies(timedOut, { readDescendants: () => {
    throw Object.assign(new Error('private transport detail'), { code: 'ETIMEDOUT' });
  } });
  await assert.rejects(submit(timedOut.task, 'no send', timedOutDeps.deps), error => {
    expectPreflight(error);
    assert.equal(error.guardStage, 'process-query');
    assert.equal(error.processProofCode, 'query-timeout');
    assert.doesNotMatch(error.message, /private transport detail/);
    return true;
  });
  assert.equal(timedOutDeps.runs.length, 0);

  const ambiguous = fixture();
  const ambiguousDeps = dependencies(ambiguous);
  const realCbcCommand = ambiguous.commandLines.get(ambiguous.nodeOne.pid);
  ambiguousDeps.setCommandLines(new Map([
    ...ambiguous.commandLines,
    [ambiguous.nodeTwo.pid, { ...realCbcCommand, pid: ambiguous.nodeTwo.pid,
      parentPid: ambiguous.nodeTwo.parentPid, creationTime: ambiguous.nodeTwo.creationTime }],
  ]));
  await assert.rejects(submit(ambiguous.task, 'no send', ambiguousDeps.deps), expectPreflight);
  assert.equal(ambiguousDeps.runs.length, 0);
});

test('lease, terminal, and latest Hook mismatches prevent Pane.run', async () => {
  const badLease = fixture();
  const leaseFile = path.join(badLease.task.stateDir, 'pane-leases',
    `${require('node:crypto').createHash('sha256').update(`${badLease.task.herdrSession}\n${badLease.task.paneId}`).digest('hex')}.json`);
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  lease.workerSessionId = 'another-native-session';
  fs.writeFileSync(leaseFile, JSON.stringify(lease));
  const leaseDeps = dependencies(badLease);
  await assert.rejects(submit(badLease.task, 'no send', leaseDeps.deps), expectPreflight);
  assert.equal(leaseDeps.runs.length, 0);

  const badTerminal = fixture();
  const terminalDeps = dependencies(badTerminal);
  badTerminal.pane.terminal_id = 'another-terminal';
  await assert.rejects(submit(badTerminal.task, 'no send', terminalDeps.deps), expectPreflight);
  assert.equal(terminalDeps.runs.length, 0);

  const badHook = fixture();
  const hookDeps = dependencies(badHook);
  hookDeps.deps.readEvents = () => [{ timestamp: new Date().toISOString(), name: 'PreToolUse',
    taskId: badHook.task.id, round: badHook.task.round - 1, sessionId: badHook.task.workerSessionId,
    herdrSession: badHook.task.herdrSession, paneId: badHook.task.paneId,
    terminalId: badHook.task.terminalId, identityBound: true }];
  await assert.rejects(submit(badHook.task, 'no send', hookDeps.deps), expectPreflight);
  assert.equal(hookDeps.runs.length, 0);
});

test('agent, native Hook, completion, and target process creation must remain stable across reads', async () => {
  const f = fixture();
  const reads = dependencies(f);
  let agentGets = 0;
  const call = reads.deps.call;
  reads.deps.call = (session, args) => {
    if (args[0] === 'agent' && args[1] === 'get' && ++agentGets === 2) {
      reads.setNative({ ...f.native, agent_status: 'done', completion_seq: 9 });
    }
    return call(session, args);
  };
  await assert.rejects(submit(f.task, 'no send', reads.deps), expectPreflight);
  assert.equal(reads.runs.length, 0);

  const pidReuse = fixture();
  const changed = dependencies(pidReuse);
  let treeReads = 0;
  changed.deps.readDescendants = () => {
    treeReads++;
    const node = { ...pidReuse.nodeOne, creationTime: treeReads === 1 ? pidReuse.nodeOne.creationTime : new Date().toISOString() };
    return [node, pidReuse.nodeTwo];
  };
  changed.deps.readCommandLine = pid => pid === pidReuse.nodeOne.pid
    ? { ...pidReuse.commandLines.get(pid), creationTime: treeReads === 1 ? pidReuse.nodeOne.creationTime : new Date().toISOString() }
    : pidReuse.commandLines.get(pid);
  await assert.rejects(submit(pidReuse.task, 'no send', changed.deps), expectPreflight);
  assert.equal(changed.runs.length, 0);

  const changedHook = fixture();
  const hookDeps = dependencies(changedHook);
  const hookFile = path.join(changedHook.task.stateDir, 'hook-events.ndjson');
  const base = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
  let eventReads = 0;
  hookDeps.deps.readEvents = () => {
    eventReads++;
    return eventReads === 1 ? [base] : [base, { ...base, name: 'UserPromptSubmit', timestamp: new Date().toISOString() }];
  };
  await assert.rejects(submit(changedHook.task, 'no send', hookDeps.deps), expectPreflight);
  assert.equal(hookDeps.runs.length, 0);
});

test('a lost pane.run receipt is unknown and never retried', async () => {
  for (const outcome of ['transport-error', 'empty-response', 'negative-response']) {
  const f = fixture();
  let attempts = 0;
  const deps = dependencies(f, { paneRun: async () => {
    attempts++;
    if (outcome === 'empty-response') return null;
    if (outcome === 'negative-response') return { ok: false };
    throw Object.assign(new Error('private simulated lost receipt'), { code: 'ETIMEDOUT', status: 1 });
  } });
  await assert.rejects(submit(f.task, 'one shot', deps.deps), error => {
    assert.equal(error.code, 'CBC_PROMPT_OUTCOME_UNKNOWN');
    assert.equal(error.requestSent, true);
    assert.equal(error.origin, 'guarded-pane-run');
    assert.equal(error.transportDiagnostic.outcome, outcome);
    assert.doesNotMatch(JSON.stringify(error.transportDiagnostic), /private simulated/);
    if (outcome === 'transport-error') assert.equal(error.transportDiagnostic.code, 'ETIMEDOUT');
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(deps.runs.length, 0);
  }
});

test('Windows process proof follows the Pane PowerShell subtree and accepts only the exact first Node script token', async () => {
  const f = fixture();
  const deps = dependencies(f);
  const proof = await proveWorkerProcess({ kind: 'cbc', processInfo: f.processInfo,
    executablePath: f.nodePath, scriptPath: f.scriptPath }, {
    platform: 'win32', readDescendants: deps.deps.readDescendants, readCommandLine: deps.deps.readCommandLine,
  });
  assert.equal(proof.pid, f.nodeOne.pid);
  assert.equal(proof.processStartedAt, f.nodeOne.creationTime);
  assert.equal(Object.keys(proof).some(key => /argv|commandline|path/i.test(key)), false);

  const promptOnlyPath = new Map(f.commandLines);
  const wrongScript = f.commandLines.get(f.nodeOne.pid);
  promptOnlyPath.set(f.nodeOne.pid, { ...wrongScript,
    commandLine: `"${f.nodePath}" "${path.join(root, 'unrelated.js')}" --prompt "${f.scriptPath}"` });
  await assert.rejects(proveWorkerProcess({ kind: 'cbc', processInfo: f.processInfo,
    executablePath: f.nodePath, scriptPath: f.scriptPath }, {
    platform: 'win32', readDescendants: deps.deps.readDescendants,
    readCommandLine: pid => promptOnlyPath.get(pid),
  }));
});

test('process identity stops at the exact script and does not parse trailing multiline task-policy quoting', async () => {
  const f = fixture(), records = new Map(f.commandLines);
  records.set(f.nodeOne.pid, { ...records.get(f.nodeOne.pid),
    commandLine: `node "${f.scriptPath}" --append-system-prompt "policy line one\r\nunterminated legacy shell quote` });
  const proof = await proveWorkerProcess({ kind: 'cbc', processInfo: f.processInfo,
    executablePath: f.nodePath, scriptPath: f.scriptPath }, {
    platform: 'win32', readDescendants: () => [f.nodeOne, f.nodeTwo], readCommandLine: pid => records.get(pid),
  });
  assert.equal(proof.pid, f.nodeOne.pid);
  records.set(f.nodeOne.pid, { ...records.get(f.nodeOne.pid),
    commandLine: `node "${path.join(root, 'other.js')}" --prompt "${f.scriptPath}"` });
  await assert.rejects(proveWorkerProcess({ kind: 'cbc', processInfo: f.processInfo,
    executablePath: f.nodePath, scriptPath: f.scriptPath }, {
    platform: 'win32', readDescendants: () => [f.nodeOne, f.nodeTwo], readCommandLine: pid => records.get(pid),
  }));
});

test('ZCode wrapper proof requires exact PID and first script token without returning its command line', async () => {
  const f = fixture();
  const script = path.join(root, 'zcode-worker.js');
  const pid = 500 + serial;
  const started = new Date().toISOString();
  const tree = [{ pid, parentPid: f.processInfo.shell_pid, name: 'node.exe', executablePath: f.nodePath, creationTime: started }];
  const proof = await proveWorkerProcess({ kind: 'zcode-wrapper', processInfo: f.processInfo, expectedPid: pid,
    executablePath: f.nodePath, scriptPath: script }, {
    platform: 'win32', readDescendants: () => tree,
    readCommandLine: () => ({ pid, parentPid: f.processInfo.shell_pid, executablePath: f.nodePath,
      name: 'node.exe', creationTime: started, commandLine: `node "${script}" native-session` }),
  });
  assert.equal(proof.pid, pid);
  assert.equal(Object.hasOwn(proof, 'commandLine'), false);
  await assert.rejects(proveWorkerProcess({ kind: 'zcode-wrapper', processInfo: f.processInfo, expectedPid: pid + 1,
    executablePath: f.nodePath, scriptPath: script }, { platform: 'win32', readDescendants: () => tree,
    readCommandLine: () => ({ pid, parentPid: f.processInfo.shell_pid, executablePath: f.nodePath,
      name: 'node.exe', creationTime: started, commandLine: `node "${script}" native-session` }) }));
});

test('read-only Windows subtree query uses configured PowerShell 7, UTF-8, and parent-scoped CIM filters', () => {
  const previous = process.env.AGENT_BRIDGE_POWERSHELL;
  process.env.AGENT_BRIDGE_POWERSHELL = 'pwsh-fixture.exe';
  let invocation;
  try {
    const tree = readWindowsDescendants(765, { spawnSyncFn: (binary, args, options) => {
      invocation = { binary, args, options };
      return { status: 0, stdout: '[]' };
    } });
    assert.deepEqual(tree, []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_POWERSHELL;
    else process.env.AGENT_BRIDGE_POWERSHELL = previous;
  }
  assert.equal(invocation.binary, 'pwsh-fixture.exe');
  assert.ok(invocation.args.includes('-NoProfile'));
  assert.equal(invocation.options.encoding, 'utf8');
  assert.match(invocation.args.at(-1), /ParentProcessId = \{0\}/);
  assert.match(invocation.args.at(-1), /-f \$parent/);
  assert.match(invocation.args.at(-1), /OutputEncoding/);
  assert.doesNotMatch(invocation.args.at(-1), /CommandLine/);
});

test('one timed-out preflight restarts both full proofs before exactly one input', async () => {
  for (const failedRead of [1, 2]) {
    const f = fixture(), d = dependencies(f); const original = d.deps.readDescendants; let reads = 0, pauses = 0;
    d.deps.readDescendants = pid => { if (++reads === failedRead) throw Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }); return original(pid); };
    d.deps.pause = async ms => { assert.equal(ms, 250); pauses++; };
    const receipt = await submit(f.task, 'one input', d.deps);
    assert.equal(receipt.guard.preflightReadAttempts, 2); assert.equal(pauses, 1);
    assert.equal(reads, failedRead + 2); assert.equal(d.runs.length, 1);
  }
});

test('preflight retry never retries denial or identity mismatch and rechecks approvals', async () => {
  for (const kind of ['denied', 'identity', 'timeout-always', 'approval-after-timeout']) {
    const f = fixture(), d = dependencies(f); let calls = 0;
    d.deps.readDescendants = () => { calls++; throw Object.assign(new Error('private query detail'), {
      ...(kind === 'denied' ? { code: 'EACCES' } : kind === 'identity' ? { processProofCode: 'process-identity-changed' } : { code: 'ETIMEDOUT' }) }); };
    d.deps.pause = async () => { if (kind === 'approval-after-timeout') d.setVisible('Do you trust this folder?'); };
    await assert.rejects(submit(f.task, 'not sent', d.deps), error => {
      assert.equal(error.code, 'CBC_PROMPT_GUARD_REJECTED'); assert.equal(error.requestSent, false);
      assert.equal(error.preflightReadAttempts, ['timeout-always', 'approval-after-timeout'].includes(kind) ? 2 : 1);
      assert.doesNotMatch(error.message, /private query detail/); return true;
    });
    assert.equal(calls, kind === 'timeout-always' ? 2 : 1); assert.equal(d.runs.length, 0);
  }
});

test('guard diagnostics only expose approved fields and executable resolution has its own stage', async () => {
  const {guardDiagnostics}=require('../lib/cbc-prompt');
  assert.deepEqual(guardDiagnostics({code:'CBC_PROMPT_GUARD_REJECTED',guardStage:'PRIVATE',processProofCode:'PRIVATE',preflightReadAttempts:3}), {});
  const f=fixture(), d=dependencies(f, {resolveCbcExecutable:()=>{throw Error('PRIVATE_PATH');}});
  await assert.rejects(submit(f.task,'no send',d.deps),error=>{
    assert.equal(error.guardStage,'executable-resolution'); assert.doesNotMatch(error.message,/PRIVATE_PATH/); return true;
  }); assert.equal(d.runs.length,0);
});
