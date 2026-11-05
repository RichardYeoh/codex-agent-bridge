'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveTask, writeJsonAtomic, taskDir, loadTask } = require('../lib/util');
const { files } = require('../lib/zcode-readiness');
const { cancelWorker, cancellationState, inspectAbandonment, reconcileCancellation,
  rejectedCommandEvidence, unsubmittedRoundZeroEvidence } = require('../lib/zcode-cancellation');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-zcode-cancellation-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function taskFixture(id, extra = {}) {
  const task = { id, stateDir: root, cwd: root, agent: 'zcode', herdrSession: 'isolated-herdr',
    paneId: 'fixture-pane', terminalId: 'fixture-terminal', workerSessionId: 'fixture-session', round: 1,
    status: 'blocked', submission: { status: 'observed' }, watcherPid: null, history: [],
    zcodeBindingSha256: 'fixture-binding-hash', allowedWritePaths: ['src/module.js'], ...extra };
  saveTask(task);
  const state = { taskId: task.id, round: task.round, sessionId: task.workerSessionId ?? null,
    paneId: task.paneId ?? null, terminalId: task.terminalId ?? null, commandId: null,
    state: 'blocked', reason: 'observer_unavailable', workerPid: 99999991 };
  writeJsonAtomic(path.join(taskDir(task.id), 'zcode-state.json'), state);
  return task;
}

test('round zero with no captured session closes only when createSession is absent or still prepared and local worker exited', async () => {
  const task = taskFixture('z0-not-submitted', { round: 0, status: 'cancel_pending', workerSessionId: null, submission: null });
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json');
  writeJsonAtomic(stateFile, { ...JSON.parse(fs.readFileSync(stateFile)), sessionId: null, round: 0 });
  assert.equal(unsubmittedRoundZeroEvidence(task, { alive: () => false }).source, 'local-not-submitted');
  const result = await cancellationState(task, { alive: () => false,
    createRemote: () => { throw new Error('No Relay connection expected'); } });
  assert.equal(result.confirmed, true); assert.equal(result.source, 'local-not-submitted');
  assert.equal(loadTask(task.id).status, 'cancel_pending');

  const prepared = taskFixture('z0-prepared', { round: 0, status: 'cancel_pending', workerSessionId: null, submission: null });
  const create = { envelope: { type: 'createSession', commandId: 'never-sent', sessionId: null }, status: 'prepared' };
  writeJsonAtomic(path.join(taskDir(prepared.id), 'zcode-create.json'), create);
  const preparedState = path.join(taskDir(prepared.id), 'zcode-state.json');
  writeJsonAtomic(preparedState, { ...JSON.parse(fs.readFileSync(preparedState)), sessionId: null, round: 0 });
  assert.equal(unsubmittedRoundZeroEvidence(prepared, { alive: () => false }).confirmed, true);

  const sending = taskFixture('z0-sending', { round: 0, status: 'cancel_pending', workerSessionId: null, submission: null });
  writeJsonAtomic(path.join(taskDir(sending.id), 'zcode-create.json'), { ...create, status: 'sending' });
  const sendingState = path.join(taskDir(sending.id), 'zcode-state.json');
  writeJsonAtomic(sendingState, { ...JSON.parse(fs.readFileSync(sendingState)), sessionId: null, round: 0 });
  assert.equal(unsubmittedRoundZeroEvidence(sending, { alive: () => false }), null);
});

test('unknown command abandonment assessment is local-only, requires dead worker/watcher, and retains resource fences', () => {
  const task = taskFixture('z1-unknown', { status: 'cancel_pending' });
  const envelope = { type: 'sendText', commandId: 'unknown-command', sessionId: task.workerSessionId,
    payload: { text: 'do not inspect or replay' } };
  writeJsonAtomic(files(task).journal, { envelope, status: 'sending', timestamp: '2026-11-04T00:00:00.000Z' });
  const result = inspectAbandonment(task, { alive: () => false });
  assert.equal(result.eligible, true); assert.equal(result.originalExecutionMayContinue, true);
  assert.equal(result.commandId, 'unknown-command');
  assert.deepEqual(result.resourceBinding.allowedWritePaths, ['src/module.js']);
  assert.equal(result.resourceBinding.zcodeBindingSha256, 'fixture-binding-hash');
  assert.equal(result.proof.roundJournalStatus, 'sending');
  assert.match(result.scope, /retain resource quarantine/);
  assert.equal(loadTask(task.id).status, 'cancel_pending');
  assert.throws(() => inspectAbandonment(task, { alive: pid => pid === 99999991 }), /worker exit is unconfirmed/);
});

test('rejected inbox ACKs with non-runtime reasons are command-scoped offline evidence', () => {
  for (const [status, reasonCode] of [['failed', 'quotaExceeded'], ['rejected', 'sessionBusy']]) {
    const task = taskFixture(`z08-${status}`, { status: 'cancel_pending', workerSessionId: `fixture-session-${status}` });
    const envelope = { type: 'sendText', commandId: `${status}-command`, sessionId: task.workerSessionId,
      payload: { text: 'never replay' } };
    writeJsonAtomic(files(task).journal, { envelope, status: 'acknowledged', timestamp: '2026-11-04T00:00:00.000Z',
      ack: { commandId: envelope.commandId, status, reasonCode, revisionAtDecision: 2, result: null } });
    const stateFile = path.join(taskDir(task.id), 'zcode-state.json');
    writeJsonAtomic(stateFile, { ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), commandId: envelope.commandId,
      reason: reasonCode });
    const proof = rejectedCommandEvidence(task, { alive: () => false });
    assert.equal(proof.confirmed, true); assert.equal(proof.source, 'persisted-command-ack');
    assert.equal(proof.nativeBinding.commandId, envelope.commandId);
    assert.match(proof.scope, /session-wide quiescence not asserted/);
  }
});

test('failed admission still closes offline after the worker writes a null stop_unconfirmed projection', async () => {
  const task = taskFixture('z02-stop-projection', { status: 'cancel_pending', workerSessionId: 'fixture-session-z02' });
  const envelope = { type: 'sendText', commandId: 'rejected-command', sessionId: task.workerSessionId,
    payload: { text: 'never admitted' } };
  writeJsonAtomic(files(task).journal, { envelope, status: 'acknowledged', timestamp: '2026-11-04T00:00:00.000Z',
    ack: { commandId: envelope.commandId, status: 'failed', reasonCode: 'modelUnavailable', revisionAtDecision: 0, result: null } });
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json');
  writeJsonAtomic(stateFile, { ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), commandId: null,
    state: 'blocked', reason: 'stop_unconfirmed' });
  const proof = rejectedCommandEvidence(task, { alive: () => false });
  assert.equal(proof.confirmed, true); assert.equal(proof.nativeBinding.commandId, envelope.commandId);
  const result = await reconcileCancellation(task, { alive: () => false });
  assert.equal(result.status, 'cancelled'); assert.equal(result.cancellation.evidence.source, 'persisted-command-ack');
});

test('automatic cancellation refuses the unscoped V4 stop without sending any native operation', async () => {
  const task = taskFixture('z06-no-stop', { status: 'cancel_pending' });
  const envelope = { type: 'sendText', commandId: 'bound-command', sessionId: task.workerSessionId,
    payload: { text: 'never stop the whole session' } };
  writeJsonAtomic(files(task).journal, { envelope, status: 'sending' });
  await assert.rejects(cancelWorker(task), /session-wide and cannot be atomically scoped/);
  assert.equal(loadTask(task.id).status, 'cancel_pending');
});

test('round one with no journal can be assessed for coordination exit without asserting native completion', () => {
  const task = taskFixture('z1-no-journal', { status: 'blocked' });
  const result = inspectAbandonment(task, { alive: () => false });
  assert.equal(result.eligible, true); assert.equal(result.commandId, null);
  assert.equal(result.originalExecutionMayContinue, true);
  assert.equal(result.proof.roundJournalStatus, 'absent');
  assert.match(result.scope, /retain resource quarantine/);
});

test('local abandonment assessment rejects changed round and active watcher without reading Relay configuration', () => {
  const task = taskFixture('z1-binding-change', { status: 'blocked' });
  assert.throws(() => inspectAbandonment({ ...task, round: 2 }, { alive: () => false }), /binding changed/);
  assert.throws(() => inspectAbandonment({ ...task, watcherPid: 7 }, { alive: pid => pid === 7 }), /watcher is still active/);
});
