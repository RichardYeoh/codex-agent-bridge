'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { notifyTask } = require('../lib/notify');
const { controlState, scope, WAKE_RETRY_DELAY_MS } = require('../lib/notification-control');
const { loadTask, saveTask, withLock, writeJsonAtomic } = require('../lib/util');
const { memoryQueue } = require('./fixtures/queue-client.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hark-notify-'));
let serial = 0;
test.beforeEach(() => { process.env.AGENT_BRIDGE_STATE_DIR = path.join(root, String(++serial)); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function task(id) {
  return { id, agent: 'agy', round: 1, completionSeq: 1, status: 'review_pending', history: [],
    codexThread: 'hark-controller', stateDir: process.env.AGENT_BRIDGE_STATE_DIR };
}

function ageRetry(threadId, value) {
  const current = controlState(threadId);
  const timestamp = new Date(Date.now() - WAKE_RETRY_DELAY_MS - 1).toISOString();
  writeJsonAtomic(scope(threadId).file, { ...current, lastAttemptAt: timestamp });
  if (value?.notification) { value.notification.lastAttemptAt = timestamp; saveTask(value); }
}

test('consumed unacknowledged wakes receive bounded, idempotent reminders after a fresh queue check', async () => {
  const queue = memoryQueue();
  const value = task('hark-notify-bounded');
  const options = { clientFactory: queue.clientFactory };

  await notifyTask(value, options);
  assert.equal(value.notification.status, 'queued');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);

  queue.items.length = 0;
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'consumed');
  assert.equal(value.notification.queueId, null);
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);

  ageRetry(value.codexThread, value);
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'queued');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 2);
  const firstRetryId = queue.items[0].clientUserMessageId;

  await notifyTask(value, options);
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 2);
  assert.equal(queue.items[0].clientUserMessageId, firstRetryId);

  queue.items.length = 0;
  ageRetry(value.codexThread, value);
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'queued');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 3);
  assert.notEqual(queue.items[0].clientUserMessageId, firstRetryId);

  queue.items.length = 0;
  ageRetry(value.codexThread, value);
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'consumed');
  assert.equal(value.notification.deliveryAttempts, 3);
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 3);
});

test('read-only queue timeout never becomes a write-uncertain state or triggers add', async () => {
  const queue = memoryQueue();
  const value = task('hark-notify-read-timeout');
  const first = { clientFactory: queue.clientFactory };
  await notifyTask(value, first);
  assert.equal(value.notification.status, 'queued');

  const before = queue.calls.filter(call => call.method === 'add').length;
  const readFailure = { clientFactory: async () => {
    const client = await queue.clientFactory();
    return { ...client, async list() {
      const error = new Error('queue list timeout'); error.code = 'ETIMEDOUT'; error.deliveryUncertain = true; throw error;
    } };
  } };
  await notifyTask(value, readFailure);
  assert.equal(value.notification.status, 'queued');
  assert.notEqual(value.notification.status, 'uncertain');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, before);
});

test('future and invalid retry timestamps fail closed instead of causing a resend loop', async () => {
  const queue = memoryQueue();
  const value = task('hark-notify-freshness');
  await notifyTask(value, { clientFactory: queue.clientFactory });
  queue.items.length = 0;
  const future = new Date(Date.now() + WAKE_RETRY_DELAY_MS * 10).toISOString();
  value.notification.lastAttemptAt = future;
  saveTask(value);
  writeJsonAtomic(scope(value.codexThread).file, { ...controlState(value.codexThread), lastAttemptAt: future });
  await notifyTask(value, { clientFactory: queue.clientFactory });
  assert.equal(value.notification.status, 'consumed');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);

  value.notification.lastAttemptAt = 'not-a-timestamp';
  saveTask(value);
  writeJsonAtomic(scope(value.codexThread).file, { ...controlState(value.codexThread), lastAttemptAt: 'not-a-timestamp' });
  await notifyTask(value, { clientFactory: queue.clientFactory });
  assert.equal(value.notification.status, 'consumed');
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);
});

test('an uncertain add reuses its persisted idempotency ID after a successful absence check', async () => {
  const queue = memoryQueue();
  const ids = [];
  let sends = 0;
  const options = { clientFactory: async () => {
    const client = await queue.clientFactory();
    return { ...client, async add(thread, text, id) {
      ids.push(id); sends += 1;
      if (sends === 1) { const error = new Error('reply lost'); error.deliveryUncertain = true; throw error; }
      return client.add(thread, text, id);
    } };
  } };
  const value = task('hark-notify-idempotent');
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'uncertain');
  ageRetry(value.codexThread, value);
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'queued');
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('late queue results cannot overwrite a concurrently advanced task round', async () => {
  const queue = memoryQueue();
  const value = task('hark-notify-stale-commit');
  saveTask(value);
  let signalList;
  const listed = new Promise(resolve => { signalList = resolve; });
  let releaseList;
  const gate = new Promise(resolve => { releaseList = resolve; });
  let first = true;
  const clientFactory = async () => {
    const client = await queue.clientFactory();
    return { ...client, async list(threadId) {
      if (first) { first = false; signalList(); await gate; }
      return client.list(threadId);
    } };
  };
  const pendingNotification = notifyTask(value, { clientFactory });
  await listed;

  const updateTask = withLock(value.id, () => {
    const current = loadTask(value.id);
    current.round = 2;
    current.completionSeq = 2;
    current.status = 'running';
    saveTask(current);
  });
  const lockWasAvailable = await Promise.race([
    updateTask.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  releaseList();
  await pendingNotification;
  await updateTask;

  assert.equal(lockWasAvailable, true);
  assert.equal(loadTask(value.id).round, 2);
  assert.equal(loadTask(value.id).status, 'running');
  assert.equal(queue.items.length, 0);
});
