'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { saveTask, loadTask } = require('../lib/util');
const { recordContext, preparePromptContext, tryReuseContext, listContexts, observedContext } = require('../lib/worker-context');
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
  assert.equal(tryReuseContext(value('context-replaced'), replaced), false);
  assert.equal(listContexts(root, 'cbc').length, 1);
  assert.equal(listContexts(path.join(root, 'other-project'), 'cbc').length, 0);
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
