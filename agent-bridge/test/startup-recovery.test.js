'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { saveTask, loadTask, event, writeJsonAtomic } = require('../lib/util');
const { contextPath } = require('../lib/worker-context');
const { writeLease } = require('../lib/worker-lease');
const { assertSingleActive } = require('../lib/worker-scheduling');
const { proveNotStarted, cancelNotStarted } = require('../lib/startup-recovery');
const { serverRunning, ensureServer } = require('../lib/herdr');
const { recoverOne } = require('../bin/agent-bridge');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-startup-')); let serial = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateDir = path.join(root, 'case-' + ++serial); process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const message = 'Herdr server for session "test" did not start; if this is a new named session, run `herdr session attach test` once to initialize it';
  const task = { id: 'unstarted-cbc', agent: 'cbc', cwd: stateDir, stateDir, herdrSession: 'test', workerKey: 'independent',
    status: 'failed', round: 0, submission: null, paneId: null, terminalId: null, workerSessionId: null,
    error: message, history: [{ round: 0, status: 'failed', message }] };
  saveTask(task); event(task, 'dispatch_failed', { message });
  return task;
}

test('legacy pre-worker failure can be officially cancelled while preserving failure history and releasing only its binding', () => {
  const task = fixture(), next = { ...task, id: 'next-task', status: 'created' };
  assert.throws(() => assertSingleActive(next), /occupied/);
  const result = cancelNotStarted(task);
  assert.equal(result.status, 'cancelled'); assert.equal(result.cancellation.source, 'startup-not-started');
  assert.equal(result.cancellation.interruptAttempted, false); assert.equal(result.history[0].status, 'failed');
  assert.equal(result.workerSessionId, null); assert.equal(result.cancellation.evidence.noTaskSubmitted, true);
  assert.doesNotThrow(() => assertSingleActive(next));
});

test('missing native identity alone is not proof and contradictory side effects always refuse cancellation', () => {
  for (const variant of ['error', 'history', 'submission', 'round', 'session', 'pane', 'terminal', 'worker', 'prompt', 'artifacts', 'events']) {
    const task = fixture();
    if (variant === 'error') task.error = 'transport failed at an unknown stage';
    if (variant === 'history') task.history.push({ round: 0, status: 'submitted' });
    if (variant === 'submission') task.submission = { status: 'uncertain' };
    if (variant === 'round') task.round = 1;
    if (variant === 'session') task.workerSessionId = 'existing-session';
    if (variant === 'pane') task.paneId = 'existing-pane';
    if (variant === 'terminal') task.terminalId = 'existing-terminal';
    if (variant === 'worker') task.workerStartedAt = new Date().toISOString();
    if (variant === 'prompt') task.promptBody = 'possibly delivered';
    if (variant === 'artifacts') fs.writeFileSync(path.join(task.stateDir, 'tasks', task.id, 'worker-policy.md'), 'possibly launched');
    if (variant === 'events') event(task, 'submitted');
    saveTask(task); const before = fs.readFileSync(path.join(task.stateDir, 'tasks', task.id, 'task.json'));
    assert.throws(() => cancelNotStarted(task), undefined, variant);
    assert.deepEqual(fs.readFileSync(path.join(task.stateDir, 'tasks', task.id, 'task.json')), before);
  }
});

test('context, lease, live watcher and changed task metadata cannot be discarded as a startup placeholder', () => {
  for (const variant of ['context', 'lease', 'watcher', 'changed']) {
    const task = fixture();
    if (variant === 'context') writeJsonAtomic(contextPath(task), { lastTaskId: task.id });
    if (variant === 'lease') writeLease({ ...task, paneId: 'possibly-live-pane', terminalId: 'possibly-live-terminal' });
    if (variant === 'watcher') { task.watcherPid = process.pid; saveTask(task); }
    if (variant === 'changed') saveTask({ ...task, error: 'newer metadata' });
    assert.throws(() => proveNotStarted(task), undefined, variant);
  }
});

test('new startup boundary refuses possible worker effects and any live startup owner', () => {
  for (const variant of ['effects', 'owner', 'valid']) {
    const task = fixture();
    task.startup = { protocol: 1, attemptId: 'fixture-attempt', phase: 'checking-server', workerEffectsPossible: false };
    if (variant === 'effects') { task.startup.phase = 'worker-effects-possible'; task.startup.workerEffectsPossible = true; }
    if (variant === 'owner') task.startup.ownerPid = process.pid;
    saveTask(task);
    if (variant === 'valid') assert.equal(proveNotStarted(task).source, 'startup-effect-boundary');
    else assert.throws(() => proveNotStarted(task));
  }
});

test('recover only gives the correct cancel-and-dispatch guidance and does not invent a native session', async () => {
  const task = fixture(), before = fs.readFileSync(path.join(task.stateDir, 'tasks', task.id, 'task.json'));
  assert.match((await recoverOne(task)).join(' '), /No native.*cancel.*dispatch/);
  assert.deepEqual(fs.readFileSync(path.join(task.stateDir, 'tasks', task.id, 'task.json')), before);
  const cancelled = cancelNotStarted(task);
  assert.deepEqual(await recoverOne(cancelled), []);
});

test('actual cancel and recover CLI need no Herdr; resume refuses rather than inventing an original session', () => {
  const task = fixture(), cli = path.join(__dirname, '../bin/agent-bridge.js');
  const env = { ...process.env, AGENT_BRIDGE_STATE_DIR: task.stateDir, HERDR_BIN_PATH: path.join(root, 'must-not-run.exe') };
  const invoke = command => spawnSync(process.execPath, [cli, command, task.id], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(invoke('recover').status, 0);
  const resumed = invoke('resume'); assert.equal(resumed.status, 1); assert.match(resumed.stderr, /No native session was created/);
  assert.equal(invoke('cancel').status, 0); assert.equal(loadTask(task.id).status, 'cancelled');
  assert.equal(invoke('cancel').status, 0); assert.equal(loadTask(task.id).history.length, 2);
});

test('a running task in another binding retains its bytes and still prevents an ordinary serial dispatch', () => {
  const task = fixture(), active = { ...task, id: 'unrelated-working-task', workerKey: 'other', status: 'running', round: 1,
    paneId: 'other-pane', terminalId: 'other-terminal', workerSessionId: 'other-session', submission: { status: 'observed' } };
  saveTask(active); const file = path.join(task.stateDir, 'tasks', active.id, 'task.json'), before = fs.readFileSync(file);
  cancelNotStarted(task);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => assertSingleActive({ ...task, id: 'next-task', status: 'created' }), /resource conflict|Another worker task is active/);
});

test('IPC permission rejection remains precise and never causes another server to spawn or wait', async () => {
  for (const variant of ['code', 'message', 'herdr-code']) {
    const denial = new Error(variant === 'message' ? 'PermissionDenied: for an elevated server use its authorized terminal' : 'IPC refused');
    if (variant === 'code') denial.code = 'EACCES';
    if (variant === 'herdr-code') denial.herdrCode = 'permission_denied';
    const probe = () => serverRunning('test', { probe: () => { throw denial; } });
    let starts = 0, waits = 0;
    await assert.rejects(ensureServer('test', { probe, start: () => { starts++; }, pause: () => { waits++; } }),
      error => error.code === 'HERDR_IPC_ACCESS_DENIED' && error.message === denial.message);
    assert.equal(starts, 0); assert.equal(waits, 0);
  }
  let starts = 0;
  await ensureServer('test', { probe: () => true, start: () => { starts++; } });
  assert.equal(starts, 0);
});

test('initial dispatch records its pre-worker boundary so a failed new session request can be closed safely', () => {
  const task = fixture(), specFile = path.join(task.stateDir, 'frozen-spec.json');
  writeJsonAtomic(specFile, { goal: 'Isolated first launch', background: 'Fixture startup recovery',
    inputs: [{ path: 'contract.md', purpose: 'Read-only fixture reference' }], allowedChanges: ['result.txt'],
    requirements: ['Do not run real tools'], acceptance: [{ command: 'node verify.cjs', expected: 'exit 0' }], deliverables: ['result.txt'] });
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/startup-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), 'dispatch', '--agent', 'cbc', '--task-id', 'first-launch-failed',
    '--worker-key', 'separate-binding', '--cwd', task.stateDir, '--session', 'test', '--workspace', 'test-workspace',
    '--spec-file', specFile], { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: task.stateDir,
      CODEX_THREAD_ID: '', HERDR_PANE_ID: '' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /HERDR_IPC_ACCESS_DENIED/);
  const saved = loadTask('first-launch-failed');
  assert.equal(saved.status, 'failed'); assert.equal(saved.round, 0); assert.equal(saved.submission, undefined);
  assert.equal(saved.startup.phase, 'checking-server'); assert.equal(saved.startup.workerEffectsPossible, false);
  assert.equal(saved.paneId, undefined); assert.equal(saved.workerSessionId, undefined);
  assert.equal(cancelNotStarted(saved).status, 'cancelled');
});
