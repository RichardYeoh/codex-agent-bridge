'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { saveTask, writeJsonAtomic, taskDir, loadTask, readJson } = require('../lib/util');
const { files } = require('../lib/zcode-readiness');
const { approveOnce, commandFile } = require('../bin/zcode-control');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-zcode-control-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let serial = 0;
function fixture() {
  const task = { id: `approval-${++serial}`, stateDir: root, cwd: root, agent: 'zcode', status: 'blocked', round: 2,
    workerSessionId: 'fixture-session', herdrSession: 'isolated-herdr', paneId: 'fixture-pane', terminalId: 'fixture-terminal',
    blocker: { type: 'interaction_required' }, history: [], zcodeConfig: 'not-read-by-fixture' };
  const envelope = { type: 'sendText', commandId: 'business-command', sessionId: task.workerSessionId, payload: { text: 'fixture' } };
  const journal = { envelope, status: 'acknowledged', ack: { commandId: envelope.commandId, status: 'accepted' } };
  const state = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
    paneId: task.paneId, terminalId: task.terminalId, commandId: envelope.commandId,
    state: 'blocked', reason: 'interaction_required' };
  saveTask(task); writeJsonAtomic(files(task).journal, journal);
  writeJsonAtomic(path.join(taskDir(task.id), 'zcode-state.json'), state);
  const calls = [], remote = new EventEmitter();
  remote.connect = async () => calls.push('connect');
  remote.attachProject = async cwd => calls.push(['attach', cwd]);
  remote.envelope = (type, sessionId, payload) => ({ type, sessionId, payload, commandId: 'approval-command' });
  remote.command = async envelope => { calls.push(['command', envelope]); return { status: 'accepted', commandId: envelope.commandId }; };
  remote.close = async () => calls.push('close');
  const snapshot = { sessionId: task.workerSessionId, pendingInteractions: [{ interactionId: 'interaction-1', kind: 'permission',
    sourceCommandId: envelope.commandId, payload: { options: [{ optionId: 'allowOnce' }, { optionId: 'deny' }] } }] };
  const conversation = new EventEmitter(); conversation.subscribe = async () => snapshot;
  conversation.dispose = async () => calls.push('dispose');
  let locks = 0;
  const dependencies = { createRemote: () => remote, createConversation: () => conversation,
    withLock: async (id, operation) => { assert.equal(id, task.id); locks++; return operation(); } };
  return { task, envelope, journal, state, snapshot, calls, dependencies, locks: () => locks };
}

test('approve-once is task-locked and binds the one-time native permission to the current journal command', async () => {
  const f = fixture(), result = await approveOnce(f.task.id, 'interaction-1', f.dependencies);
  assert.equal(result.status, 'accepted'); assert.equal(result.commandId, 'business-command');
  assert.equal(result.interactionId, 'interaction-1'); assert.equal(f.locks(), 1);
  const command = f.calls.find(item => Array.isArray(item) && item[0] === 'command')[1];
  assert.equal(command.type, 'resolveInteraction'); assert.equal(command.sessionId, f.task.workerSessionId);
  assert.deepEqual(command.payload, { interactionId: 'interaction-1', answer: { optionId: 'allowOnce' } });
  const receipt = readJson(commandFile(f.task, 'interaction-1'));
  assert.equal(receipt.status, 'acknowledged'); assert.equal(receipt.commandId, 'business-command');
  assert.equal(receipt.sourceCommandId, 'business-command');
  assert.deepEqual(f.calls.filter(item => item === 'connect' || item === 'dispose' || item === 'close'), ['connect', 'dispose', 'close']);
});

test('wrong interaction owner, missing sourceCommandId, absent one-time option, or terminal task cannot be approved', async () => {
  for (const variant of ['foreign-command', 'missing-owner', 'no-option', 'cancelled']) {
    const f = fixture();
    if (variant === 'foreign-command') f.snapshot.pendingInteractions[0].sourceCommandId = 'another-command';
    if (variant === 'missing-owner') delete f.snapshot.pendingInteractions[0].sourceCommandId;
    if (variant === 'no-option') f.snapshot.pendingInteractions[0].payload.options = [{ optionId: 'deny' }];
    if (variant === 'cancelled') { f.task.status = 'cancelled'; saveTask(f.task); }
    await assert.rejects(approveOnce(f.task.id, 'interaction-1', f.dependencies));
    assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'command'), false, variant);
    assert.equal(fs.existsSync(commandFile(f.task, 'interaction-1')), false, variant);
  }
});

test('uncertain approval submission is persisted and a second approve-once never resends it', async () => {
  const f = fixture(); let sends = 0;
  f.dependencies.createRemote = () => {
    const remote = new EventEmitter(); remote.connect = async () => {}; remote.attachProject = async () => {};
    remote.envelope = (type, sessionId, payload) => ({ type, sessionId, payload, commandId: `approval-${++sends}` });
    remote.command = async () => { sends++; throw new Error('ACK lost'); }; remote.close = async () => {};
    return remote;
  };
  await assert.rejects(approveOnce(f.task.id, 'interaction-1', f.dependencies), /ACK lost/);
  assert.equal(readJson(commandFile(f.task, 'interaction-1')).status, 'sending');
  await assert.rejects(approveOnce(f.task.id, 'interaction-1', f.dependencies), /already in flight or uncertain/);
  assert.equal(sends, 2); // one envelope creation plus one native send; the second call creates neither
});

test('task round change between snapshot and native resolution prevents approval', async () => {
  const f = fixture(); let reads = 0;
  const current = { ...f.task };
  f.dependencies.load = () => { if (++reads === 1) return loadTask(f.task.id); return { ...current, round: 3 }; };
  await assert.rejects(approveOnce(f.task.id, 'interaction-1', f.dependencies), /changed before resolution/);
  assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'command'), false);
});
