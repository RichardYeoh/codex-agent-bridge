'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { saveTask, loadTask } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hark-watcher-'));
const watcher = path.join(__dirname, '../bin/agent-bridge-watcher.js');
const preload = path.join(root, 'preload.cjs');
const herdrModule = require.resolve('../lib/herdr');
const zcodeModule = require.resolve('../lib/zcode-settlement');
fs.writeFileSync(preload, String.raw`
'use strict';
const fs = require('node:fs');
const herdrPath = process.env.BRIDGE_HERDR_MODULE;
const zcodePath = process.env.BRIDGE_ZCODE_MODULE;
const fixturePath = process.env.BRIDGE_WATCHER_FIXTURE;
const load = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const store = value => fs.writeFileSync(fixturePath, JSON.stringify(value));
const herdr = require(herdrPath);
function api(session, args) {
  const state = load();
  state.calls.push(args);
  store(state);
  if (args[0] === 'agent' && args[1] === 'wait') {
    if (state.waitMode === 'pane-moved') {
      const error = new Error('old Pane was moved'); error.herdrCode = 'pane_not_found'; error.code = 'HERDR_COMMAND_FAILED'; throw error;
    }
    if (state.waitMode === 'timeout') {
      const error = new Error('wait timeout'); error.herdrCode = 'timeout'; error.code = 'ETIMEDOUT'; throw error;
    }
    if (state.waitMode === 'transport') {
      const error = new Error('Herdr connection lost'); error.code = 'ECONNRESET'; throw error;
    }
    if (state.waitMode === 'delay') {
      fs.writeFileSync(fixturePath + '.wait-entered', '1');
      const until = Date.now() + 8000;
      while (!fs.existsSync(fixturePath + '.wait-release') && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      if (!fs.existsSync(fixturePath + '.wait-release')) throw new Error('fixture wait release timeout');
    }
    return { result: { agent: state.waitAgent || state.agent } };
  }
  if (args[0] === 'pane' && args[1] === 'list') return { result: { panes: state.panes || [] } };
  if (args[0] === 'agent' && args[1] === 'list') {
    const inventoryCall = state.agentListCalls || 0;
    state.agentListCalls = inventoryCall + 1;
    store(state);
    const agents = state.changeOwnerAfterFirstInventory && inventoryCall >= 1
      ? state.lateAgents || [] : state.agents || [];
    return { result: { agents } };
  }
  if (args[0] === 'agent' && args[1] === 'read') return { result: { text: state.terminal || '' } };
  return { result: { agent: state.agent } };
}
function agentInfo(session, paneId) {
  const state = load();
  state.calls.push(['agent', 'get', paneId]); store(state);
  return state.liveAgent || state.agent;
}
function startWatcher(taskId) {
  const state = load(); state.startedWatchers ||= []; state.startedWatchers.push(taskId); store(state);
  return 7231;
}
require.cache[require.resolve(herdrPath)].exports = { ...herdr, api, agentInfo, startWatcher };
const zcode = require(zcodePath);
async function waitExecution(task, { isActive }) {
  const state = load(); state.zcodeWaitStarted = true; store(state);
  fs.writeFileSync(fixturePath + '.zcode-wait-started', '1');
  if (state.zcodeWaitMode === 'generation') {
    const deadline = Date.now() + 8000;
    while (isActive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const current = load(); current.zcodeActiveAfterChange = isActive(); store(current);
    return isActive() ? { ...current.agent, agent_status: 'idle' } : null;
  }
  return zcode.waitExecution(task, { isActive, inspect: agentInfo, startupMs: 20, pollMs: 5 });
}
require.cache[require.resolve(zcodePath)].exports = { ...zcode, waitExecution };
`);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function agent(terminalId = 'term-old', paneId = 'w1:p1', status = 'idle') {
  return { agent: 'codebuddy', name: 'bridge-worker', pane_id: paneId, terminal_id: terminalId,
    workspace_id: 'workspace-1', tab_id: 'tab-1', agent_session: { value: 'native-session' },
    agent_status: status, completion_seq: 9 };
}

function fixture(name, { mode = 'idle', agentType = 'cbc', withDelivery = false } = {}) {
  const stateDir = path.join(root, name);
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const task = { id: `hark-watcher-${name}`, stateDir, status: 'running', round: 1, agent: agentType,
    herdrSession: 'stub-session', paneId: 'w1:p1', terminalId: 'term-old', agentName: 'bridge-worker',
    workerSessionId: 'native-session', workerStartedAt: new Date().toISOString(), observerGeneration: 6,
    history: [], waitTimeoutMs: 100 };
  if (withDelivery) {
    task.deliveryPath = path.join(stateDir, 'tasks', task.id, 'deliveries', 'round-001.md');
    fs.mkdirSync(path.dirname(task.deliveryPath), { recursive: true });
    fs.writeFileSync(task.deliveryPath, 'reviewable delivery');
  }
  saveTask(task);
  writeLease(task);
  const stateFile = path.join(stateDir, 'herdr.json');
  fs.writeFileSync(stateFile, JSON.stringify({ waitMode: mode, calls: [], agent: agent(), liveAgent: agent(), terminal: 'idle' }));
  return { task, stateDir, stateFile };
}

function launch(stateDir, stateFile, taskId) {
  const args = [watcher, taskId];
  const options = { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir,
    BRIDGE_WATCHER_FIXTURE: stateFile, BRIDGE_HERDR_MODULE: herdrModule, BRIDGE_ZCODE_MODULE: zcodeModule,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload.replaceAll('\\', '/')}` },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  const child = spawn(process.execPath, args, options);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`watcher timeout; stderr=${stderr}`)); }, 9000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, completion };
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(file), true, `timed out waiting for ${path.basename(file)}`);
}

test('settlement releases the task lock before notifyTask acquires it', async () => {
  const f = fixture('notify-unlocked', { withDelivery: true });
  const result = await launch(f.stateDir, f.stateFile, f.task.id).completion;
  assert.equal(result.code, 0, result.stderr);
  const settled = loadTask(f.task.id);
  assert.equal(settled.status, 'review_pending');
  assert.equal(settled.observerGeneration, 7);
  assert.equal(settled.notification.status, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).calls.some(call => ['send-text', 'send-keys', 'prompt', 'stop'].includes(call[1])), false);
});

test('moved Pane rebinds only the exact restored native owner and restarts observation without input', async () => {
  const f = fixture('restored-pane', { mode: 'pane-moved' });
  const owner = agent('term-restored', 'w2:p3', 'idle');
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.panes = [{ pane_id: owner.pane_id, terminal_id: owner.terminal_id,
    workspace_id: owner.workspace_id, tab_id: owner.tab_id }];
  state.agents = [owner];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));

  const result = await launch(f.stateDir, f.stateFile, f.task.id).completion;
  assert.equal(result.code, 0, result.stderr);
  const rebound = loadTask(f.task.id);
  assert.equal(rebound.status, 'running');
  assert.equal(rebound.paneId, 'w2:p3');
  assert.equal(rebound.terminalId, 'term-restored');
  assert.equal(rebound.workerSessionId, 'native-session');
  assert.equal(rebound.observerGeneration, 7);
  assert.equal(rebound.watcherPid, 7231);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).startedWatchers, [f.task.id]);
  assert.equal(rebound.notification, undefined);
  const calls = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).calls;
  assert.equal(calls.some(call => ['send-text', 'send-keys', 'prompt', 'stop', 'run'].includes(call[1])), false);
});

test('restored owner is revalidated under the task lock before rebind', async () => {
  const f = fixture('restored-owner-race', { mode: 'pane-moved' });
  const owner = agent('term-restored', 'w2:p3', 'idle');
  const changedOwner = agent('term-later', 'w3:p8', 'idle');
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.panes = [
    { pane_id: owner.pane_id, terminal_id: owner.terminal_id,
      workspace_id: owner.workspace_id, tab_id: owner.tab_id },
    { pane_id: changedOwner.pane_id, terminal_id: changedOwner.terminal_id,
      workspace_id: changedOwner.workspace_id, tab_id: changedOwner.tab_id },
  ];
  state.agents = [owner];
  state.lateAgents = [changedOwner];
  state.changeOwnerAfterFirstInventory = true;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));

  const result = await launch(f.stateDir, f.stateFile, f.task.id).completion;
  assert.equal(result.code, 0, result.stderr);
  const blocked = loadTask(f.task.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker.originalExecutionMayContinue, true);
  assert.equal(blocked.paneId, 'w1:p1');
  assert.equal(blocked.observerGeneration, 7);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).startedWatchers, undefined);
});

test('a conflicting restored Pane lease is refused and leaves execution blocked for observation', async () => {
  const f = fixture('restored-lease-conflict', { mode: 'pane-moved' });
  const owner = agent('term-restored', 'w2:p3', 'idle');
  const other = { id: 'hark-watcher-other', stateDir: f.stateDir, status: 'running', round: 1, agent: 'cbc',
    herdrSession: f.task.herdrSession, paneId: owner.pane_id, terminalId: owner.terminal_id,
    workerSessionId: 'other-session', history: [] };
  saveTask(other); writeLease(other);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.panes = [{ pane_id: owner.pane_id, terminal_id: owner.terminal_id,
    workspace_id: owner.workspace_id, tab_id: owner.tab_id }];
  state.agents = [owner];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));

  const result = await launch(f.stateDir, f.stateFile, f.task.id).completion;
  assert.equal(result.code, 0, result.stderr);
  const blocked = loadTask(f.task.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker.type, 'observer_unavailable');
  assert.equal(blocked.blocker.originalExecutionMayContinue, true);
  assert.equal(blocked.paneId, 'w1:p1');
  assert.equal(blocked.observerGeneration, 7);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).startedWatchers, undefined);
});

for (const mode of ['timeout', 'transport']) {
  test(`${mode} remains an observer failure and never asserts worker execution failed`, async () => {
    const f = fixture(`observer-${mode}`, { mode });
    const currentAgent = agent('term-old', 'w1:p1', 'working');
    const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    state.panes = [{ pane_id: currentAgent.pane_id, terminal_id: currentAgent.terminal_id,
      workspace_id: currentAgent.workspace_id, tab_id: currentAgent.tab_id }];
    state.agents = [currentAgent];
    fs.writeFileSync(f.stateFile, JSON.stringify(state));

    const result = await launch(f.stateDir, f.stateFile, f.task.id).completion;
    assert.equal(result.code, 0, result.stderr);
    const blocked = loadTask(f.task.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocker.originalExecutionMayContinue, true);
    assert.equal(blocked.history.some(entry => entry.status === 'failed'), false);
    assert.equal(blocked.observerGeneration, 7);
  });
}

test('a stale general observer cannot settle or notify after its generation is fenced', async () => {
  const f = fixture('old-generation', { mode: 'delay', withDelivery: true });
  const running = launch(f.stateDir, f.stateFile, f.task.id);
  await waitForFile(f.stateFile + '.wait-entered');
  const current = loadTask(f.task.id);
  current.observerGeneration += 1;
  current.history.push({ round: 1, status: 'running', timestamp: new Date().toISOString(), source: 'new-observer' });
  saveTask(current);
  fs.writeFileSync(f.stateFile + '.wait-release', '1');
  const result = await running.completion;
  assert.equal(result.code, 0, result.stderr);
  const stillRunning = loadTask(f.task.id);
  assert.equal(stillRunning.status, 'running');
  assert.equal(stillRunning.round, 1);
  assert.equal(stillRunning.observerGeneration, 7);
  assert.equal(stillRunning.notification, undefined);
  assert.equal(stillRunning.history.some(entry => entry.status === 'review_pending'), false);
});

test('ZCode observer activity check includes observerGeneration', async () => {
  const f = fixture('zcode-generation', { agentType: 'zcode' });
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.zcodeWaitMode = 'generation';
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const running = launch(f.stateDir, f.stateFile, f.task.id);
  await waitForFile(f.stateFile + '.zcode-wait-started');
  const current = loadTask(f.task.id);
  current.observerGeneration += 1;
  saveTask(current);
  const result = await running.completion;
  assert.equal(result.code, 0, result.stderr);
  const stillRunning = loadTask(f.task.id);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).zcodeActiveAfterChange, false);
  assert.equal(stillRunning.status, 'running');
  assert.equal(stillRunning.observerGeneration, 7);
  assert.equal(stillRunning.notification, undefined);
});
