'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveTask, loadTask } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-recovery-paths-'));
let serial = 0;
let activeFixture;
let turnReader;
let liveProcessProof;
const herdr = require('../lib/herdr');
const turn = require('../lib/cbc-turn');
const reconciliation = require('../lib/cbc-reconciliation');
const original = { agentInfo: herdr.agentInfo, api: herdr.api,
  readTurn: turn.readTurn, liveProof: reconciliation.liveProof, alive: require('../lib/util').processAlive };
require('../lib/util').processAlive = () => false;

herdr.agentInfo = (_session, paneId) => {
  const f = activeFixture;
  assert.equal(paneId, f.task.paneId);
  if (f.paneMissing) throw Object.assign(new Error('fixture Pane missing'), { herdrCode: 'pane_not_found' });
  return { agent: 'codebuddy', name: f.task.agentName, pane_id: f.task.paneId,
    terminal_id: f.task.terminalId, agent_session: { value: f.task.workerSessionId },
    agent_status: f.agentStatus, state_change_seq: 17 };
};
herdr.api = (_session, args) => {
  const f = activeFixture;
  f.herdrCalls.push(args);
  if (args[0] === 'pane' && args[1] === 'list') return { result: { panes: f.inventoryPanes } };
  if (args[0] === 'agent' && args[1] === 'list') return { result: { agents: f.inventoryAgents } };
  throw new Error(`Unexpected Herdr API call: ${args.join(' ')}`);
};
turn.readTurn = task => turnReader(task);
reconciliation.liveProof = async (task, proof) => {
  activeFixture.liveProofCalls++;
  assert.equal(task.id, activeFixture.task.id);
  assert.equal(proof.phase, 'observing');
  assert.equal(proof.submissionAt, activeFixture.turn.submittedAt);
  return structuredClone(liveProcessProof);
};
const recovery = require('../lib/task-recovery');
const paneCancellation = require('../lib/pane-cancellation');


test.after(() => {
  herdr.agentInfo = original.agentInfo;
  herdr.api = original.api;
  turn.readTurn = original.readTurn;
  reconciliation.liveProof = original.liveProof;
  require('../lib/util').processAlive = original.alive;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ paneMissing = false, ownerPresent = false, turnState = 'stopped', agentStatus = 'idle',
  currentProcessPid = 51002 } = {}) {
  const index = ++serial;
  const stateDir = path.join(root, `state-${index}`), cwd = path.join(root, `project-${index}`);
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const id = `cbc-late-settle-${index}`, taskRoot = path.join(stateDir, 'tasks', id);
  fs.mkdirSync(path.join(taskRoot, 'deliveries'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const deliveryPath = path.join(taskRoot, 'deliveries', 'round-001.md');
  fs.writeFileSync(deliveryPath, 'Late but nonempty CBC delivery for independent review.\n');
  const submittedAt = new Date(Date.now() - 3000).toISOString();
  const task = { id, stateDir, cwd, agent: 'cbc', status: 'blocked', round: 1,
    cbcTurnProtocol: 1, herdrSession: `herdr-${index}`, paneId: `w1:p${index}`,
    terminalId: `term-${index}`, agentName: `cbc-worker-${index}`, workerSessionId: `native-${index}`,
    workerStartedAt: new Date(Date.now() - 6000).toISOString(), workerKey: 'fixture-key',
    taskSpec: { goal: 'Settle an isolated CBC late delivery', background: 'Fixture only',
      requirements: ['Do not connect to CBC or Herdr'], allowedChanges: ['result.txt'] },
    allowedWritePaths: ['result.txt'], deliveryPath, watcherPid: null, observerGeneration: 4,
    settlementSeq: 2, submission: { status: 'observed', attemptId: 'fixture-attempt',
      file: path.join(taskRoot, 'round-001-submission-fixture-attempt.json') },
    history: [{ round: 1, status: 'blocked', timestamp: submittedAt }] };
  const processProof = { kind: 'cbc', pid: 51001, shellPid: 51000,
    processStartedAt: new Date(Date.now() - 5000).toISOString() };
  fs.writeFileSync(task.submission.file, JSON.stringify({ taskId: id, round: 1, workerSessionId: task.workerSessionId, processProof }));
  saveTask(task); writeLease(task);
  const pane = { pane_id: task.paneId, terminal_id: task.terminalId, workspace_id: `workspace-${index}`,
    tab_id: `tab-${index}` };
  const agent = { ...pane, agent: 'codebuddy', name: task.agentName,
    agent_session: { value: task.workerSessionId }, agent_status: 'idle' };
  const f = { task, taskRoot, deliveryPath, paneMissing, agentStatus, currentProcessPid, turn: { state: turnState, submittedAt,
    stopAt: new Date(Date.now() - 1000).toISOString(), attemptId: `attempt-${index}` },
    inventoryPanes: ownerPresent ? [pane] : [], inventoryAgents: ownerPresent ? [agent] : [],
    herdrCalls: [], liveProofCalls: 0 };
  activeFixture = f;
  turnReader = () => structuredClone(f.turn);
  liveProcessProof = structuredClone(processProof);
  return f;
}

function taskBytes(f) { return fs.readFileSync(path.join(f.taskRoot, 'task.json')); }


test('exact CBC Stop, current idle worker, and matching process proof permit late settlement', async () => {
  const f = fixture();
  const result = await recovery.settle(loadTask(f.task.id));
  assert.equal(result.status, 'review_pending');
  assert.equal(result.history.at(-1).source, 'late-delivery-settle');
  assert.equal(result.cbcTurnProtocol, 1);
  assert.equal(f.liveProofCalls, 1);
  assert.equal(f.herdrCalls.length, 0);
  assert.equal(loadTask(f.task.id).status, 'review_pending');
});


test('confirmed closed Pane permits late settlement but proves only registered worker closure', async () => {
  const f = fixture({ paneMissing: true });
  const proof = paneCancellation.cancellationState(f.task);
  assert.equal(proof.confirmed, true);
  assert.equal(proof.reason, 'registered_worker_closed');
  assert.match(proof.scope, /registered-worker-only/);
  assert.match(proof.scope, /detached child processes require explicit operator review/);

  const result = await recovery.settle(loadTask(f.task.id));
  assert.equal(result.status, 'review_pending');
  assert.equal(f.liveProofCalls, 0);
  assert.ok(f.herdrCalls.some(args => args[0] === 'pane' && args[1] === 'list'));
});


test('superseded and unconfirmed turns cannot settle late delivery', async t => {
  for (const turnState of ['superseded', 'active', 'invalid', 'unknown']) {
    await t.test(turnState, async () => {
      const f = fixture({ turnState });
      const before = taskBytes(f);
      await assert.rejects(recovery.settle(loadTask(f.task.id)), /exact current-turn Stop is unavailable/);
      assert.deepEqual(taskBytes(f), before);
      assert.equal(f.liveProofCalls, 0);
    });
  }
});


test('missing closed-worker proof rejects without changing task state', async () => {
  const f = fixture({ paneMissing: true, ownerPresent: true });
  const before = taskBytes(f);
  await assert.rejects(recovery.settle(loadTask(f.task.id)), /closed-worker evidence is incomplete/);
  assert.deepEqual(taskBytes(f), before);
  assert.equal(f.liveProofCalls, 0);
});


test('same Pane and native ID with a new process is rejected and task bytes remain unchanged', async () => {
  const f = fixture({ currentProcessPid: 51002 });
  const before = taskBytes(f);
  liveProcessProof = { ...liveProcessProof, pid: f.currentProcessPid,
    processStartedAt: new Date(Date.now() - 500).toISOString() };
  await assert.rejects(recovery.settle(loadTask(f.task.id)), error => error.code === 'WORKER_IDENTITY_MISMATCH');
  assert.deepEqual(taskBytes(f), before);
  assert.equal(f.liveProofCalls, 1);
});
