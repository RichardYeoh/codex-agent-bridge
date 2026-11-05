'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-v2-recovery-'));
const originalEnv = Object.fromEntries(['AGENT_BRIDGE_STATE_DIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']
  .map(key => [key, process.env[key]]));
process.env.AGENT_BRIDGE_STATE_DIR = path.join(root, 'state');
process.env.USERPROFILE = path.join(root, 'home');
process.env.HOME = path.join(root, 'home');
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
for (const directory of [process.env.AGENT_BRIDGE_STATE_DIR, process.env.USERPROFILE,
  process.env.LOCALAPPDATA, process.env.APPDATA]) fs.mkdirSync(directory, { recursive: true });

const stubState = { watcherStarts: [], apiCalls: [], notifications: [], notificationError: null };
const stubs = new Map([
  [require.resolve('../lib/herdr'), {
    startWatcher(taskId) { stubState.watcherStarts.push(taskId); return 43001; },
    api(...args) { stubState.apiCalls.push(args); return { result: {} }; },
  }],
  [require.resolve('../lib/notify'), {
    async notifyTask(task) {
      stubState.notifications.push({ id: task.id, status: task.status });
      if (stubState.notificationError) throw stubState.notificationError;
      return task;
    },
  }],
  [require.resolve('../lib/worker-context'), { recordContext() {} }],
]);
const originalModules = new Map();
for (const [id, exports] of stubs) {
  originalModules.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const util = require('../lib/util');
const protocol = require('../lib/protocol-v2');
const artifacts = require('../lib/protocol-artifacts');
const cbc = require('../lib/cbc-protocol-v2');
let serial = 0;

function resetStubs() {
  stubState.watcherStarts.length = 0;
  stubState.apiCalls.length = 0;
  stubState.notifications.length = 0;
  stubState.notificationError = null;
}

async function fixture({ state = 'active', observerGeneration = 4 } = {}) {
  const index = ++serial;
  const taskId = `cbc-v2-recovery-${index}`;
  const stateDir = process.env.AGENT_BRIDGE_STATE_DIR;
  const taskRoot = path.join(stateDir, 'tasks', taskId);
  const cwd = path.join(root, `project-${index}`);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const createdAt = new Date(Date.now() - 5000).toISOString();
  const requestId = `request-${index}`;
  const reportPath = path.join(cwd, 'delivery.md');
  const task = {
    id: taskId, agent: 'cbc', taskProtocol: 2, cbcTurnProtocol: 1, round: 1, stateDir, cwd,
    workerSessionId: `native-${index}`, terminalId: `terminal-${index}`, paneId: `workspace:pane-${index}`,
    herdrSession: `fixture-${index}`, workerStartedAt: new Date(Date.now() - 10000).toISOString(),
    layeredRequestId: requestId,
    layeredRequestFile: path.join(taskRoot, 'round-001-request-' + requestId, 'request.json'),
    submission: { attemptId: requestId, status: 'observed' }, status: 'running', observerGeneration,
    settlementSeq: 0, watcherPid: 43000, history: [],
    taskSpec: { goal: 'Isolated CBC protocol recovery fixture', background: 'No external worker or service is used.',
      deliverables: [], allowedChanges: [cwd] },
    allowedWritePaths: [cwd],
  };
  const request = {
    schema: protocol.SCHEMA, taskId, round: 1, requestId,
    specSha256: protocol.sha(Buffer.from('fixture-spec')),
    promptSha256: protocol.sha(Buffer.from('fixture-prompt')),
    pointerSha256: protocol.sha(Buffer.from('fixture-pointer')),
    createdAt, cwd: fs.realpathSync.native(cwd), stateDir: fs.realpathSync.native(stateDir),
    reportPath, allowedArtifacts: [cwd], requiredArtifacts: [],
    binding: { agent: 'cbc', sessionId: task.workerSessionId, herdrSession: task.herdrSession,
      paneId: task.paneId, terminalId: task.terminalId, workerStartedAt: task.workerStartedAt },
  };
  await protocol.create(request);
  util.saveTask(task);
  const at = new Date(Date.now() - 1000).toISOString();
  await protocol.append(request, protocol.event(request, 'native.admitted', {
    sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
    at, nativeMessageId: `input-${index}`, pointerSha256: request.pointerSha256,
    evidenceSha256: protocol.sha(Buffer.from(`admission-${index}`)),
  }, 'native-admission'));

  if (state === 'blocked') {
    await protocol.append(request, protocol.event(request, 'native.blocked', {
      sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
      at: new Date().toISOString(), nativeMessageId: `input-${index}`, reason: 'permission',
    }, 'native-permission-block'));
  } else if (state === 'frozen') {
    fs.writeFileSync(reportPath, `Frozen fixture report ${index}\n`, 'utf8');
    await artifacts.submitResult(request, { outcome: 'delivered' });
    await protocol.append(request, protocol.event(request, 'native.stopped', {
      sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId,
      at: new Date().toISOString(), nativeMessageId: `input-${index}`,
      evidenceSha256: protocol.sha(Buffer.from(`stop-${index}`)),
    }, 'native-stop'));
    task.frozenResult = artifacts.verifyResult(request);
    util.saveTask(task);
  }
  return { task, request, taskRoot };
}

function transcriptPath(task) {
  const directory = path.join(process.env.USERPROFILE, '.codebuddy', 'projects', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${task.workerSessionId}.jsonl`);
}

async function addUserPromptHook(f, nativeTranscript) {
  await cbc.transition(f.task, 'evidence.hook', {
    sessionId: f.task.workerSessionId, paneId: f.task.paneId, terminalId: f.task.terminalId,
    name: 'UserPromptSubmit', at: new Date().toISOString(), nativeTranscript,
    promptSha256: protocol.sha(Buffer.from('fixture-hook-prompt')),
  }, 'native-submit-hook');
}

test('watch records an observation deadline without claiming native execution ended', async () => {
  resetStubs();
  const f = await fixture();
  await cbc.watch(f.task.id, f.task.observerGeneration, {
    requestId: f.request.requestId, maxMs: 2, pause: () => new Promise(resolve => setTimeout(resolve, 10)),
  });

  const saved = util.loadTask(f.task.id);
  const layers = protocol.inspect(f.request);
  assert.equal(saved.status, 'running');
  assert.equal(saved.watcherPid, null);
  assert.equal(saved.settlementSeq, 1);
  assert.equal(layers.execution, 'running');
  assert.equal(layers.observation, 'unavailable');
  assert.equal(layers.conflicts.length, 0);
  assert.deepEqual(stubState.notifications, [{ id: f.task.id, status: 'running' }]);
});

test('watch exits immediately when a newer observer generation owns the task', async () => {
  resetStubs();
  const f = await fixture({ observerGeneration: 5 });
  const before = fs.readFileSync(util.taskFile(f.task.id));
  let pauseCalls = 0;
  await cbc.watch(f.task.id, 4, {
    requestId: f.request.requestId, maxMs: 0, pause: async () => { pauseCalls += 1; },
  });

  assert.deepEqual(fs.readFileSync(util.taskFile(f.task.id)), before);
  assert.equal(pauseCalls, 0);
  assert.deepEqual(stubState.notifications, []);
});

test('permission blocking stays unresolved through the observation deadline', async () => {
  resetStubs();
  const f = await fixture({ state: 'blocked' });
  await cbc.watch(f.task.id, f.task.observerGeneration, {
    requestId: f.request.requestId, maxMs: 2, pause: () => new Promise(resolve => setTimeout(resolve, 10)),
  });

  const saved = util.loadTask(f.task.id);
  const layers = protocol.inspect(f.request);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.watcherPid, null);
  assert.equal(layers.execution, 'blocked');
  assert.equal(layers.observation, 'unavailable');
  assert.equal(layers.review, 'not_ready');
  assert.equal(layers.conflicts.length, 0);
  assert.equal(stubState.notifications.at(-1).status, 'blocked');
});

test('recovering an admitted request only replaces its observer and sends no text', async () => {
  resetStubs();
  const f = await fixture();
  const priorGeneration = f.task.observerGeneration;
  const result = await cbc.recover(f.task);

  const saved = util.loadTask(f.task.id);
  assert.equal(result.status, 'running');
  assert.deepEqual(result.actions, ['local-observer-started; no input sent']);
  assert.equal(saved.observerGeneration, priorGeneration + 1);
  assert.equal(saved.watcherPid, 43001);
  assert.deepEqual(stubState.watcherStarts, [f.task.id]);
  assert.deepEqual(stubState.apiCalls, []);
  assert.equal(protocol.inspect(f.request).observation, 'healthy');
});

test('recover reconciles a frozen result locally without starting an observer or sending text', async () => {
  resetStubs();
  const f = await fixture({ state: 'frozen' });
  const result = await cbc.recover(f.task);

  const saved = util.loadTask(f.task.id);
  assert.equal(result.status, 'review_pending');
  assert.deepEqual(result.actions, ['reconciled-local-request; no input sent']);
  assert.equal(saved.status, 'review_pending');
  assert.deepEqual(saved.frozenResult, f.task.frozenResult);
  assert.deepEqual(stubState.watcherStarts, []);
  assert.deepEqual(stubState.apiCalls, []);
});

test('cancel closes a frozen request from its exact Stop proof and retains its result', async () => {
  resetStubs();
  const f = await fixture({ state: 'frozen' });
  const frozenBefore = artifacts.verifyResult(f.request);
  let absenceChecks = 0;
  const cancelled = await cbc.cancel(f.task, { proveAbsent: async () => { absenceChecks += 1; return { confirmed: false }; } });

  const saved = util.loadTask(f.task.id);
  const layers = protocol.inspect(f.request);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.frozenResult, frozenBefore);
  assert.deepEqual(saved.frozenResult, frozenBefore);
  assert.equal(cancelled.cancellation.proofType, 'request-ended');
  assert.equal(absenceChecks, 0);
  assert.equal(layers.execution, 'ended');
  assert.equal(layers.review, 'pending');
  assert.equal(layers.control, 'closed');
  assert.equal(layers.conflicts.length, 0);
  assert.deepEqual(artifacts.verifyResult(f.request), frozenBefore);
  assert.deepEqual(stubState.apiCalls, []);
});

test('notification failure leaves the frozen result and review state persisted', async () => {
  resetStubs();
  const f = await fixture({ state: 'frozen' });
  const frozenBefore = artifacts.verifyResult(f.request);
  const notifyError = new Error('fixture notification unavailable');
  stubState.notificationError = notifyError;
  await cbc.watch(f.task.id, f.task.observerGeneration, { requestId: f.request.requestId, maxMs: 100 });

  assert.deepEqual(stubState.notifications, [{ id: f.task.id, status: 'review_pending' }]);

  const saved = util.loadTask(f.task.id);
  const layers = protocol.inspect(f.request);
  const events = fs.readFileSync(path.join(process.env.AGENT_BRIDGE_STATE_DIR, 'events.ndjson'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(saved.status, 'review_pending');
  assert.deepEqual(saved.frozenResult, frozenBefore);
  assert.equal(saved.watcherPid, null);
  assert.equal(saved.settlementSeq, 1);
  assert.equal(layers.execution, 'ended');
  assert.equal(layers.review, 'pending');
  assert.equal(layers.conflicts.length, 0);
  assert.deepEqual(artifacts.verifyResult(f.request), frozenBefore);
  assert.equal(events.some(item => item.taskId === f.task.id
    && item.type === 'notification_reconciliation_failed' && item.message === notifyError.message), true);
  assert.deepEqual(stubState.notifications, [{ id: f.task.id, status: 'review_pending' }]);
});

test('damaged native JSONL marks observation unavailable idempotently, then recovers healthy without ending execution', async () => {
  resetStubs();
  const f = await fixture();
  const nativeTranscript = transcriptPath(f.task);
  fs.writeFileSync(nativeTranscript, '{"type":"message",\n', 'utf8');
  await addUserPromptHook(f, nativeTranscript);

  const before = protocol.inspect(f.request);
  assert.equal(before.execution, 'running');
  await cbc.reconcileEvidence(f.task);
  const afterFirstFailure = protocol.load(f.request);
  const unavailable = afterFirstFailure.events.filter(entry => entry.kind === 'observer.unavailable');
  assert.equal(protocol.inspect(f.request).observation, 'unavailable');
  assert.equal(protocol.inspect(f.request).execution, 'running');
  assert.equal(f.task.status, 'running');
  assert.equal(unavailable.length, 1);
  assert.match(unavailable[0].payload.reason, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);

  await cbc.reconcileEvidence(f.task);
  const afterRepeatedFailure = protocol.load(f.request);
  assert.equal(afterRepeatedFailure.events.length, afterFirstFailure.events.length);
  assert.equal(afterRepeatedFailure.events.filter(entry => entry.kind === 'observer.unavailable').length, 1);
  assert.equal(protocol.inspect(f.request).execution, 'running');

  const timestamp = new Date(Date.now() - 1000).toISOString();
  const nativeRow = { id: `input-${serial}`, type: 'message', role: 'user', timestamp, cwd: f.request.cwd,
    sessionId: f.task.workerSessionId, content: [{ type: 'input_text', text: 'fixture-pointer' }] };
  fs.writeFileSync(nativeTranscript, JSON.stringify(nativeRow) + '\n', 'utf8');
  await cbc.reconcileEvidence(f.task);
  const afterRepair = protocol.load(f.request);
  assert.equal(protocol.inspect(f.request).observation, 'healthy');
  assert.equal(protocol.inspect(f.request).execution, 'running');
  assert.equal(afterRepair.events.filter(entry => entry.kind === 'native.admitted').length, 1);
  assert.equal(afterRepair.events.filter(entry => entry.kind === 'observer.healthy').length, 1);

  await cbc.reconcileEvidence(f.task);
  assert.equal(protocol.load(f.request).events.length, afterRepair.events.length);
});

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [id, previous] of originalModules) {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  }
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
