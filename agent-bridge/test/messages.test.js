'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-messages-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
const { writeJsonAtomic } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');
const messages = require('../lib/messages');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

function fixture(state = 'working') {
  const task = { id: 'message-test-' + (++serial), agent: 'agy', stateDir: root, round: 3, status: 'running',
    herdrSession: 'test-service', paneId: 'w1:p1', terminalId: 'term-own', workerSessionId: 'native-session',
    agentName: 'agy', watcherPid: 123, agyDeliveryProfile: { version: '1.4.10', queuedMessages: 'queue' } };
  writeLease(task);
  const native = path.join(root, task.id, 'native-session/transcript.jsonl');
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, '');
  const observed = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
    paneId: task.paneId, terminalId: task.terminalId, state, messageHookVersion: 1, transcriptPath: native };
  writeJsonAtomic(path.join(root, 'tasks', task.id, 'agy-state.json'), observed);
  const agent = { agent: 'agy', agent_status: state, terminal_id: task.terminalId, name: 'agy' };
  const calls = []; let screen = '', body = '', fault = false;
  const admit = text => fs.appendFileSync(native, JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 7, content: text }) + '\n');
  const deps = { inspect: () => agent, call: (session, args) => {
    calls.push(args);
    if (args[1] === 'read') return { result: { text: screen } };
    if (args[1] === 'send-text') { body = args[3]; screen = body; }
    if (args[1] === 'send-keys') {
      if (fault) throw new Error('simulated lost response');
      if (state === 'idle') admit(body); else screen = body + '\n1 queued message';
    }
    return { result: { type: 'ok' } };
  } };
  return { task, deps, agent, observed, native, calls, admit,
    setScreen: value => { screen = value; }, loseReply: () => { fault = true; }, body: () => body };
}

test('idle message distinguishes terminal writes from native acceptance', async () => {
  const f = fixture('idle');
  const receipt = await messages.deliver(f.task, { id: 'idle-one', mode: 'queue', text: 'bounded followup', waitMs: 0 }, f.deps);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.evidence.type, 'native_transcript');
  assert.ok(receipt.history.some(e => e.status === 'text_written'));
  assert.equal(f.task.round, 3); assert.equal(f.task.watcherPid, 123);
});

test('running normal message is queued, never equated with native acceptance', async () => {
  const f = fixture();
  const receipt = await messages.deliver(f.task, { id: 'queue-one', mode: 'queue', text: 'after current work', waitMs: 0 }, f.deps);
  assert.equal(receipt.status, 'queued');
  assert.equal(f.calls.filter(args => args[1] === 'send-keys').length, 1);
  assert.equal(f.calls.find(args => args[1] === 'send-keys')[3], 'enter');
  assert.equal(fs.readFileSync(f.native, 'utf8'), '');
});

test('immediate correction uses a native safe boundary, no keys, cancellation or new round', async () => {
  const f = fixture();
  const receipt = await messages.deliver(f.task, { id: 'steer-one', mode: 'immediate', text: 'keep simulation running; use new threshold', waitMs: 0 }, f.deps);
  assert.equal(receipt.status, 'awaiting_hook'); assert.equal(f.calls.length, 0);
  const response = {};
  await messages.injectAgy(f.task, { conversationId: f.task.workerSessionId, invocationNum: 9, initialNumSteps: 20 }, response);
  assert.equal(response.injectSteps[0].userMessage, receipt.rendered);
  assert.equal(messages.readMessage(f.task, 'steer-one').status, 'injection_prepared');
  assert.notEqual((await messages.reconcile(f.task, 'steer-one', f.deps)).status, 'accepted');
  f.admit(receipt.rendered);
  assert.equal((await messages.reconcile(f.task, 'steer-one', f.deps)).status, 'accepted');
  assert.equal(f.task.round, 3); assert.equal(f.task.workerSessionId, 'native-session');
});

test('duplicate IDs reconcile without retransmission and reject changed content or identity', async () => {
  const f = fixture(); const request = { id: 'dedupe-one', mode: 'queue', text: 'one correction', waitMs: 0 };
  await messages.deliver(f.task, request, f.deps);
  const before = f.calls.filter(args => args[1] === 'send-text').length;
  assert.equal((await messages.deliver(f.task, request, f.deps)).status, 'queued');
  assert.equal(f.calls.filter(args => args[1] === 'send-text').length, before);
  await assert.rejects(messages.deliver(f.task, { ...request, text: 'changed' }, f.deps), /already bound/);
  await assert.rejects(messages.deliver({ ...f.task, round: 4 }, request, f.deps), /already bound/);
});

test('blocked approval and unverified Pane identity never receive text or shortcuts', async () => {
  const f = fixture('blocked');
  const receipt = await messages.deliver(f.task, { id: 'block-one', mode: 'immediate', text: 'correction', waitMs: 0 }, f.deps);
  assert.equal(receipt.status, 'blocked'); assert.equal(f.calls.length, 0);
  const g = fixture(); g.agent.terminal_id = 'someone-else';
  await assert.rejects(messages.deliver(g.task, { id: 'wrong-one', mode: 'queue', text: 'correction' }, g.deps), /identity mismatch/);
  assert.equal(g.calls.length, 0);
});

test('lost submit response stays uncertain until reconciled and is never automatically resent', async () => {
  const f = fixture(); f.loseReply();
  const request = { id: 'recover-one', mode: 'queue', text: 'do not resend', waitMs: 0 };
  assert.equal((await messages.deliver(f.task, request, f.deps)).status, 'uncertain');
  const writes = f.calls.filter(args => args[1] === 'send-text').length;
  f.admit(f.body());
  assert.equal((await messages.deliver(f.task, request, f.deps)).status, 'accepted');
  assert.equal(f.calls.filter(args => args[1] === 'send-text').length, writes);
});

test('native Hook refuses old rounds and already claimed messages; assistant quotes are not receipts', async () => {
  const f = fixture();
  const receipt = await messages.deliver(f.task, { id: 'hook-one', mode: 'immediate', text: 'current round only', waitMs: 0 }, f.deps);
  const response = {};
  await messages.injectAgy({ ...f.task, round: 4 }, { conversationId: 'native-session' }, response);
  assert.equal(response.injectSteps, undefined);
  await messages.injectAgy(f.task, { conversationId: 'native-session' }, response);
  const again = {}; await messages.injectAgy(f.task, { conversationId: 'native-session' }, again);
  assert.equal(again.injectSteps, undefined);
  fs.appendFileSync(f.native, JSON.stringify({ type: 'PLANNER_RESPONSE', content: receipt.rendered }) + '\n');
  assert.notEqual((await messages.reconcile(f.task, 'hook-one', f.deps)).status, 'accepted');
  assert.throws(() => messages.assertMessagesSettled(f.task), /Unconfirmed live messages/);
});
