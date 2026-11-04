'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  authorizePaneLessInterrupt, cancellationState, interrupt, turnFingerprint,
  reconcileSubmission, confirmReconciledSubmission, confirmCompletion, authorizeFailedRoundRetry, prepareFailedRoundRetry,
  submitFailedRoundRetry, MAX_FAILED_ROUND_RETRIES, snapshot,
} = require('../lib/opencode');
const { writeLease } = require('../lib/worker-lease');
const { saveTask, taskDir } = require('../lib/util');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-oc-adapter-'));
let counter = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ status = 'running', active = true, outcome = null } = {}) {
  const stateDir = path.join(root, `case-${++counter}`);
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const task = { id: `hark-oc-${counter}`, agent: 'opencode', cwd: stateDir, stateDir,
    workerSessionId: `ses_hark${counter}`, herdrSession: 'fixture', paneId: `w1:p${counter}`,
    terminalId: `term-${counter}`, workerStartedAt: new Date(Date.now() - 60000).toISOString(),
    round: 1, status, createdAt: new Date(Date.now() - 120000).toISOString(),
    history: [{ round: 1, status: 'submitted', timestamp: new Date(Date.now() - 60000).toISOString() }],
    opencodeSubmissionBaseline: { taskId: `hark-oc-${counter}`, round: 1, sessionId: `ses_hark${counter}`,
      cwd: stateDir, herdrSession: 'fixture', paneId: `w1:p${counter}`, terminalId: `term-${counter}`,
      outcome: null, idleAt: Date.now() - 30000 } };
  const admissionId = `msg_bridge_hark${counter}`;
  const dir = taskDir(task.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'round-001-opencode-admission.json'), JSON.stringify({
    id: admissionId, sessionId: task.workerSessionId, round: 1, status: 'confirmed',
    requestStartedAt: Date.now() - 10000, timestamp: Date.now() - 9000,
  }));
  saveTask(task); writeLease(task);
  const info = { id: task.workerSessionId, location: { directory: stateDir }, outcome,
    time: { idle: Date.now() - 1000, updated: Date.now() } };
  const values = { 'session.get': info, 'session.active': active ? { [task.workerSessionId]: { type: 'running' } } : {},
    'session.permission.list': [], 'session.form.list': [], 'session.inbox.list': [],
    'session.message.list': [{ id: `msg_asst_${counter}`, type: 'assistant' }, { id: admissionId, type: 'user' }] };
  const calls = [];
  const request = (op, params, body) => {
    calls.push({ op, params, body });
    if (op === 'session.prompt') return { id: body.id };
    if (op === 'session.message.get' && !values[op]) throw new Error('fixture message not found');
    return values[op] ?? null;
  };
  return { task, admissionId, info, values, request, calls };
}

test('pane-less interrupt authorization requires the exact lease, current bridge turn, and two stable native reads', () => {
  const f = fixture();
  const result = authorizePaneLessInterrupt(f.task, { request: f.request });
  assert.equal(result.admissionId, f.admissionId);
  assert.equal(result.binding.taskId, f.task.id);
  assert.equal(result.evidence.active, true);
  assert.match(result.turnFingerprint, /^oc-turn-v1-/);
  assert.equal(f.calls.filter(call => call.op === 'session.inbox.list').length, 2);
  assert.equal(f.calls.filter(call => call.op === 'session.message.list').length, 2);
  assert.equal(f.calls.some(call => ['session.interrupt', 'session.permission.reply', 'session.form.reply'].includes(call.op)), false);
});

test('late delivery requires this admission successful terminal twice; queued or old success is insufficient', () => {
  const f = fixture({ active: false, outcome: 'success' });
  assert.equal(confirmCompletion(f.task, { request: f.request }).confirmed, true);
  assert.equal(f.calls.filter(item => item.op === 'session.get').length, 2);
  for (const mutate of [
    g => { g.info.time.idle = Date.now() - 120000; },
    g => { g.info.outcome = 'failed'; },
    g => { g.info.outcome = undefined; },
    g => { g.values['session.inbox.list'] = [{ id: g.admissionId, sessionID: g.task.workerSessionId, type: 'user' }]; },
    g => { g.values['session.message.list'].unshift({ id: 'external', type: 'user' }); },
    g => { g.values['session.active'] = { [g.task.workerSessionId]: {} }; },
  ]) {
    const g = fixture({ active: false, outcome: 'success' }); mutate(g);
    assert.throws(() => confirmCompletion(g.task, { request: g.request }));
    assert.equal(g.calls.some(item => item.op === 'session.prompt' || item.op === 'session.interrupt'), false);
  }
});

test('an admitted same-round retry never reuses the previous failed snapshot as its own failure', () => {
  const f = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  const authorization = authorizeFailedRoundRetry(f.task, { request: f.request });
  const prepared = prepareFailedRoundRetry(f.task, { ...authorization, expectedFingerprint: authorization.turnFingerprint, request: f.request });
  submitFailedRoundRetry(f.task, 'same brief pointer', { ...authorization, expectedFingerprint: authorization.turnFingerprint, request: f.request, report: () => {} });
  f.task.opencodeRetry = { round: 1, status: 'confirmed', admissionId: prepared.id };
  f.task.status = 'running';
  assert.equal(snapshot(f.task, f.request).reason, 'awaiting_retry_execution');
  f.info.time.idle = Date.now() + 100;
  assert.equal(snapshot(f.task, f.request).reason, 'execution_failed');
});

test('a formally restored terminal can retry the same native round without mutating its historical baseline', () => {
  const f = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  const baseline = JSON.stringify(f.task.opencodeSubmissionBaseline);
  f.task.workerLifecycle = { phase: 'adopted', previous: { paneId: f.task.paneId, terminalId: f.task.terminalId, workerSessionId: f.task.workerSessionId } };
  f.task.restoredContextSessionId = f.task.workerSessionId;
  f.task.paneId = 'new-pane'; f.task.terminalId = 'new-terminal'; saveTask(f.task); writeLease(f.task);
  assert.equal(authorizeFailedRoundRetry(f.task, { request: f.request }).attemptNumber, 1);
  assert.equal(JSON.stringify(f.task.opencodeSubmissionBaseline), baseline);
  f.task.workerLifecycle.previous.workerSessionId = 'wrong';
  assert.throws(() => authorizeFailedRoundRetry(f.task, { request: f.request }), /baseline binding/);
});

test('pane-less interrupt authorization rejects a reassigned lease, another owner, approvals, forms, and external inputs', () => {
  const cases = [
    { reason: /lease mismatch/, change: f => writeLease({ ...f.task, terminalId: 'term-other' }) },
    { reason: /another unresolved task owner/, change: f => saveTask({ ...f.task, id: 'hark-oc-other', status: 'running' }) },
    { reason: /explicit user input.*permission:per_hark/, change: f => { f.values['session.permission.list'] = [{ id: 'per_hark' }]; } },
    { reason: /explicit user input.*form:form_hark/, change: f => { f.values['session.form.list'] = [{ id: 'form_hark' }]; } },
    { reason: /queued native input.*user:msg_external/, change: f => { f.values['session.inbox.list'] = [{ id: 'msg_external', sessionID: f.task.workerSessionId, type: 'user' }]; } },
    { reason: /current bridge admission/, change: f => { f.values['session.message.list'] = [{ id: 'msg_external', type: 'user' }]; } },
    { reason: /current bridge admission/, change: f => { f.values['session.message.list'].unshift({ id: 'shell_external', type: 'shell' }); } },
    { reason: /mismatch/, change: f => { f.info.location.directory = path.join(f.task.cwd, 'other'); } },
  ];
  for (const item of cases) {
    const f = fixture(); item.change(f);
    assert.throws(() => authorizePaneLessInterrupt(f.task, { request: f.request }), item.reason);
    assert.equal(f.calls.some(call => ['session.interrupt', 'session.permission.reply', 'session.form.reply', 'session.inbox.cancel'].includes(call.op)), false);
  }
});

test('native turn fingerprint stays stable for assistant progress and changes on a newer user or shell input', () => {
  const f = fixture();
  const first = turnFingerprint(f.task, { request: f.request });
  f.values['session.message.list'].unshift({ id: 'msg_asst_next', type: 'assistant' });
  assert.equal(turnFingerprint(f.task, { request: f.request }), first);
  f.values['session.message.list'].unshift({ id: 'msg_manual', type: 'user' });
  assert.throws(() => turnFingerprint(f.task, { request: f.request }), /current bridge admission/);
  f.values['session.message.list'] = [{ id: 'shell_manual', type: 'shell' }, { id: f.admissionId, type: 'user' }];
  assert.throws(() => turnFingerprint(f.task, { request: f.request }), /current bridge admission/);
});

test('cancellation treats queued input as active and removes only the current bridge admission', () => {
  const f = fixture({ active: false });
  f.values['session.inbox.list'] = [{ id: f.admissionId, sessionID: f.task.workerSessionId, type: 'user' }];
  assert.equal(cancellationState(f.task, f.request).reason, 'native_input_queued');
  f.request = (op, params, body) => {
    f.calls.push({ op, params, body });
    if (op === 'session.inbox.cancel') { f.values['session.inbox.list'] = []; return null; }
    if (op === 'session.message.get' && !f.values[op]) throw new Error('fixture message not found');
    return f.values[op] ?? null;
  };
  const result = interrupt(f.task, f.request);
  assert.equal(result.confirmed, true);
  assert.equal(f.calls.filter(call => call.op === 'session.inbox.cancel').length, 1);
  assert.equal(f.calls.some(call => call.op === 'session.interrupt'), false);
});

test('cancellation never replies to approvals or removes external queued input', () => {
  const approval = fixture({ active: true }); approval.values['session.permission.list'] = [{ id: 'per_manual' }];
  assert.throws(() => interrupt(approval.task, approval.request), /explicit native input resolution: per_manual/);
  assert.equal(approval.calls.some(call => /permission\.reply|interrupt/.test(call.op)), false);

  const external = fixture({ active: false });
  external.values['session.inbox.list'] = [{ id: 'msg_manual', sessionID: external.task.workerSessionId, type: 'user' }];
  assert.throws(() => interrupt(external.task, external.request), /will not remove external/);
  assert.equal(external.calls.some(call => ['session.inbox.cancel', 'session.interrupt'].includes(call.op)), false);
});

test('submission reconciliation reads the native inbox and exact message ID without resubmitting', () => {
  const f = fixture({ active: false });
  f.values['session.inbox.list'] = [{ id: f.admissionId, sessionID: f.task.workerSessionId, type: 'user' }];
  let result = reconcileSubmission(f.task, { request: f.request });
  assert.equal(result.state, 'admitted'); assert.equal(result.via, 'inbox');
  assert.equal(f.calls.some(call => call.op === 'session.prompt'), false);

  f.values['session.inbox.list'] = [];
  f.values['session.message.get'] = { id: f.admissionId, type: 'user' };
  result = reconcileSubmission(f.task, { request: f.request });
  assert.equal(result.state, 'admitted'); assert.equal(result.via, 'message');
  assert.equal(f.calls.some(call => call.op === 'session.prompt'), false);

  delete f.values['session.message.get'];
  f.calls.length = 0;
  result = reconcileSubmission(f.task, { request: f.request });
  assert.equal(result.state, 'unresolved');
  assert.equal(f.calls.some(call => call.op === 'session.prompt'), false);
});

test('only a persisted prepared journal proves that no native prompt request started', () => {
  const f = fixture({ active: false });
  const file = path.join(taskDir(f.task.id), 'round-001-opencode-admission.json');
  fs.writeFileSync(file, JSON.stringify({ id: f.admissionId, sessionId: f.task.workerSessionId,
    round: 1, status: 'prepared', timestamp: Date.now() }));
  const result = reconcileSubmission(f.task, { request: f.request });
  assert.equal(result.state, 'not_sent'); assert.equal(result.noRequestStarted, true);
});

test('failed-round retries require a newer native failed terminal and use one persisted stable ID per explicit attempt', () => {
  const f = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  const auth = authorizeFailedRoundRetry(f.task, { request: f.request });
  assert.equal(auth.attemptNumber, 1); assert.equal(auth.maxAttempts, MAX_FAILED_ROUND_RETRIES);
  assert.notEqual(auth.admissionId, f.admissionId);
  const prepared = prepareFailedRoundRetry(f.task, { attemptNumber: 1, expectedFingerprint: auth.turnFingerprint, request: f.request });
  assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).status, 'prepared');
  assert.deepEqual(prepareFailedRoundRetry(f.task, { attemptNumber: 1, expectedFingerprint: auth.turnFingerprint, request: f.request }), prepared);
  assert.throws(() => authorizeFailedRoundRetry(f.task, { attemptNumber: 2, request: f.request }), /already prepared/);
  const reports = [];
  const result = submitFailedRoundRetry(f.task, 'same round task text', { attemptNumber: 1,
    expectedFingerprint: auth.turnFingerprint, request: f.request, report: (_task, state) => reports.push(state) });
  assert.equal(result.id, prepared.id);
  assert.equal(f.calls.filter(call => call.op === 'session.prompt').length, 1);
  assert.equal(f.calls.find(call => call.op === 'session.prompt').body.id, prepared.id);
  assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).status, 'confirmed');
  assert.deepEqual(reports, [{ state: 'working', reason: 'failed_round_retry_admitted', admissionId: prepared.id, attemptNumber: 1 }]);
});

test('a lost retry acknowledgement leaves its ID sending and cannot prepare another ID or retry number', () => {
  const f = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  const auth = authorizeFailedRoundRetry(f.task, { request: f.request });
  const prepared = prepareFailedRoundRetry(f.task, { attemptNumber: 1, expectedFingerprint: auth.turnFingerprint, request: f.request });
  const request = (op, params, body) => {
    f.calls.push({ op, params, body });
    if (op === 'session.prompt') throw Object.assign(new Error('ack lost'), { code: 'ETIMEDOUT' });
    if (op === 'session.message.get') throw new Error('fixture message not found');
    return f.request(op, params, body);
  };
  assert.throws(() => submitFailedRoundRetry(f.task, 'same round task text', { attemptNumber: 1,
    expectedFingerprint: auth.turnFingerprint, request, report: () => {} }), /ack lost/);
  assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).status, 'sending');
  assert.equal(reconcileSubmission(f.task, { request }).state, 'unresolved');
  assert.throws(() => prepareFailedRoundRetry(f.task, { attemptNumber: 2, request }), /latest bridge-owned input/);
  assert.equal(f.calls.filter(call => call.op === 'session.prompt').length, 1);
});

test('recovered admitted retry confirms only its exact journal and remains eligible for the next failed attempt', () => {
  const f = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  const auth = authorizeFailedRoundRetry(f.task, { request: f.request });
  const prepared = prepareFailedRoundRetry(f.task, { attemptNumber: 1,
    expectedFingerprint: auth.turnFingerprint, request: f.request });
  const request = (op, params, body) => {
    f.calls.push({ op, params, body });
    if (op === 'session.prompt') {
      f.values['session.inbox.list'] = [{ id: body.id, type: 'user', sessionID: f.task.workerSessionId }];
      throw new Error('admission accepted but acknowledgement lost');
    }
    return f.request(op, params, body);
  };

  assert.throws(() => submitFailedRoundRetry(f.task, 'same round task text', { attemptNumber: 1,
    expectedFingerprint: auth.turnFingerprint, request, report: () => {} }), /acknowledgement lost/);
  assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).status, 'sending');
  const evidence = reconcileSubmission(f.task, { request });
  assert.equal(evidence.state, 'admitted');
  assert.equal(evidence.via, 'inbox');
  assert.equal(evidence.attemptNumber, 1);
  const confirmed = confirmReconciledSubmission(f.task, evidence);
  assert.equal(confirmed.admissionId, prepared.id);
  assert.equal(confirmed.status, 'confirmed');
  const journal = JSON.parse(fs.readFileSync(prepared.file, 'utf8'));
  assert.equal(journal.status, 'confirmed');
  assert.equal(journal.reconciledVia, 'inbox');

  f.values['session.inbox.list'] = [];
  f.values['session.message.list'] = [{ id: prepared.id, type: 'user' }];
  f.info.time.idle = Date.now() + 1000;
  const next = authorizeFailedRoundRetry(f.task, { request: f.request });
  assert.equal(next.attemptNumber, 2);
  assert.notEqual(next.admissionId, prepared.id);
  assert.equal(f.calls.filter(call => call.op === 'session.prompt').length, 1);
});

test('reconciled admission confirmation rejects wrong round, session, ID, or non-admitted evidence without journal mutation', () => {
  const f = fixture({ active: false });
  f.values['session.inbox.list'] = [{ id: f.admissionId, sessionID: f.task.workerSessionId, type: 'user' }];
  const evidence = reconcileSubmission(f.task, { request: f.request });
  const file = path.join(taskDir(f.task.id), 'round-001-opencode-admission.json');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  journal.status = 'sending';
  fs.writeFileSync(file, JSON.stringify(journal));
  for (const altered of [
    { ...evidence, round: evidence.round + 1 },
    { ...evidence, sessionId: 'ses_wrong' },
    { ...evidence, admissionId: 'msg_bridge_wrong' },
    { ...evidence, state: 'unresolved' },
  ]) {
    assert.throws(() => confirmReconciledSubmission(f.task, altered));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'sending');
  }
  confirmReconciledSubmission(f.task, evidence);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'confirmed');
});

test('failed retry cannot start from the same prior failure, an approval, external input, or a changed binding', () => {
  const noNewFailure = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  noNewFailure.info.time.idle = noNewFailure.task.opencodeSubmissionBaseline.idleAt;
  assert.throws(() => authorizeFailedRoundRetry(noNewFailure.task, { request: noNewFailure.request }), /new native failed terminal/);

  for (const mutate of [
    f => { f.values['session.permission.list'] = [{ id: 'per' }]; },
    f => { f.values['session.form.list'] = [{ id: 'form' }]; },
    f => { f.values['session.inbox.list'] = [{ id: 'msg_external', sessionID: f.task.workerSessionId, type: 'user' }]; },
    f => { f.values['session.message.list'].unshift({ id: 'msg_external', type: 'user' }); },
    f => { f.task.opencodeSubmissionBaseline.terminalId = 'other-terminal'; },
  ]) {
    const f = fixture({ status: 'blocked', active: false, outcome: 'failed' }); mutate(f);
    assert.throws(() => authorizeFailedRoundRetry(f.task, { request: f.request }));
  }
  const capped = fixture({ status: 'blocked', active: false, outcome: 'failed' });
  assert.throws(() => authorizeFailedRoundRetry(capped.task, { attemptNumber: MAX_FAILED_ROUND_RETRIES + 1, request: capped.request }), /maximum/);
});
