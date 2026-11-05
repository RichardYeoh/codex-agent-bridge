'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-adoption-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
const { adopt } = require('../lib/zcode-adoption');
const { saveTask, taskDir, loadTask, readJson, writeJsonAtomic } = require('../lib/util');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(id) {
  const task = { id, stateDir: root, agent: 'zcode', round: 1, status: 'review_pending', history: [],
    workerSessionId: 'original-session', paneId: 'pane', terminalId: 'terminal', herdrSession: 'test' };
  saveTask(task);
  const directory = taskDir(id); fs.mkdirSync(path.join(directory, 'deliveries'));
  const commandFile = path.join(directory, 'manual.json');
  fs.writeFileSync(commandFile, JSON.stringify({ envelope: { type: 'sendText', sessionId: 'original-session',
    commandId: 'already-sent', payload: { text: 'Existing task, do not resend' } },
  ack: { commandId: 'already-sent', status: 'accepted' } }));
  const specFile = path.join(directory, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ goal: 'test', background: 'test', inputs: [{ path: 'file', purpose: 'test' }],
    allowedChanges: ['file'], requirements: ['test'], acceptance: [{ command: 'test', expected: 'test' }], deliverables: ['file'] }));
  const options = { commandFile, specFile, deliveryFile: path.join(directory, 'deliveries', 'round-002-manual.md'), round: 2 };
  const calls = []; let verified = 0;
  writeJsonAtomic(path.join(directory, 'zcode-state.json'), { taskId: id, round: 1, sessionId: task.workerSessionId,
    paneId: task.paneId, terminalId: task.terminalId, commandId: 'previous-command', state: 'idle', workerPid: process.pid });
  const dependencies = { inspect: () => ({ agent: 'zcode', agent_status: 'idle', terminal_id: 'terminal' }),
    lease: () => ({ taskId: id, terminalId: 'terminal' }), alive: pid => pid === process.pid, watch: () => 123,
    call: (...args) => {
      calls.push(args);
      if (args[1]?.[1] === 'send-text' && args[1]?.[3] === ':resume') {
        writeJsonAtomic(path.join(directory, 'zcode-state.json'), { taskId: id, round: 2, sessionId: task.workerSessionId,
          paneId: task.paneId, terminalId: task.terminalId, commandId: 'already-sent', state: 'working', workerPid: process.pid });
      }
    }, verify: async () => { verified++; return { previous: { terminal: true }, current: { seen: true, state: 'running' } }; } };
  return { task, options, dependencies, calls, verified: () => verified };
}

test('manual command becomes a tracked new round without create/send/stop; duplicate adoption never replays', async () => {
  const f = setup('adopt-safe');
  await adopt(f.task, f.options, f.dependencies);
  const saved = loadTask(f.task.id);
  assert.equal(saved.round, 2); assert.equal(saved.status, 'running');
  assert.equal(saved.workerSessionId, 'original-session'); assert.equal(saved.watcherPid, 123);
  assert.equal(readJson(path.join(taskDir(saved.id), 'round-002-zcode-command.json')).envelope.commandId, 'already-sent');
  assert.deepEqual(f.calls.map(call => call[1].slice(1)), [
    ['send-keys', 'pane', 'ctrl+u'], ['send-text', 'pane', ':resume'], ['send-keys', 'pane', 'enter']]);
  await adopt(saved, f.options, f.dependencies);
  assert.equal(f.verified(), 1); assert.equal(f.calls.length, 3);
});

test('identity, lease, active observer and uncertain native evidence fail before state mutation', async () => {
  for (const variant of ['identity', 'lease', 'working', 'unconfirmed', 'worker-state']) {
    const f = setup(`adopt-${variant}`);
    if (variant === 'identity') f.dependencies.inspect = () => ({ agent: 'zcode', terminal_id: 'different' });
    if (variant === 'lease') f.dependencies.lease = () => ({ taskId: 'other', terminalId: 'terminal' });
    if (variant === 'working') f.dependencies.inspect = () => ({ agent: 'zcode', terminal_id: 'terminal', agent_status: 'working' });
    if (variant === 'worker-state') writeJsonAtomic(path.join(taskDir(f.task.id), 'zcode-state.json'), {
      taskId: f.task.id, round: 1, sessionId: f.task.workerSessionId, paneId: f.task.paneId,
      terminalId: f.task.terminalId, commandId: 'previous-command', state: 'working', workerPid: process.pid });
    if (variant === 'unconfirmed') f.dependencies.verify = async () => { throw new Error('not terminal'); };
    await assert.rejects(adopt(f.task, f.options, f.dependencies));
    assert.equal(loadTask(f.task.id).round, 1); assert.equal(f.calls.length, 0);
  }
});

test('a command already journaled in an older round cannot be adopted as a new round', async () => {
  const f = setup('adopt-old-command');
  writeJsonAtomic(path.join(taskDir(f.task.id), 'round-001-zcode-command.json'), { envelope: {
    type: 'sendText', sessionId: f.task.workerSessionId, commandId: 'already-sent', payload: { text: 'old round' } },
  status: 'terminal' });
  await assert.rejects(adopt(f.task, f.options, f.dependencies), /historical round/);
  assert.equal(loadTask(f.task.id).round, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.verified(), 1);
});
