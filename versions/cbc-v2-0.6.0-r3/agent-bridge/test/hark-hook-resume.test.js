'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { writeLease, leasePath } = require('../lib/worker-lease');
const { observedContext } = require('../lib/worker-context');
const { buildResumeArgv, validResumeArgv } = require('../hooks/herdr-resume');
const resumeWorker = require('../bin/resume-worker');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-hook-resume-'));
const herdrStub = path.join(root, 'herdr-stub.cjs');
const herdrUnknownPaneStub = path.join(root, 'herdr-unknown-pane.cjs');
let serial = 0;
fs.writeFileSync(herdrStub, [
  'process.stdout.write(JSON.stringify({ result: { pane: {',
  '  pane_id: process.env.HARK_HOOK_PANE_ID, terminal_id: process.env.HARK_HOOK_TERMINAL_ID,',
  '} } }));',
].join('\n'));
fs.writeFileSync(herdrUnknownPaneStub, "process.stdout.write(JSON.stringify({ result: { pane: null } }));\n");

test.after(() => {
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function withEnv(values, operation) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await operation(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fixture({ agent = 'cbc', status = 'running', unsafeStateDir = false, unboundNative = false } = {}) {
  const stateDir = unsafeStateDir ? path.join(root, `unsafe-${++serial}'state`) : path.join(root, `case-${++serial}`);
  const id = `hark-hook-${serial}`;
  const taskRoot = path.join(stateDir, 'tasks', id);
  const cwd = path.join(root, `project-${serial}`);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const task = { id, agent, stateDir, cwd, status, herdrSession: 'hark-hook-session', paneId: `w1:p${serial}`,
    terminalId: `term-${serial}`, workerSessionId: unboundNative ? null : `native_${serial}`,
    workerStartedAt: new Date(Date.now() - 1000).toISOString(),
    round: 3, model: 'provider/model-x', effort: 'high', permissionMode: 'acceptEdits', skipPermissions: false,
    cbcSettingsPath: path.join(root, 'cbc-settings.json'), workerPolicyPath: path.join(taskRoot, 'worker-policy.md'),
    agyDeliveryProfile: { version: '1.4.10' } };
  fs.writeFileSync(path.join(taskRoot, 'task.json'), JSON.stringify(task));
  fs.writeFileSync(task.workerPolicyPath, 'isolated worker policy');
  writeLease(task);
  return { task, stateDir, taskRoot, cwd };
}

function captureChild(script, args, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function dryRunEnv(f, overrides = {}) {
  return { AGENT_BRIDGE_STATE_DIR: f.stateDir, AGENT_BRIDGE_HERDR_SESSION: f.task.herdrSession,
    HERDR_ENV: '1', HERDR_PANE_ID: f.task.paneId, HERDR_BIN_PATH: herdrStub,
    HARK_HOOK_PANE_ID: f.task.paneId, HARK_HOOK_TERMINAL_ID: f.task.terminalId,
    AGENT_BRIDGE_HOOK_DRY_RUN: '1', AGENT_BRIDGE_TASK_ID: f.task.id, ...overrides };
}

function restoreDeps(f, { paneId = f.task.paneId, terminalId = f.task.terminalId,
  records = [{ pane_id: f.task.paneId, terminal_id: f.task.terminalId,
    agent: f.task.agent === 'agy' ? 'agent-bridge-agy' : 'codebuddy', agent_status: 'idle',
    agent_session: { value: f.task.workerSessionId } }], inventoryAvailable = true } = {}) {
  const env = { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: paneId,
    HERDR_BIN_PATH: herdrStub, AGENT_BRIDGE_HERDR_SESSION: f.task.herdrSession };
  let paneReads = 0, inventoryReads = 0;
  return { env,
    readPane: (binary, session, currentPane) => {
      paneReads++;
      assert.equal(binary, herdrStub); assert.equal(session, f.task.herdrSession);
      return paneId === currentPane ? { paneId, terminalId } : null;
    },
    readInventory: (binary, session) => {
      inventoryReads++;
      assert.equal(binary, herdrStub); assert.equal(session, f.task.herdrSession);
      return inventoryAvailable ? records : null;
    },
    reads: () => ({ paneReads, inventoryReads }),
  };
}

test('resume argv uses plain PATH node and rejects apostrophes, control characters, and Herdr size limits', () => {
  const f = fixture();
  const args = buildResumeArgv(f.stateDir, f.task.id, f.task.workerSessionId);
  assert.equal(args[0], 'node');
  assert.equal(path.isAbsolute(args[0]), false);
  assert.equal(args[1], path.resolve(__dirname, '..', 'bin', 'resume-worker.js'));
  assert.equal(validResumeArgv(args), true);
  assert.equal(buildResumeArgv(path.join(root, "unsafe'state"), f.task.id, f.task.workerSessionId), null);
  assert.equal(validResumeArgv(['node', 'bad\nargument']), false);
  assert.equal(validResumeArgv(['node', ...Array(64).fill('x')]), false);
  assert.equal(validResumeArgv(['node', 'x'.repeat(8192)]), false);
  assert.equal(validResumeArgv([process.execPath, 'script.js']), false);
});

test('CBC hook binds resume metadata to task, round, native session, and terminal while preserving live state report', async () => {
  const f = fixture();
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), [], dryRunEnv(f),
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: f.task.workerSessionId, round: f.task.round }));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const args = report.args;
  assert.ok(args.includes('--state') && args.includes('idle'));
  assert.ok(args.includes('--agent') && args.includes('codebuddy'));
  assert.ok(args.includes('--source') && args.includes('custom:agent-bridge'));
  const split = args.indexOf('--');
  assert.ok(split >= 0);
  assert.equal(args[split + 1], 'node');
  assert.equal(args[split + 2], path.resolve(__dirname, '..', 'bin', 'resume-worker.js'));
  assert.deepEqual(args.slice(split + 3), [f.stateDir, f.task.id, f.task.workerSessionId]);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'hook-events.ndjson'), 'utf8').trim());
  assert.equal(receipt.identityBound, true);
  assert.equal(receipt.taskId, f.task.id);
  assert.equal(receipt.round, f.task.round);
  assert.equal(receipt.sessionId, f.task.workerSessionId);
  assert.equal(receipt.terminalId, f.task.terminalId);
});

test('unsafe CBC resume arguments omit only resume_argv and still report the current state', async () => {
  const f = fixture({ unsafeStateDir: true });
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), [], dryRunEnv(f),
    JSON.stringify({ hook_event_name: 'Stop', source: 'stop', session_id: f.task.workerSessionId, round: f.task.round }));
  assert.equal(result.code, 0, result.stderr);
  const args = JSON.parse(result.stdout).args;
  assert.ok(args.includes('--state') && args.includes('idle'));
  assert.equal(args.includes('--'), false);
});

test('CBC first native Hook binds an initially empty lease only after Herdr confirms the exact Pane terminal', async () => {
  const f = fixture({ unboundNative: true });
  const nativeId = `native_first_${serial}`;
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), [],
    dryRunEnv(f, { HARK_HOOK_TERMINAL_ID: f.task.terminalId }),
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: nativeId, round: f.task.round }));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.args.includes('--state') && output.args.includes('idle'));
  assert.ok(output.args.includes('--') && output.args[output.args.indexOf('--') + 1] === 'node');
  const lease = JSON.parse(fs.readFileSync(leasePath(f.stateDir, f.task.herdrSession, f.task.paneId), 'utf8'));
  assert.equal(lease.workerSessionId, nativeId);
  assert.equal(lease.terminalId, f.task.terminalId);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'hook-events.ndjson'), 'utf8').trim());
  assert.equal(receipt.identityBound, true);
  assert.equal(receipt.taskId, f.task.id);
  assert.equal(receipt.round, f.task.round);
  assert.equal(receipt.sessionId, nativeId);
  assert.equal(receipt.terminalId, f.task.terminalId);
});

test('CBC Hook does not report state when a bridge task cannot verify the current Pane terminal', async () => {
  const f = fixture();
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), [],
    dryRunEnv(f, { HARK_HOOK_TERMINAL_ID: 'actual-terminal-mismatch' }),
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: f.task.workerSessionId }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(f.stateDir, 'hook-events.ndjson')), false);
});

test('CBC Hook does not let an old native session inherit a Pane lease after identity resolution fails', async () => {
  const f = fixture();
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), [],
    dryRunEnv(f, { HERDR_BIN_PATH: herdrUnknownPaneStub }),
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'native_old_session' }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(f.stateDir, 'hook-events.ndjson')), false);
});

test('CBC notification hook reports permission prompts once and ignores other notifications', async () => {
  const f = fixture();
  const script = path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js');
  const ignored = await captureChild(script, [], dryRunEnv(f), JSON.stringify({ hook_event_name: 'Notification',
    notification_type: 'idle_prompt', session_id: f.task.workerSessionId }));
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.equal(ignored.stdout, '');

  const permission = await captureChild(script, [], dryRunEnv(f), JSON.stringify({ hook_event_name: 'Notification',
    notification_type: 'permission_prompt', session_id: f.task.workerSessionId }));
  assert.equal(permission.code, 0, permission.stderr);
  const args = JSON.parse(permission.stdout).args;
  assert.equal(args.filter(value => value === '--message').length, 1);
  assert.ok(args.includes('blocked'));
});

test('AGY Hook uses the native conversation ID and full lease as independent context evidence, never preflight alone', async () => {
  const f = fixture({ agent: 'agy' });
  const events = path.join(f.stateDir, 'hook-events.ndjson');
  fs.writeFileSync(events, `${JSON.stringify({ timestamp: new Date().toISOString(), name: 'SessionStart',
    source: 'agy-cli-preflight', sessionId: f.task.workerSessionId, taskId: f.task.id,
    herdrSession: f.task.herdrSession, paneId: f.task.paneId })}\n`);
  assert.equal(observedContext(f.task), null);

  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-agy.js'), ['SessionStart'], dryRunEnv(f),
    JSON.stringify({ conversationId: f.task.workerSessionId }));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun.identityBound, true);
  assert.equal(output.dryRun.resumeIncluded, true);
  assert.equal(output.dryRun.args[output.dryRun.args.indexOf('--') + 1], 'node');
  assert.equal(output.dryRun.args[output.dryRun.args.indexOf('--agent') + 1], 'agy');
  const observed = observedContext(f.task);
  assert.equal(observed.sessionId, f.task.workerSessionId);
});

test('AGY Hook with unsafe resume argv still reports state and does not assert native context identity', async () => {
  const f = fixture({ agent: 'agy', unsafeStateDir: true });
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-agy.js'), ['Stop'], dryRunEnv(f),
    JSON.stringify({ conversationId: f.task.workerSessionId, fullyIdle: false }));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun.state, 'blocked');
  assert.equal(output.dryRun.identityBound, true);
  assert.equal(output.dryRun.resumeIncluded, false);
  assert.equal(output.dryRun.args.includes('--'), false);
  const last = fs.readFileSync(path.join(f.stateDir, 'hook-events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(last.source, 'agy-native-hook');
  assert.equal(last.terminalId, f.task.terminalId);
});

test('AGY terminal mismatch blocks policy injection, state correction, resume argv, and native attestation', async () => {
  const f = fixture({ agent: 'agy' });
  const file = leasePath(f.stateDir, f.task.herdrSession, f.task.paneId);
  const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
  lease.terminalId = 'moved-terminal';
  fs.writeFileSync(file, JSON.stringify(lease));
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-agy.js'), ['PreInvocation'], dryRunEnv(f),
    JSON.stringify({ conversationId: f.task.workerSessionId }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(fs.existsSync(path.join(f.stateDir, 'hook-events.ndjson')), false);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'agy-state.json')), false);
  assert.equal(observedContext(f.task), null);
});

test('AGY unknown live Pane identity blocks policy injection, state correction, resume argv, and native attestation', async () => {
  const f = fixture({ agent: 'agy' });
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-agy.js'), ['PreInvocation'],
    dryRunEnv(f, { HERDR_BIN_PATH: herdrUnknownPaneStub }),
    JSON.stringify({ conversationId: f.task.workerSessionId }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(fs.existsSync(path.join(f.stateDir, 'hook-events.ndjson')), false);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'agy-state.json')), false);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'agy-policy-receipts')), false);
  assert.equal(observedContext(f.task), null);
});

test('AGY Hook refuses PreInvocation when the live Herdr Pane has another terminal than task and lease', async () => {
  const f = fixture({ agent: 'agy' });
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-agy.js'), ['PreInvocation'],
    dryRunEnv(f, { HARK_HOOK_TERMINAL_ID: 'live-other-terminal' }),
    JSON.stringify({ conversationId: f.task.workerSessionId }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(fs.existsSync(path.join(f.stateDir, 'hook-events.ndjson')), false);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'agy-state.json')), false);
  assert.equal(fs.existsSync(path.join(f.taskRoot, 'agy-policy-receipts')), false);
  assert.equal(observedContext(f.task), null);
});

test('resume worker reconstructs CBC and AGY launch options from the saved descriptor, and rejects other native IDs', async () => {
  const cbc = fixture();
  const agy = fixture({ agent: 'agy' });
  const previousState = process.env.AGENT_BRIDGE_STATE_DIR;
  const previousCbc = process.env.AGENT_BRIDGE_CBC;
  const previousAgy = process.env.AGENT_BRIDGE_AGY;
  process.env.AGENT_BRIDGE_STATE_DIR = cbc.stateDir;
  process.env.AGENT_BRIDGE_CBC = path.join(root, 'cbc.exe');
  process.env.AGENT_BRIDGE_AGY = path.join(root, 'agy.exe');
  try {
    const calls = [];
    const spawnFn = (binary, args, options) => {
      calls.push({ binary, args, options });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    const cbcDeps = restoreDeps(cbc);
    assert.equal(await resumeWorker.main([cbc.stateDir, cbc.task.id, cbc.task.workerSessionId], { spawnFn, ...cbcDeps }), 0);
    assert.deepEqual(cbcDeps.reads(), { paneReads: 1, inventoryReads: 1 });
    assert.equal(calls[0].binary, 'pwsh');
    const cbcCommand = calls[0].args.at(-1);
    for (const fragment of ['--settings', '--permission-mode', '--resume', '--model', '--effort',
      '--append-system-prompt', '--add-dir']) assert.ok(cbcCommand.includes(fragment), fragment);
    assert.equal(calls[0].options.cwd, cbc.task.cwd);
    assert.equal(calls[0].options.env.AGENT_BRIDGE_STATE_DIR, cbc.stateDir);
    assert.equal(calls[0].options.env.AGENT_BRIDGE_TASK_ID, cbc.task.id);
    assert.equal(calls[0].options.env.AGENT_BRIDGE_HERDR_SESSION, cbc.task.herdrSession);

    process.env.AGENT_BRIDGE_STATE_DIR = agy.stateDir;
    agy.task.skipPermissions = true;
    fs.writeFileSync(path.join(agy.taskRoot, 'task.json'), JSON.stringify(agy.task));
    assert.equal(await resumeWorker.main([agy.stateDir, agy.task.id, agy.task.workerSessionId],
      { spawnFn, ...restoreDeps(agy) }), 0);
    const agyCommand = calls[1].args.at(-1);
    for (const fragment of ['--conversation', '--dangerously-skip-permissions', '--model', '--effort', '--add-dir', '--settings']) {
      assert.ok(agyCommand.includes(fragment), fragment);
    }
    await assert.rejects(resumeWorker.main([cbc.stateDir, cbc.task.id, 'native_wrong'],
      { spawnFn, ...cbcDeps }), /does not match/);
    assert.equal(calls.length, 2);
  } finally {
    if (previousState === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR; else process.env.AGENT_BRIDGE_STATE_DIR = previousState;
    if (previousCbc === undefined) delete process.env.AGENT_BRIDGE_CBC; else process.env.AGENT_BRIDGE_CBC = previousCbc;
    if (previousAgy === undefined) delete process.env.AGENT_BRIDGE_AGY; else process.env.AGENT_BRIDGE_AGY = previousAgy;
  }
});

test('resume worker refuses moved Pane, another native owner, live old terminal, and unknown current identity', async () => {
  const f = fixture();
  const calls = [];
  const spawnFn = (...args) => { calls.push(args); throw new Error('must not spawn'); };
  const invoke = deps => resumeWorker.main([f.stateDir, f.task.id, f.task.workerSessionId], { spawnFn, ...deps });
  const original = fs.readFileSync(path.join(f.taskRoot, 'task.json'), 'utf8');

  await assert.rejects(invoke(restoreDeps(f, { paneId: 'w2:p-moved' })), /adopt-restored/);
  await assert.rejects(invoke(restoreDeps(f, { records: [
    { pane_id: f.task.paneId, terminal_id: f.task.terminalId },
    { pane_id: 'w2:p-owner', terminal_id: 'term-other', agent_session: { value: f.task.workerSessionId } },
  ] })), /another Pane/);
  await assert.rejects(invoke(restoreDeps(f, { records: [
    { pane_id: f.task.paneId, terminal_id: f.task.terminalId },
    { pane_id: 'w2:p-old-terminal', terminal_id: f.task.terminalId },
  ] })), /another Pane/);
  await assert.rejects(invoke(restoreDeps(f, { inventoryAvailable: false })), /cannot confirm the current Pane/);
  await assert.rejects(invoke(restoreDeps(f, { records: [
    { pane_id: f.task.paneId, terminal_id: 'inventory-terminal' },
  ] })), /incomplete or inconsistent/);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.taskRoot, 'task.json'), 'utf8'), original);
});

test('resume worker permits only the verified current Pane when a prior terminal is no longer elsewhere', async () => {
  const f = fixture();
  const calls = [];
  const spawnFn = (_binary, _args, _options) => {
    calls.push(true);
    const child = new EventEmitter(); setImmediate(() => child.emit('close', 0, null)); return child;
  };
  const deps = restoreDeps(f, { terminalId: 'term-current-after-restore', records: [
    { pane_id: f.task.paneId, terminal_id: 'term-current-after-restore',
      agent: 'codebuddy', agent_status: 'idle', agent_session: { value: f.task.workerSessionId } },
  ] });
  const beforeTask = fs.readFileSync(path.join(f.taskRoot, 'task.json'), 'utf8');
  assert.equal(await resumeWorker.main([f.stateDir, f.task.id, f.task.workerSessionId], { spawnFn, ...deps }), 0);
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.taskRoot, 'task.json'), 'utf8'), beforeTask);
});

test('resume worker refuses accepted, cancelled and abandoned tasks without launching a shell', async () => {
  const calls = [];
  const spawnFn = (...args) => { calls.push(args); throw new Error('must not spawn'); };
  for (const status of ['accepted', 'cancelled', 'abandoned']) {
    const f = fixture({ status });
    await assert.rejects(resumeWorker.main([f.stateDir, f.task.id, f.task.workerSessionId], { spawnFn }),
      new RegExp(`refuses terminal task status: ${status}`));
  }
  assert.equal(calls.length, 0);
});
