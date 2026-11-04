'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { reconcileCancellation } = require('../lib/zcode-cancellation');
const { files } = require('../lib/zcode-readiness');
const { saveTask, loadTask, writeJsonAtomic } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');
const { assertSingleActive } = require('../lib/worker-scheduling');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-terminal-cancel-')); let counter = 0;
test.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dir = path.join(root, 'case-' + ++counter); process.env.AGENT_BRIDGE_STATE_DIR = dir;
  const task = { id: 'failed-command', agent: 'zcode', stateDir: dir, cwd: dir, workerSessionId: 'fixture-session',
    herdrSession: 'stub', paneId: 'closed-pane', terminalId: 'closed-terminal', status: 'cancel_pending', round: 2,
    submission: { status: 'observed' }, watcherPid: null, history: [{ round: 2, status: 'blocked' }] };
  const journal = { envelope: { type: 'sendText', sessionId: task.workerSessionId, commandId: 'current-command', payload: { text: 'fixture task' } },
    ack: { commandId: 'current-command', status: 'accepted', revisionAtDecision: 8,
      result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'current-command' } },
    status: 'terminal', turnState: 'failed', timestamp: '2026-11-04T00:00:02.000Z' };
  const observation = { taskId: task.id, round: 2, sessionId: task.workerSessionId, commandId: 'current-command',
    paneId: task.paneId, terminalId: task.terminalId, phase: 'error', timestamp: '2026-11-04T00:00:01.500Z',
    result: { seen: true, terminal: true, state: 'failed', evidence: 'snapshot', seq: 20, logEpoch: 'fixture-epoch', headerRowId: 11,
      header: { kind: 'turnHeader', sourceCommandId: 'current-command', rowId: 11, state: 'failed', endedAt: Date.parse('2026-11-04T00:00:01.000Z') },
      error: { source: 'provider', code: '1005', message: 'exceed quota limit', recoverable: true } } };
  const state = { taskId: task.id, round: 2, sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
    commandId: null, state: 'blocked', reason: 'stop_unconfirmed', workerPid: 99999991, originalExecutionMayContinue: true };
  const observationFile = path.join(dir, 'tasks', task.id, 'round-002-zcode-observation.json'), stateFile = path.join(dir, 'tasks', task.id, 'zcode-state.json');
  function persist() { saveTask(task); writeJsonAtomic(files(task).journal, journal); writeJsonAtomic(observationFile, observation); writeJsonAtomic(stateFile, state); }
  persist(); writeLease(task);
  const calls = [], livePanes = [];
  const dependencies = { alive: pid => pid === process.pid,
    createRemote: () => { throw new Error('Desktop must not be paired in this fixture'); },
    inspectPane: (_session, args) => {
      calls.push(args); if (args[1] === 'get') { const error = new Error('closed'); error.herdrCode = 'pane_not_found'; throw error; }
      if (args[1] === 'list') return { result: { panes: livePanes } };
      throw new Error('Unexpected terminal write');
    } };
  return { task, journal, observation, state, observationFile, stateFile, persist, dependencies, calls, livePanes };
}

test('exact current terminal provider failure plus closed executor releases only the cancellation, without Desktop or business writes', async () => {
  const f = fixture(), before = fs.readFileSync(files(f.task).journal), obsBefore = fs.readFileSync(f.observationFile);
  const result = await reconcileCancellation(f.task, f.dependencies);
  assert.equal(result.status, 'cancelled'); assert.equal(result.round, 2); assert.equal(result.workerSessionId, f.task.workerSessionId);
  assert.equal(result.cancellation.evidence.source, 'persisted-terminal-failure');
  assert.equal(result.cancellation.evidence.proof.errorCode, '1005');
  assert.equal(result.cancellation.evidence.proof.localWorkerExited, true);
  assert.equal(result.history[0].status, 'blocked'); assert.equal(result.history.at(-1).status, 'cancelled');
  assert.deepEqual(fs.readFileSync(files(f.task).journal), before); assert.deepEqual(fs.readFileSync(f.observationFile), obsBefore);
  assert.deepEqual(f.calls.map(args => args[1]), ['get', 'list', 'get', 'list']);
  assert.doesNotThrow(() => assertSingleActive({ id: 'new-cbc-task', stateDir: f.task.stateDir }));
});

test('old round, old command, other session, header or terminal mismatch never substitutes for the current command', async () => {
  for (const mutate of [f => { f.observation.round = 1; }, f => { f.observation.commandId = 'old-command'; },
    f => { f.observation.sessionId = 'other-session'; }, f => { f.observation.terminalId = 'other-terminal'; },
    f => { f.observation.result.header.sourceCommandId = 'old-command'; }, f => { f.journal.ack.commandId = 'old-command'; },
    f => { f.journal.ack.result.inputId = 'old-input'; }]) {
    const f = fixture(); mutate(f); f.persist();
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
    assert.deepEqual(f.calls, []);
  }
});

test('files, a quota message or closed Pane alone cannot prove authoritative terminal failure', async () => {
  for (const mutate of [r => { r.seen = false; }, r => { r.terminal = false; }, r => { r.state = 'running'; },
    r => { delete r.header; }, r => { r.header.kind = 'userText'; }, r => { delete r.header.endedAt; },
    r => { r.header.state = 'completedSuccess'; }, r => { r.evidence = 'local-file'; }, r => { delete r.seq; },
    r => { r.logEpoch = null; }, r => { r.headerRowId++; }]) {
    const f = fixture(); mutate(f.observation.result); f.persist();
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
    assert.deepEqual(f.calls, []);
  }
});

test('live watcher/worker, unknown submission, foreign command or ownership cannot be cleared', async () => {
  for (const variant of ['watcher', 'worker', 'submission', 'foreign-command', 'foreign-active', 'lease', 'owner']) {
    const f = fixture();
    if (variant === 'watcher') f.task.watcherPid = process.pid;
    if (variant === 'worker') f.state.workerPid = process.pid;
    if (variant === 'submission') f.task.submission.status = 'uncertain';
    if (variant === 'foreign-command') f.state.commandId = 'newer-command';
    if (variant === 'foreign-active') f.state.reason = 'untracked_command_active';
    f.persist();
    if (variant === 'lease') writeLease({ ...f.task, id: 'other-owner' });
    if (variant === 'owner') saveTask({ ...f.task, id: 'another-task', status: 'running' });
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending', variant);
    assert.deepEqual(f.calls, [], variant);
  }
});

test('live, moved or resumed endpoint and Herdr permission failure are not treated as a closed executor', async () => {
  for (const variant of ['present', 'moved', 'resumed', 'permission', 'malformed']) {
    const f = fixture(), inspect = f.dependencies.inspectPane;
    if (variant === 'moved') f.livePanes.push({ pane_id: 'moved-pane', terminal_id: f.task.terminalId });
    if (variant === 'resumed') f.livePanes.push({ pane_id: 'new-pane', terminal_id: 'new-terminal', agent_session: { value: f.task.workerSessionId } });
    f.dependencies.inspectPane = (session, args) => {
      if (variant === 'present') return {};
      if (variant === 'permission') { const e = new Error('Herdr IPC denied'); e.herdrCode = 'permission_denied'; throw e; }
      if (variant === 'malformed' && args[1] === 'list') return {};
      return inspect(session, args);
    };
    assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending', variant);
  }
});

test('Pane ID reused by a plain shell with a new terminal is not the original executor', async () => {
  const f = fixture(), shell = { pane_id: f.task.paneId, terminal_id: 'new-shell-terminal' };
  f.dependencies.inspectPane = (_session, args) => {
    f.calls.push(args);
    if (args[1] === 'get') return { result: { pane: shell } };
    if (args[1] === 'list') return { result: { panes: [shell] } };
    throw new Error('Unexpected Pane query');
  };
  const result = await reconcileCancellation(f.task, f.dependencies);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellation.evidence.proof.paneIdReusedByShell, true);
  assert.deepEqual(f.calls.map(args => args[1]), ['get', 'list', 'get', 'list']);
});

test('failed, interrupted, and successful exact terminal outcomes may close only the requested task', async () => {
  for (const state of ['failed', 'completedInterrupted', 'completedSuccess']) {
    const f = fixture(), endedAt = Date.parse('2026-11-04T00:00:01.000Z');
    f.journal.turnState = state;
    f.observation.phase = state === 'failed' ? 'error' : state;
    f.observation.result.state = state; f.observation.result.header.state = state;
    if (state !== 'failed') delete f.observation.result.error;
    f.persist();
    const result = await reconcileCancellation(f.task, f.dependencies);
    assert.equal(result.status, 'cancelled', state);
    assert.equal(result.cancellation.evidence.proof.state, state);
    assert.equal(result.cancellation.evidence.proof.endedAt, endedAt);
  }
});

test('terminal evidence is checked again before commit; a newer task binding is never overwritten', async () => {
  for (const variant of ['observation', 'new-round']) {
    const f = fixture(), inspect = f.dependencies.inspectPane; let count = 0;
    f.dependencies.inspectPane = (session, args) => {
      if (++count === 2) {
        if (variant === 'observation') writeJsonAtomic(f.observationFile, { ...f.observation, result: { ...f.observation.result, terminal: false } });
        else saveTask({ ...loadTask(f.task.id), round: 3, status: 'running' });
      }
      return inspect(session, args);
    };
    if (variant === 'new-round') {
      await assert.rejects(reconcileCancellation(f.task, f.dependencies), /binding changed/);
      assert.equal(loadTask(f.task.id).round, 3); assert.equal(loadTask(f.task.id).status, 'running');
    } else assert.equal((await reconcileCancellation(f.task, f.dependencies)).status, 'cancel_pending');
  }
});

test('official recover CLI confirms terminal failure using only read-only local Pane queries and no Relay', () => {
  const f = fixture(), transport = path.join(f.task.stateDir, 'transport.json');
  writeJsonAtomic(transport, { closedPane: true, connectionError: 'Desktop offline', calls: [] });
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-readiness-preload.cjs'),
    path.join(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id], { env: { ...process.env,
      AGENT_BRIDGE_STATE_DIR: f.task.stateDir, ZCODE_READY_TEST_STATE: transport }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(loadTask(f.task.id).status, 'cancelled');
  const calls = JSON.parse(fs.readFileSync(transport)).calls;
  assert.ok(calls.length > 0 && calls.every(call => call.op === 'herdr' && ['get', 'list'].includes(call.args[1])));
});
