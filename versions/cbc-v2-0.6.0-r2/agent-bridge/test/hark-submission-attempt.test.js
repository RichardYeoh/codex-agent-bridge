'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-submission-attempt-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;

const herdr = require('../lib/herdr');
const registry = require('../lib/agents');
registry.agents['fixture-native'] = { ...registry.getAgent('cbc'), id: 'fixture-native', submitWorker: null };

let nativeAgent;
let agentInfoImpl;
let promptMode;
let promptCalls;
herdr.agentInfo = (...args) => agentInfoImpl(...args);
herdr.api = (_session, args) => {
  if (args[0] === 'agent' && args[1] === 'prompt') {
    promptCalls += 1;
    if (promptMode === 'agent_not_ready') {
      const error = new Error(`agent ${args[2]} is not an active named agent`);
      error.herdrCode = 'agent_not_ready';
      throw error;
    }
    nativeAgent = { ...nativeAgent, agent_status: 'working' };
    if (promptMode === 'post-write-error') throw new Error('transport lost after prompt write');
  }
  return { result: {} };
};

const { saveTask, loadTask, taskDir } = require('../lib/util');
const bridge = require('../bin/agent-bridge');

let serial = 0;
function fixture(mode = 'accept') {
  const id = `attempt-task-${++serial}`;
  const cwd = path.join(root, `project-${serial}`);
  fs.mkdirSync(cwd, { recursive: true });
  const task = { id, agent: 'fixture-native', stateDir: root, cwd, workerKey: 'fixture-key',
    herdrSession: `fixture-session-${serial}`, paneId: `pane-${serial}`, terminalId: `terminal-${serial}`,
    workerSessionId: `native-${serial}`, agentName: `worker-${serial}`, workerStartedAt: new Date().toISOString(),
    round: 1, status: 'review_pending', history: [{ round: 1, status: 'submitted', timestamp: '2026-11-04T00:00:00.000Z' }],
    submission: { status: 'observed', baselineCompletion: 4, inputReceipt: { inputAccepted: true } },
    allowedWritePaths: ['src'] };
  nativeAgent = { agent: 'codebuddy', name: task.agentName, terminal_id: task.terminalId,
    agent_session: { value: task.workerSessionId }, agent_status: 'idle', completion_seq: 4 };
  agentInfoImpl = () => nativeAgent;
  promptMode = mode;
  promptCalls = 0;
  saveTask(task);
  return task;
}

test.after(() => {
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
});

test('agent_not_ready before input journals a terminal rejection and restores the prior review round', async () => {
  const task = fixture('agent_not_ready');
  const historicalPath = path.join(taskDir(task.id), 'round-001-submission-historical.json');
  const historicalBytes = Buffer.from('{"attemptId":"historical","status":"observed"}\n');
  fs.writeFileSync(historicalPath, historicalBytes);
  const previous = structuredClone(task);

  await assert.rejects(bridge.submit(task, 'follow-up work', { activityTimeoutMs: 5 }), error => {
    assert.equal(error.herdrCode, 'agent_not_ready');
    return true;
  });

  const saved = loadTask(task.id);
  assert.equal(saved.status, previous.status);
  assert.equal(saved.round, previous.round);
  assert.deepEqual(saved.history, previous.history);
  assert.deepEqual(saved.submission, previous.submission);
  assert.equal(promptCalls, 1);
  assert.deepEqual(fs.readFileSync(historicalPath), historicalBytes);
  const current = fs.readdirSync(taskDir(task.id)).filter(name => /^round-002-submission-.*\.json$/.test(name));
  assert.equal(current.length, 1);
  const journal = JSON.parse(fs.readFileSync(path.join(taskDir(task.id), current[0]), 'utf8'));
  assert.equal(journal.status, 'rejected-before-input');
  assert.equal(journal.inputWritten, false);
  assert.equal(journal.errorCode, 'agent_not_ready');
  assert.equal(journal.attemptId, saved.lastSubmissionRejection.attemptId);
  assert.equal(saved.lastSubmissionRejection.code, 'agent_not_ready');
});

test('an exception after prompt input stays submission_unknown and does not roll back the round', async () => {
  const task = fixture('post-write-error');
  await assert.rejects(bridge.submit(task, 'follow-up work', { activityTimeoutMs: 5 }), /transport lost after prompt write/);

  const saved = loadTask(task.id);
  assert.equal(promptCalls, 1);
  assert.equal(saved.status, 'submission_unknown');
  assert.equal(saved.round, 2);
  assert.equal(saved.submission.status, 'uncertain');
  assert.equal(saved.history.at(-1).round, 2);
  assert.equal(saved.history.at(-1).status, 'submitted');
  const current = fs.readdirSync(taskDir(task.id)).filter(name => /^round-002-submission-.*\.json$/.test(name));
  assert.equal(current.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir(task.id), current[0]), 'utf8')).status, 'uncertain');
});

test('submission waits for the exact named worker before sending the prompt', async () => {
  const task = fixture('accept');
  const observedNames = ['temporary-name', task.agentName];
  let reads = 0;
  agentInfoImpl = () => {
    reads += 1;
    return { ...nativeAgent, name: observedNames[Math.min(reads - 1, observedNames.length - 1)] };
  };

  await bridge.submit(task, 'follow-up work', { activityTimeoutMs: 25, startWatcherFn: () => 4321 });

  assert.ok(reads >= 3);
  assert.equal(promptCalls, 1);
  assert.equal(loadTask(task.id).submission.status, 'observed');
});

test('namedWorkerReady waits for Antigravity native interactive readiness', async () => {
  const task = { id: 'agy-ready-check', agent: 'agy', herdrSession: 'fixture-session', paneId: 'agy-pane',
    terminalId: 'agy-terminal', workerSessionId: 'agy-native', agentName: 'agy-worker' };
  let reads = 0;
  agentInfoImpl = () => {
    reads += 1;
    return { agent: 'agy', name: task.agentName, terminal_id: task.terminalId,
      agent_session: { value: task.workerSessionId }, agent_status: 'idle',
      launch_pending: reads === 1, interactive_ready: reads !== 1 };
  };

  const ready = await bridge.namedWorkerReady(task, 500);

  assert.equal(reads, 2);
  assert.equal(ready.name, task.agentName);
  assert.equal(ready.launch_pending, false);
  assert.equal(ready.interactive_ready, true);
});
