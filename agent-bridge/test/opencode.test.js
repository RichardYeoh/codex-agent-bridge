'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configure, prepareWorker, snapshot, interrupt, submitWorker, modelRef, idleBelongsToRound, publish } = require('../lib/opencode');
const { getAgent } = require('../lib/agents');
const { applyReworkModel } = require('../bin/agent-bridge');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-opencode-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const task = { id: 'oc-test', agent: 'opencode', cwd: root, stateDir: root, herdrSession: 'test', paneId: 'w1:p1',
    workerPolicyPath: path.join(root, 'rules.md'), skipPermissions: true, workerSessionId: 'ses_original' };
  fs.writeFileSync(task.workerPolicyPath, 'Stable policy / 稳定规则');
  const calls = [];
  const info = { id: 'ses_original', location: { directory: root }, time: { idle: 123 } };
  const values = { 'session.get': info, 'session.active': {}, 'session.permission.list': [], 'session.form.list': [],
    'session.create': info, 'experimental.session.instructions.entry.list': [],
    'model.list': [{ providerID: 'p', id: 'm', variants: [{ id: 'max' }] }] };
  const request = (op, params, body) => { calls.push({ op, params, body }); return values[op] ?? null; };
  return { task, info, values, request, calls };
}

test('OpenCode preflight verifies exact restored ID without model prompts or global config writes', () => {
  const f = fixture(); prepareWorker(f.task, 'ses_original', f.request);
  assert.equal(f.task.workerSessionId, 'ses_original');
  assert.equal(f.calls.some(c => /prompt|config/.test(c.op)), false);
  assert.equal(f.calls.find(c => c.op.endsWith('entry.put')).body.value, 'Stable policy / 稳定规则');
  f.info.id = 'ses_different'; assert.throws(() => prepareWorker(f.task, 'ses_original', f.request), /mismatch/);
});

test('OpenCode rules are keyed and retained; occupied sessions and wrong directories reject dispatch', () => {
  const f = fixture(); f.values['experimental.session.instructions.entry.list'] = [{ key: 'codex-agent-bridge', value: 'Stable policy / 稳定规则' }];
  configure(f.task, f.request); assert.equal(f.calls.some(c => c.op.endsWith('entry.put')), false);
  f.values['session.active'] = { ses_original: { type: 'running' } };
  assert.throws(() => configure(f.task, f.request), /already running/);
  f.values['session.active'] = {}; f.info.location.directory = path.join(root, 'other');
  assert.throws(() => configure(f.task, f.request), /mismatch/);
});

test('OpenCode validates model variants against catalog instead of assuming max is supported', () => {
  const f = fixture(); f.task.model = 'p/m'; f.task.effort = 'max'; configure(f.task, f.request);
  assert.deepEqual(f.calls.find(c => c.op === 'session.switchModel').body.model, { providerID: 'p', id: 'm', variant: 'max' });
  f.task.effort = 'high'; assert.throws(() => configure(f.task, f.request), /catalog/);
  assert.throws(() => modelRef({ model: 'invalid' }), /provider\/model/);
});

test('OpenCode distinguishes active, pending approval, failure and confirmed interruption', () => {
  const f = fixture(); f.values['session.active'] = { ses_original: { type: 'running' } };
  assert.equal(snapshot(f.task, f.request).state, 'working');
  assert.throws(() => interrupt(f.task, f.request), /not confirmed/);
  f.values['session.permission.list'] = [{ id: 'permission-example' }];
  assert.equal(snapshot(f.task, f.request).reason, 'user_input_required');
  f.values['session.active'] = {}; f.values['session.permission.list'] = []; f.info.outcome = 'failed';
  assert.equal(snapshot(f.task, f.request).reason, 'execution_failed');
  f.info.outcome = 'interrupted'; interrupt(f.task, f.request);
  assert.equal(f.calls.find(c => c.op === 'session.interrupt').params.resume, 'false');
});

test('OpenCode preserves native TUI and uses an explicit recoverable session', () => {
  const worker = getAgent('opencode');
  assert.match(worker.buildCommand({ workerSessionId: 'ses_original' }), /opencode-worker\.js' 'ses_original'/);
  assert.throws(() => worker.buildCommand({}), /verified session/);
  assert.equal(worker.replayOnRelaunch, false);
});

test('OpenCode reattaches active sessions without changing rules, models or submitting messages', () => {
  const f = fixture(); f.values['session.active'] = { ses_original: { type: 'running' } };
  prepareWorker(f.task, 'ses_original', f.request);
  assert.equal(f.calls.some(c => /update|put|switchModel|prompt/.test(c.op)), false);
});

test('OpenCode submission uses stable admission identity and rejects an unrelated acknowledgment', () => {
  const f = fixture(); f.task.round = 2; const ids = [];
  const request = (op, params, body) => { assert.equal(op, 'session.prompt'); assert.equal(params.sessionID, 'ses_original'); ids.push(body.id); return { id: body.id }; };
  const reported = [];
  const report = (task, state) => reported.push(state);
  submitWorker(f.task, 'pointer', request, report); submitWorker(f.task, 'pointer', request, report);
  assert.equal(ids[0], ids[1]); f.task.round++; submitWorker(f.task, 'pointer', request, report); assert.notEqual(ids[1], ids[2]);
  assert.deepEqual(reported[0], { state: 'working', reason: 'admitted' });
  assert.throws(() => submitWorker(f.task, 'pointer', () => ({ id: 'msg_other' })), /mismatch/);
});

test('OpenCode native and ask permission modes are explicit session-only policies', () => {
  const f = fixture(); f.task.skipPermissions = false; f.task.permissionMode = 'ask'; configure(f.task, f.request);
  assert.deepEqual(f.calls.find(c => c.op === 'session.update').body.permissions, [{ action: '*', resource: '*', effect: 'ask' }]);
  f.task.permissionMode = 'unsupported'; assert.throws(() => configure(f.task, f.request), /permission-mode/);
});

test('OpenCode stale idle snapshots cannot settle a new round, including missing timestamps', () => {
  const task = { status: 'running', round: 2, history: [{ round: 2, status: 'submitted', timestamp: '2026-10-28T00:00:00Z' }] };
  const time = Date.parse(task.history[0].timestamp);
  assert.equal(idleBelongsToRound(task, { state: 'idle', idleAt: time - 1 }), false);
  assert.equal(idleBelongsToRound(task, { state: 'idle', idleAt: time + 1 }), true);
  assert.equal(idleBelongsToRound(task, { state: 'idle' }), false);
  assert.equal(idleBelongsToRound(task, { state: 'blocked' }), true);
});

test('OpenCode effort-only selection resolves the installed default model before validating variants', () => {
  const f = fixture(); f.task.effort = 'max'; f.values['model.default'] = { id: 'm', providerID: 'p' };
  configure(f.task, f.request);
  assert.deepEqual(f.calls.find(c => c.op === 'session.switchModel').body.model, { providerID: 'p', id: 'm', variant: 'max' });
});

test('OpenCode persistent dedup observes external refreshes and does not suppress the following completion', () => {
  const f = fixture(); f.task.round = 9; let count = 0;
  const report = () => count++;
  publish(f.task, { state: 'idle', idleAt: 99 }, report);
  publish(f.task, { state: 'idle', idleAt: 99 }, report);
  assert.equal(count, 1);
  publish(f.task, { state: 'working', reason: 'admitted' }, report);
  publish(f.task, { state: 'idle', idleAt: 99 }, report);
  assert.equal(count, 3);
});

test('OpenCode failed Herdr reports are retried instead of being cached as delivered', () => {
  const f = fixture(); f.task.round = 10;
  assert.throws(() => publish(f.task, { state: 'blocked' }, () => { throw new Error('offline'); }), /offline/);
  let sent = false;
  publish(f.task, { state: 'blocked' }, () => { sent = true; });
  assert.equal(sent, true);
});

test('oc quality rework switches the pinned model in the original session without carrying an incompatible variant', () => {
  const f = fixture();
  f.task.model = 'old/flash'; f.task.effort = 'legacy-variant';
  applyReworkModel(f.task, { model: 'p/m' });
  assert.equal(f.task.effort, null);
  assert.equal(f.task.workerSessionId, 'ses_original');
  configure(f.task, f.request);
  const switched = f.calls.find(c => c.op === 'session.switchModel');
  assert.deepEqual(switched.params, { sessionID: 'ses_original' });
  assert.deepEqual(switched.body.model, { providerID: 'p', id: 'm' });
  assert.equal(f.calls.some(c => /create|prompt|interrupt/.test(c.op)), false);
  applyReworkModel(f.task, {}); assert.equal(f.task.model, 'p/m');
  applyReworkModel(f.task, { effort: 'max' }); assert.equal(f.task.model, 'p/m');
  assert.equal(f.task.effort, 'max');
});

test('rework rejects unsupported agents and incomplete model options without changing state', () => {
  const f = fixture(); f.task.model = 'old/flash';
  assert.throws(() => applyReworkModel(f.task, { model: 'p/m', effort: '' }), /Missing --effort/);
  assert.equal(f.task.model, 'old/flash');
  for (const agent of ['cbc', 'agy', 'zcode']) {
    assert.throws(() => applyReworkModel({ agent }, { model: 'p/m' }), /only oc/);
  }
});
