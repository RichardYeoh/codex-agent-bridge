'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ZCodeRemote, Conversation, readBinding, selectedModel, turnState, needsFullContext } = require('../lib/zcode-remote');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-zcode-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Desktop binding is restricted to the official remote endpoint', () => {
  const file = path.join(root, 'binding.json');
  for (const remoteUrl of ['https://example.org/remote/v4?sid=demo&mid=demo',
    'https://zcode.z.ai/other?sid=demo&mid=demo', 'https://user:pass@zcode.z.ai/remote/v4?sid=demo&mid=demo',
    'https://zcode.z.ai/remote/v4?sid=demo']) {
    fs.writeFileSync(file, JSON.stringify({ remoteUrl }));
    assert.throws(() => readBinding(file));
  }
  fs.writeFileSync(file, JSON.stringify({ remoteUrl: 'https://zcode.z.ai/remote/v4?sid=demo&mid=sample' }));
  assert.deepEqual(readBinding(file), { sid: 'demo', mid: 'sample' });
  assert.deepEqual(selectedModel(), { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } });
  assert.throws(() => selectedModel('arbitrary/provider'));
  assert.throws(() => selectedModel(undefined, 'guess'));
});

test('missing login stops before network; HTTP redirects cannot receive shared authentication', async () => {
  let count = 0;
  const missing = new ZCodeRemote({}, { credential: () => undefined, fetcher: () => { count++; } });
  await assert.rejects(missing.connect(), /login unavailable/);
  assert.equal(count, 0);
  const rejected = new ZCodeRemote({}, { credential: key => { assert.equal(key, 'zcodejwttoken'); return 'test-only-login'; },
    fetcher: async (url, options) => {
      count++; assert.equal(url, 'https://zcode.z.ai/api/v1/remote/token');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-only-login');
      return { ok: false, status: 401 };
    } });
  await assert.rejects(rejected.connect(), /rejected \(401\)/);
  assert.equal(count, 1);
});

test('native relay pairs after waiting and stops on seat conflict without reconnecting', async () => {
  let sockets = 0, socket;
  class FakeSocket extends EventEmitter {
    constructor() { super(); sockets++; socket = this; this.readyState = 1; queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type === 'auth_init') queueMicrotask(() => {
        this.emit('message', JSON.stringify({ type: 'auth_ack', pair_status: 'waiting' }));
        this.emit('message', JSON.stringify({ type: 'pair_status_ack', pair_status: 'matched' }));
      });
      if (frame.payload?.zcode_type === 'bootstrap-request') queueMicrotask(() => this.emit('message', JSON.stringify({
        type: 'data', payload: { zcode_type: 'bootstrap-response', requestId: frame.payload.requestId, success: true, result: { workspaces: [] } },
      })));
    }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const remote = new ZCodeRemote({ sid: 'demo', mid: 'demo' }, { socket: FakeSocket, credential: () => 'test-only-login',
    fetcher: async () => ({ ok: true, json: async () => ({ code: 0, data: { token: 'test-only-one-use' } }) }) });
  const faults = []; remote.on('fault', error => faults.push(error.message));
  assert.deepEqual(await remote.connect(), { workspaces: [] });
  socket.emit('message', JSON.stringify({ type: 'error', code: 'KICKED' }));
  assert.equal(remote.closed, true); assert.deepEqual(faults, ['ZCode relay KICKED']); assert.equal(sockets, 1);
});

test('uncertain RPC writes retain their command identity and are never automatically resent', async () => {
  const remote = new ZCodeRemote({}, { timeoutMs: 15 });
  let calls = 0;
  remote.target = { workspacePath: root };
  remote.client = { getChannel: () => ({ call: () => { calls++; return new Promise(() => {}); } }) };
  const envelope = remote.envelope('sendText', 'session-test', { text: 'task' }, 'stable-command');
  await assert.rejects(remote.command(envelope), /acknowledgement uncertain/);
  assert.equal(calls, 1); assert.equal(envelope.commandId, 'stable-command');
});

test('only the current command turn can settle execution; old successes and user text cannot', () => {
  const snapshot = { rows: { window: [{ kind: 'userInput', text: 'DONE' },
    { kind: 'turnHeader', sourceCommandId: 'old', state: 'completedSuccess' },
    { kind: 'turnHeader', sourceCommandId: 'current', state: 'running' }] }, control: { lastError: null } };
  assert.equal(turnState(snapshot, 'current').terminal, false);
  assert.equal(turnState(snapshot, 'unknown').seen, false);
  snapshot.rows.window[2].state = 'completedInterrupted';
  assert.equal(turnState(snapshot, 'current').terminal, true);
});

test('compaction or truncated history requires a fresh full baseline after reconnect', () => {
  assert.equal(needsFullContext({ rows: { totalCount: 0, window: [] } }), false);
  assert.equal(needsFullContext({ rows: { totalCount: 2, window: [] } }), true);
  assert.equal(needsFullContext({ rows: { totalCount: 1, window: [
    { kind: 'timelineMarker', marker: { type: 'compact', status: 'success' } }] } }), true);
});

test('conversation uses the acknowledged subscription ID and rejects gaps without inventing completion', async () => {
  const fixture = require('./fixtures/zcode-snapshot.json');
  let listener, unsubscribed;
  const remote = new EventEmitter(); remote.target = { workspacePath: root };
  remote.listen = (_channel, _name, _args, fn) => { listener = fn; return { dispose() {} }; };
  const wire = (ordinal, frame) => ({ wireVersion: 3, kind: 'complete', deliveryKind: ordinal === 1 ? 'initial' : 'online',
    logicalFrameId: `frame-${ordinal}`, logicalFrameOrdinal: ordinal, topic: 'conversation/session-test', subscriptionId: 'subscription-test', frame });
  remote.call = async (_channel, method, args) => {
    if (method === 'unsubscribeConversationV4') { unsubscribed = args.subscriptionId; return; }
    queueMicrotask(() => listener(wire(1, { topic: 'conversation/session-test', subscriptionId: 'subscription-test',
      fromSeq: 0, toSeq: 0, sentAt: 1, payload: { kind: 'snapshot', snapshot: structuredClone(fixture) } })));
    return { ack: { subscriptionId: 'subscription-test' } };
  };
  const conversation = new Conversation(remote, 'session-test');
  const faults = []; conversation.on('fault', error => faults.push(error.message));
  assert.equal((await conversation.subscribe()).sessionId, 'session-test');
  listener(wire(2, { topic: 'conversation/session-test', subscriptionId: 'subscription-test', fromSeq: 3, toSeq: 4,
    sentAt: 2, payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { revision: 4 } }] } }));
  assert.match(faults[0], /sequence gap/);
  assert.equal(conversation.snapshot.seq, 0);
  await conversation.dispose(); assert.equal(unsubscribed, 'subscription-test');
});
