'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { saveTask, loadTask, readJson } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cbc-watcher-'));
const originalStateDir = process.env.AGENT_BRIDGE_STATE_DIR;
const watcher = path.join(__dirname, '../bin/agent-bridge-watcher.js');
const preload = path.join(root, 'preload.cjs');
const herdrModule = require.resolve('../lib/herdr');
const turnModule = require.resolve('../lib/cbc-turn');
const reconciliationModule = require.resolve('../lib/cbc-reconciliation');
const observationModule = require.resolve('../lib/cbc-observation');
const notifyModule = require.resolve('../lib/notify');
let serial = 0;

fs.writeFileSync(preload, String.raw`
'use strict';
const fs = require('node:fs');
const fixturePath = process.env.BRIDGE_CBC_WATCHER_FIXTURE;
const readState = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const writeState = value => fs.writeFileSync(fixturePath, JSON.stringify(value));
const herdrPath = process.env.BRIDGE_CBC_HERDR_MODULE;
const turnPath = process.env.BRIDGE_CBC_TURN_MODULE;
const reconciliationPath = process.env.BRIDGE_CBC_RECONCILIATION_MODULE;
const observationPath = process.env.BRIDGE_CBC_OBSERVATION_MODULE;
const notifyPath = process.env.BRIDGE_CBC_NOTIFY_MODULE;
const herdr = require(herdrPath);
function agentInfo(session, paneId) {
  const state = readState();
  state.calls.push(['agent', 'get', paneId]);
  writeState(state);
  return state.agent;
}
function api(session, args) {
  const state = readState();
  state.calls.push(args);
  writeState(state);
  if (args[0] === 'agent' && args[1] === 'read') return { result: { text: state.terminal || '' } };
  if (args[0] === 'pane' && args[1] === 'list') return { result: { panes: state.panes } };
  if (args[0] === 'agent' && args[1] === 'list') return { result: { agents: state.agents } };
  if (args[0] === 'pane' && args[1] === 'get') return { result: { pane: state.pane } };
  if (args[0] === 'agent' && args[1] === 'get') return { result: { agent: state.agent } };
  return { result: { agent: state.agent } };
}
require.cache[require.resolve(herdrPath)].exports = { ...herdr, api, agentInfo };
const turn = require(turnPath);
function readTurn(task) {
  const state = readState();
  if (task.id !== state.taskId) throw new Error('Unexpected CBC task identity');
  const index = state.turnReads++;
  writeState(state);
  const configured = state.turns[Math.min(index, state.turns.length - 1)];
  return typeof configured === 'string' ? { state: configured, ...state.turnFields }
    : { ...state.turnFields, ...configured };
}
require.cache[require.resolve(turnPath)].exports = { ...turn, readTurn };
const reconciliation = require(reconciliationPath);
async function liveProof(task, proof) {
  const state = readState();
  if (task.id !== state.taskId || proof.phase !== 'observing') throw new Error('Unexpected live proof request');
  state.liveProofCalls++;
  writeState(state);
  if (state.liveProofFailure) {
    throw Object.assign(new Error('fixture process proof query timed out'), {
      code: 'ETIMEDOUT', processProofCode: state.liveProofFailure,
    });
  }
  return state.processProof;
}
require.cache[require.resolve(reconciliationPath)].exports = { ...reconciliation, liveProof };
const observation = require(observationPath);
async function waitExecution(task, options = {}) {
  return observation.waitExecution(task, { ...options, pollMs: 5, admissionMs: 35 });
}
require.cache[require.resolve(observationPath)].exports = { ...observation, waitExecution };
const notify = require(notifyPath);
async function notifyTask(task) {
  const state = readState();
  state.notifications.push({ id: task.id, status: task.status, round: task.round });
  writeState(state);
  return task;
}
require.cache[require.resolve(notifyPath)].exports = { ...notify, notifyTask };
` , 'utf8');

test.after(() => {
  if (originalStateDir === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
  else process.env.AGENT_BRIDGE_STATE_DIR = originalStateDir;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name, { turns, agentStatus = 'idle', terminal = '', delivery = false, waitTimeoutMs = 1000,
  taskStatus = 'submission_unknown', submissionStatus = 'uncertain', liveProofFailure = null } = {}) {
  const index = ++serial;
  const stateDir = path.join(root, `state-${index}`);
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const id = `cbc-watcher-${name}-${index}`;
  const taskRoot = path.join(stateDir, 'tasks', id);
  fs.mkdirSync(taskRoot, { recursive: true });
  const cwd = path.join(root, `project-${index}`);
  fs.mkdirSync(cwd, { recursive: true });
  const submittedAt = new Date(Date.now() - 5000).toISOString();
  const attemptId = `attempt-${index}`;
  const processProof = { kind: 'cbc', pid: 64001, shellPid: 64000,
    processStartedAt: new Date(Date.now() - 10000).toISOString() };
  const submissionFile = path.join(taskRoot, `round-001-submission-${attemptId}.json`);
  const task = { id, stateDir, cwd, agent: 'cbc', cbcTurnProtocol: 1, status: taskStatus, round: 1,
    herdrSession: `herdr-${index}`, paneId: `w1:p${index}`, terminalId: `term-${index}`,
    agentName: `cbc-worker-${index}`, workerSessionId: `native-${index}`,
    workerStartedAt: new Date(Date.now() - 20000).toISOString(), workerKey: 'fixture-key',
    taskSpec: { goal: 'Verify isolated CBC watcher state transitions', background: 'No business task or network access',
      requirements: ['Use only local fixture state'], allowedChanges: ['result.txt'] },
    allowedWritePaths: ['result.txt'], observerGeneration: 4, settlementSeq: 0, watcherPid: null,
    waitTimeoutMs, history: [{ round: 1, status: taskStatus, timestamp: submittedAt }],
    submission: { status: submissionStatus, attemptId, file: submissionFile } };
  if (delivery) {
    task.deliveryPath = path.join(taskRoot, 'deliveries', 'round-001.md');
    fs.mkdirSync(path.dirname(task.deliveryPath), { recursive: true });
    fs.writeFileSync(task.deliveryPath, 'Fixture delivery for watcher settlement.\n');
  }
  fs.writeFileSync(submissionFile, JSON.stringify({ protocol: 1, agent: 'cbc', status: submissionStatus,
    taskId: id, round: 1, attemptId, processProof }));
  const attemptBytes = fs.readFileSync(submissionFile);
  saveTask(task);
  writeLease(task);
  const agent = { agent: 'codebuddy', name: task.agentName, pane_id: task.paneId, terminal_id: task.terminalId,
    workspace_id: `workspace-${index}`, tab_id: `tab-${index}`,
    agent_session: { value: task.workerSessionId }, agent_status: agentStatus, state_change_seq: 23 };
  const stateFile = path.join(stateDir, 'fixture.json');
  const state = { taskId: id, turns, turnReads: 0, turnFields: { attemptId, submittedAt,
      stopAt: new Date(Date.now() + 60000).toISOString(), laterInputAt: null },
    processProof, liveProofCalls: 0, agent, pane: { pane_id: task.paneId, terminal_id: task.terminalId },
    panes: [{ pane_id: task.paneId, terminal_id: task.terminalId }], agents: [agent],
    terminal, calls: [], notifications: [], liveProofFailure };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return { task, stateDir, taskRoot, stateFile, submissionFile, attemptBytes };
}

function launch(f) {
  const child = spawn(process.execPath, [watcher, f.task.id], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.stateDir,
      BRIDGE_CBC_WATCHER_FIXTURE: f.stateFile,
      BRIDGE_CBC_HERDR_MODULE: herdrModule,
      BRIDGE_CBC_TURN_MODULE: turnModule,
      BRIDGE_CBC_RECONCILIATION_MODULE: reconciliationModule,
      BRIDGE_CBC_OBSERVATION_MODULE: observationModule,
      BRIDGE_CBC_NOTIFY_MODULE: notifyModule,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload.replaceAll('\\', '/')}`.trim() },
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`watcher timed out; stdout=${stdout}; stderr=${stderr}`)); }, 7000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, completion };
}

function fixtureState(f) { return readJson(f.stateFile); }

async function runFixture(f) {
  const result = await launch(f).completion;
  assert.equal(result.code, 0, result.stderr);
  return { task: loadTask(f.task.id), state: fixtureState(f), result };
}

test('uncertain admission becomes review_pending after exact active then Stop while attempt stays uncertain', async () => {
  const f = fixture('admitted-stopped', { turns: ['active', 'active', 'stopped', 'stopped'], delivery: true });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'review_pending');
  assert.equal(task.submission.status, 'observed');
  assert.equal(task.submission.reconciledFrom, 'uncertain');
  assert.equal(task.submission.nativeTurnObserved, true);
  assert.equal(task.cbcTurnReceipt.state, 'stopped');
  assert.equal(task.observerGeneration, 5);
  assert.equal(task.settlementSeq, 1);
  assert.equal(readJson(f.submissionFile).status, 'uncertain');
  assert.equal(state.turnReads, 5);
  assert.equal(state.liveProofCalls, 2);
  assert.deepEqual(state.notifications, [{ id: task.id, status: 'review_pending', round: 1 }]);
  const events = fs.readFileSync(path.join(f.stateDir, 'events.ndjson'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(entry => entry.type === 'cbc_submission_reconciled').length, 1);
  assert.equal(events.filter(entry => entry.type === 'settled' && entry.status === 'review_pending').length, 1);
});

test('running task with sending attempt reconciles exact active then Stop without rewriting attempt history', async () => {
  const f = fixture('sending-admitted-stopped', { turns: ['active', 'active', 'stopped', 'stopped'],
    delivery: true, taskStatus: 'running', submissionStatus: 'sending' });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'review_pending');
  assert.equal(task.submission.status, 'observed');
  assert.equal(task.submission.reconciledFrom, 'sending');
  assert.equal(task.submission.nativeTurnObserved, true);
  assert.equal(task.cbcTurnReceipt.state, 'stopped');
  assert.deepEqual(fs.readFileSync(f.submissionFile), f.attemptBytes);
  assert.equal(readJson(f.submissionFile).status, 'sending');
  assert.equal(state.liveProofCalls, 2);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.calls.some(args => ['run', 'send-text', 'send-keys', 'prompt'].includes(args[1])), false);
});

for (const [name, statusText, blockerType] of [
  ['rate-limit', '429 Too Many Requests: rate_limit_exceeded', 'rate_limit'],
  ['quota', 'API error: insufficient_quota; usage limit reached', 'quota'],
  ['network', 'fetch failed: ECONNRESET', 'network'],
]) {
  test(`exact Stop without a report reports ${blockerType} rather than successful completion`, async () => {
    const f = fixture(`${name}-stop`, { turns: ['stopped'], agentStatus: 'idle', terminal: statusText });
    const { task, state } = await runFixture(f);
    assert.equal(task.status, 'blocked'); assert.equal(task.blocker.type, blockerType);
    assert.equal(state.calls.some(args => ['run', 'send-text', 'send-keys', 'prompt'].includes(args[1])), false);
  });
  test(`exact native blocked turn without delivery classifies ${blockerType} and preserves uncertain attempt`, async () => {
    const f = fixture(name, { turns: ['blocked', 'blocked', 'blocked'], agentStatus: 'blocked', terminal: statusText });
    const { task, state } = await runFixture(f);
    assert.equal(task.status, 'blocked');
    assert.equal(task.blocker.type, blockerType);
    assert.equal(task.blocker.requiresAction, true);
    assert.equal(task.deliveryPath, undefined);
    assert.equal(task.submission.status, 'observed');
    assert.equal(readJson(f.submissionFile).status, 'uncertain');
    assert.equal(state.liveProofCalls, 1);
    assert.deepEqual(state.notifications, [{ id: task.id, status: 'blocked', round: 1 }]);
  });
}

test('real CBC frequency-limit wording after Stop is blocked, not delivery_missing', async () => {
  const f = fixture('cbc-real-429-shape', { turns: ['stopped'], agentStatus: 'idle',
    terminal: "429 usage exceeds frequency limit, but don't worry, your usage will reset later" });
  const { task } = await runFixture(f);
  assert.equal(task.status, 'blocked'); assert.equal(task.blocker.type, 'rate_limit');
});

test('active native turn with stale Herdr idle never becomes review_pending and times out safely', async () => {
  const f = fixture('active-stale-idle', { turns: ['active', 'active'], agentStatus: 'idle', waitTimeoutMs: 100 });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocker.type, 'wait_timeout');
  assert.equal(task.blocker.originalExecutionMayContinue, true);
  assert.equal(task.history.some(item => item.status === 'review_pending'), false);
  assert.equal(task.submission.status, 'observed');
  assert.equal(readJson(f.submissionFile).status, 'uncertain');
  assert.equal(state.notifications.at(-1).status, 'blocked');
});

test('superseded native input is fenced and never settles or replays the uncertain submission', async () => {
  const f = fixture('superseded', { turns: ['superseded'] });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'submission_unknown');
  assert.equal(task.blocker.type, 'native_turn_superseded');
  assert.equal(task.history.some(item => item.status === 'review_pending'), false);
  assert.equal(task.submission.status, 'uncertain');
  assert.equal(readJson(f.submissionFile).status, 'uncertain');
  assert.equal(state.liveProofCalls, 0);
  assert.equal(state.notifications.at(-1).status, 'submission_unknown');
  assert.equal(state.calls.some(args => ['run', 'send-text', 'send-keys', 'prompt'].includes(args[1])), false);
});

test('missing native input admission times out without resubmission', async () => {
  const f = fixture('no-input-timeout', { turns: ['unconfirmed'], waitTimeoutMs: 1000 });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'submission_unknown');
  assert.equal(task.blocker.type, 'observer_unavailable');
  assert.equal(task.submission.status, 'uncertain');
  assert.equal(readJson(f.submissionFile).status, 'uncertain');
  assert.equal(task.history.some(item => item.status === 'review_pending'), false);
  assert.equal(state.liveProofCalls, 0);
  assert.equal(state.notifications.at(-1).status, 'submission_unknown');
  assert.equal(state.calls.some(args => ['run', 'send-text', 'send-keys', 'prompt'].includes(args[1])), false);
});

test('running task with unconfirmed sending attempt becomes submission_unknown, not blocked', async () => {
  const f = fixture('sending-no-input-timeout', { turns: ['unconfirmed'], waitTimeoutMs: 1000,
    taskStatus: 'running', submissionStatus: 'sending' });
  const { task, state } = await runFixture(f);
  assert.equal(task.status, 'submission_unknown');
  assert.notEqual(task.status, 'blocked');
  assert.equal(task.submission.status, 'uncertain');
  assert.equal(task.blocker.type, 'observer_unavailable');
  assert.equal(task.blocker.originalExecutionMayContinue, true);
  const attempt = readJson(f.submissionFile);
  assert.equal(attempt.status, 'uncertain');
  assert.equal(attempt.inputWritten, 'unknown');
  assert.equal(attempt.errorCode, 'CBC_ADMISSION_UNCONFIRMED');
  assert.equal(state.liveProofCalls, 0);
  assert.equal(task.history.at(-1).status, 'submission_unknown');
  assert.equal(state.notifications.at(-1).status, 'submission_unknown');
  assert.equal(state.calls.some(args => ['run', 'send-text', 'send-keys', 'prompt'].includes(args[1])), false);
});

test('process proof query timeout retries three times and records the typed failure without admission', async () => {
  const f = fixture('process-proof-query-timeout', { turns: ['active'], liveProofFailure: 'query-timeout' });
  const { task, state } = await runFixture(f);
  assert.equal(state.liveProofCalls, 3);
  assert.equal(task.status, 'submission_unknown');
  assert.equal(task.submission.status, 'uncertain');
  assert.equal(task.blocker.type, 'wait_timeout');
  assert.equal(task.blocker.processProofCode, 'query-timeout');
  assert.equal(task.history.some(item => item.status === 'review_pending'), false);
  assert.equal(state.notifications.at(-1).status, 'submission_unknown');
});
