'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { saveTask, loadTask } = require('../lib/util');
const { recordContext, preparePromptContext, tryReuseContext, listContexts, observedContext, contextPath, projectKey, loadContext } = require('../lib/worker-context');
const { writeWorkerPolicy, normalizeTaskSpec, renderTaskSpec } = require('../lib/worker-policy');
const { writeLease, leaseForEvent } = require('../lib/worker-lease');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-context-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const spec = { goal: 'Add a marker', background: 'Stable project background',
  inputs: [{ path: 'README.md', purpose: 'Project conventions' }], allowedChanges: ['marker.txt'],
  requirements: ['Write the exact marker'], acceptance: [{ command: 'node verify.cjs', expected: 'exit 0' }],
  deliverables: ['marker.txt'] };
function value(id) {
  return { id, stateDir: root, cwd: root, agent: 'cbc', herdrSession: 'test', paneId: 'w1:p1',
    workspaceId: 'w1', tabId: 'w1:t1', terminalId: 'term-1', workerSessionId: 'session-1',
    taskSpec: normalizeTaskSpec(spec), round: 1, status: 'review_pending', history: [],
    submission: { status: 'observed' }, skipPermissions: true, permissionMode: 'acceptEdits' };
}
test('normalized task specs round-trip through persistence and rendering', () => {
  const normalized = normalizeTaskSpec(spec);
  assert.deepEqual(normalizeTaskSpec(JSON.parse(JSON.stringify(normalized))), normalized);
  assert.match(renderTaskSpec(normalized), /Stable project background/);
});
test('an observed submission is not a context receipt until a delivery is available', () => {
  const task = value('context-not-delivered'); task.status = 'running';
  writeWorkerPolicy(task); recordContext(task);
  assert.equal(listContexts(root, 'cbc').length, 0);
});
test('context reuse requires the actual session, project and current policy receipt', () => {
  const task = value('context-first');
  writeWorkerPolicy(task); preparePromptContext(task, spec.goal);
  assert.equal(task.promptContext.mode, 'full');
  recordContext(task);
  task.round = 2; preparePromptContext(task, 'Correct the marker');
  assert.equal(task.promptContext.mode, 'delta');
  task.workerSessionId = 'session-other'; preparePromptContext(task, 'Other session');
  assert.equal(task.promptContext.mode, 'full');
  task.workerSessionId = 'session-1'; task.contextInvalidatedAt = '2999-01-01T00:00:00Z';
  preparePromptContext(task, 'After compact');
  assert.equal(task.promptContext.mode, 'full');
  delete task.contextInvalidatedAt;
  task.taskSpec.background = 'A different project context'; preparePromptContext(task, 'Changed baseline');
  assert.equal(task.promptContext.mode, 'full');
});
test('accepted worker is reused only after live session attestation and scope matching', () => {
  const previous = value('context-accepted'); previous.status = 'accepted';
  writeWorkerPolicy(previous); saveTask(previous); recordContext(previous);
  const fresh = value('context-next'); fresh.placement = { mode: 'tab', workspaceId: 'w1' };
  delete fresh.workerSessionId;
  const options = { inspect: () => ({ agent: 'codebuddy', agent_status: 'idle', terminal_id: 'term-1' }),
    attest: () => ({ sessionId: 'session-1' }),
    call: (session, args) => args[0] === 'pane'
      ? { result: { pane: { workspace_id: 'w1', agent_session: { value: 'session-1' } } } }
      : { result: { agents: [] } } };
  assert.equal(tryReuseContext(fresh, options), true);
  assert.equal(fresh.workerSessionId, previous.workerSessionId);
  assert.equal(loadTask(fresh.id).reusedFromTaskId, previous.id);
  assert.equal(leaseForEvent(root, 'test', 'w1:p1', 'session-1').taskId, fresh.id);
  assert.equal(leaseForEvent(root, 'test', 'w1:p1', 'replacement'), null);
  const other = value('context-other'); other.placement = { mode: 'tab', workspaceId: 'w2' };
  assert.equal(tryReuseContext(other, options), false);
  const replaced = { ...options, attest: () => ({ sessionId: 'replacement' }) };
  assert.throws(() => tryReuseContext(value('context-replaced'), replaced), /session changed/);
  assert.equal(listContexts(root, 'cbc').length, 1);
  assert.equal(listContexts(path.join(root, 'other-project'), 'cbc').length, 0);
  const inherited = value('context-profile'); inherited.permissionExplicit = false;
  inherited.skipPermissions = false; inherited.permissionMode = 'different-default';
  assert.equal(tryReuseContext(inherited, options), true);
  assert.equal(inherited.skipPermissions, previous.skipPermissions);
  assert.equal(inherited.permissionMode, previous.permissionMode);
});

test('opaque work-context bindings preserve independent sessions without a role taxonomy', () => {
  const first = value('context-stream-one'); first.workerKey = '模块A连续调试'; first.workerSessionId = 'stream-one'; first.status = 'accepted';
  writeWorkerPolicy(first); recordContext(first);
  const second = value('context-stream-two'); second.workerKey = 'independent-check'; second.workerSessionId = 'stream-two'; second.status = 'accepted';
  writeWorkerPolicy(second); recordContext(second);
  assert.notEqual(contextPath(first), contextPath(second));
  assert.equal(loadContext(first).workerSessionId, 'stream-one');
  assert.equal(loadContext(second).workerSessionId, 'stream-two');
  assert.equal(listContexts(root, 'cbc', '模块A连续调试').length, 1);
  second.workerKey = 'unseen'; assert.equal(loadContext(second), null);
});

test('closed panes plan native session restoration while transport failures never fork sessions', () => {
  const prior = value('context-cold-prior'); prior.workerKey = 'cold-check'; prior.status = 'accepted';
  writeWorkerPolicy(prior); saveTask(prior); recordContext(prior);
  const candidate = value('context-cold-next'); candidate.workerKey = prior.workerKey;
  candidate.placement = { mode: 'pane', anchorPaneId: 'w1:main', workspaceId: 'w1' };
  const missing = Object.assign(new Error('closed'), { herdrCode: 'pane_not_found' });
  assert.equal(tryReuseContext(candidate, { inspect: () => { throw missing; }, call: () => ({ result: { agents: [] } }) }), false);
  assert.equal(candidate.resumeContextSessionId, prior.workerSessionId);
  assert.equal(candidate.mainPaneId, 'w1:main');
  candidate.terminalId = 'new-terminal'; candidate.restoredContextSessionId = prior.workerSessionId;
  writeWorkerPolicy(candidate); preparePromptContext(candidate, 'Continue after reopening');
  assert.equal(candidate.promptContext.mode, 'delta');
  assert.throws(() => tryReuseContext(candidate, { inspect: () => { throw new Error('connection failed'); } }), /connection failed/);
  assert.throws(() => tryReuseContext(candidate, { inspect: () => { throw missing; },
    call: () => ({ result: { agents: [{ terminal_id: prior.terminalId }] } }) }), /still present/);
});

test('legacy project receipts are reusable only through the default binding', () => {
  const task = value('context-legacy'); task.cwd = path.join(root, 'legacy-project');
  const legacy = path.join(root, 'worker-contexts', projectKey(task.cwd, task.agent, task.herdrSession) + '.json');
  fs.writeFileSync(legacy, JSON.stringify({ ...task, lastTaskId: task.id }));
  assert.equal(loadContext(task).workerSessionId, task.workerSessionId);
  task.workerKey = 'other-context'; assert.equal(loadContext(task), null);
});
test('lease changes the active task without reusing the previous task identity', () => {
  const task = value('lease-first'); writeLease(task);
  task.id = 'lease-next'; writeLease(task);
  assert.equal(leaseForEvent(root, 'test', 'w1:p1', 'session-1').taskId, 'lease-next');
  assert.equal(leaseForEvent(root, 'different-server', 'w1:p1', 'session-1'), null);
});

test('delta carries all new optional constraints and compact receipts survive later tool events', () => {
  const task = value('context-constraints');
  task.taskSpec = normalizeTaskSpec({ ...spec, nonGoals: ['No network'], stopConditions: ['Stop on missing input'],
    followupChanges: ['Keep prior public API'] });
  writeWorkerPolicy(task); recordContext(task); preparePromptContext(task, 'Next');
  assert.match(task.promptContext.delta.join('\n'), /No network/);
  assert.match(task.promptContext.delta.join('\n'), /Stop on missing input/);
  assert.match(task.promptContext.delta.join('\n'), /Keep prior public API/);
  const receipt = { herdrSession: 'test', paneId: 'w1:p1', sessionId: 'session-1', timestamp: '2026-01-02', source: 'compact' };
  fs.writeFileSync(path.join(root, 'hook-events.ndjson'), [receipt, { ...receipt, timestamp: '2026-01-03', source: 'tool' },
    { ...receipt, herdrSession: 'other', sessionId: 'wrong' }].map(JSON.stringify).join('\n'));
  assert.deepEqual(observedContext(task), { sessionId: 'session-1', compactAt: '2026-01-02' });
  fs.appendFileSync(path.join(root, 'hook-events.ndjson'), '\n' + JSON.stringify({ ...receipt, source: 'start', sessionId: 'replacement' }));
  assert.equal(observedContext(task).sessionId, 'replacement');
});
