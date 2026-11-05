'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createQueueClient } = require('../lib/codex-client');

function fixture({ denied = false, dropAdd = false, rejectAdd = false, repeatCursor = false } = {}) {
  const child = new EventEmitter(), calls = [];
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => child.emit('exit', 0) });
  let socket;
  const secret = 'fixture-' + 'sensitive'.repeat(8);
  class Socket extends EventEmitter {
    constructor(_url, options) {
      super(); socket = this; this.stream = options.createConnection();
      setImmediate(() => {
        if (!denied) return this.emit('open');
        child.stderr.write('PermissionDenied ' + secret.slice(0, 20));
        const error = new Error('socket hang up'); error.code = 'ECONNRESET'; this.emit('error', error);
        setTimeout(() => { child.stderr.write(secret.slice(20)); child.emit('exit', 1); }, 5);
      });
    }
    send(text, callback) {
      const request = JSON.parse(text); calls.push(request);
      if (request.id == null) return;
      if (dropAdd && request.method === 'thread/queue/add') {
        setImmediate(() => this.emit('error', new Error('transport lost after send'))); return;
      }
      const result = request.method === 'thread/read' ? { thread: { id: request.params.threadId, turns: [] } }
        : request.method === 'thread/queue/list' ? { data: [], nextCursor: repeatCursor ? 'same-cursor' : null }
          : request.method === 'thread/queue/add' ? { queuedSubmission: { id: 'fixture-queue' } } : {};
      setImmediate(() => this.emit('message', JSON.stringify(request.method === 'thread/queue/add' && rejectAdd
        ? { id: request.id, error: { code: -32603, message: 'no rollout found' } } : { id: request.id, result })));
      callback?.();
    }
    terminate() { this.stream.destroy(); this.emit('close'); child.emit('exit', 0); }
  }
  return { calls, child, secret, options: { spawnProcess: () => child, Socket, timeoutMs: 100 }, socket: () => socket };
}

test('Codex proxy read-only diagnostics use initialization and metadata/list without resuming or adding', async () => {
  const f = fixture(), client = await createQueueClient(f.options);
  try {
    assert.equal((await client.readMetadata('fixture-thread')).id, 'fixture-thread');
    assert.deepEqual(await client.list('fixture-thread'), []);
    assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'thread/read', 'thread/queue/list']);
    assert.equal(f.calls.find(call => call.method === 'thread/read').params.includeTurns, false);
  } finally { client.close(); }
});

test('queue pagination rejects a repeating cursor instead of looping forever', async () => {
  const f = fixture({ repeatCursor: true }), client = await createQueueClient(f.options);
  try {
    await assert.rejects(client.list('fixture-thread'), /pagination repeated/);
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/list').length, 2);
    assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  } finally { client.close(); }
});

test('proxy permission denial is classified before RPC send and raw fragmented stderr is never exposed', async () => {
  const f = fixture({ denied: true });
  await assert.rejects(createQueueClient(f.options), error => {
    assert.equal(error.code, 'CODEX_PROXY_ACCESS_DENIED'); assert.equal(error.phase, 'connect');
    assert.equal(error.requestSent, false); assert.equal(error.diagnostic.proxyOpened, false);
    assert.equal(JSON.stringify(error).includes(f.secret), false); assert.equal(error.message.includes(f.secret), false);
    assert.deepEqual(f.calls, []); return true;
  });
});

test('closed client cannot misreport an unsent add as uncertain delivery', async () => {
  const f = fixture(), client = await createQueueClient(f.options); client.close();
  await assert.rejects(client.add('fixture-thread', 'fixture-text', 'fixture-id'), error => {
    assert.equal(error.requestSent, false); assert.notEqual(error.deliveryUncertain, true); return true;
  });
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
});

test('queue rejection stays distinct from uncertain post-send transport loss, with no automatic replay', async () => {
  for (const options of [{ rejectAdd: true }, { dropAdd: true }]) {
    const f = fixture(options), client = await createQueueClient(f.options);
    try {
      await assert.rejects(client.add('fixture-thread', 'fixture-text', 'fixture-id'), error => {
        if (options.rejectAdd) { assert.equal(error.code, -32603); assert.notEqual(error.deliveryUncertain, true); }
        else { assert.equal(error.requestSent, true); assert.equal(error.deliveryUncertain, true); }
        return true;
      });
      assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
      assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
    } finally { client.close(); }
  }
});
