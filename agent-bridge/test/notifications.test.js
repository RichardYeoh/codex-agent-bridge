'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryQueue } = require('./fixtures/queue-client.cjs');
const { saveTask, loadTask } = require('../lib/util');
const { notifyTask, acknowledgeTask } = require('../lib/notify');
const { pendingTasks, reconcileThread, setPaused } = require('../lib/notification-control');
const { classifyBlocker } = require('../lib/blocker');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notifications-'));
let index = 0;
test.beforeEach(() => { process.env.AGENT_BRIDGE_STATE_DIR = path.join(root, String(++index)); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function task(id, round = 1) {
  return { id, agent: 'cbc', round, completionSeq: round, status: 'review_pending', history: [],
    codexThread: 'test-controller', stateDir: process.env.AGENT_BRIDGE_STATE_DIR };
}

test('multiple rounds coalesce to one wake and acknowledging removes the queued wake', async () => {
  const queue = memoryQueue();
  const options = { clientFactory: queue.clientFactory };
  const value = task('notify-rounds');
  for (let round = 1; round <= 6; round += 1) {
    value.round = round;
    value.completionSeq = round;
    await notifyTask(value, options);
    assert.equal(queue.items.length, 1);
  }
  assert.equal(queue.calls.filter(call => call.method === 'add').length, 1);
  assert.match(queue.items[0].input[0].text, /r6/);
  await acknowledgeTask(value, value.notification.key, options);
  assert.equal(queue.items.length, 0);
  assert.equal(pendingTasks(value.codexThread).length, 0);
});

test('pause withdraws only bridge messages and resume does not replay accepted work', async () => {
  const queue = memoryQueue();
  const options = { clientFactory: queue.clientFactory };
  queue.items.push({ id: 'user-message', input: [{ type: 'text', text: 'Keep my own follow-up' }] });
  const value = task('notify-pause');
  await notifyTask(value, options);
  const paused = await setPaused(value.codexThread, true, options);
  assert.equal(paused.paused, true);
  assert.deepEqual(queue.items.map(item => item.id), ['user-message']);
  value.round = 2;
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'paused');
  value.status = 'accepted';
  saveTask(value);
  await setPaused(value.codexThread, false, options);
  assert.deepEqual(queue.items.map(item => item.id), ['user-message']);
});

test('ack one task keeps another task pending; acceptance and rework prune obsolete wakes', async () => {
  const queue = memoryQueue();
  const options = { clientFactory: queue.clientFactory };
  const first = task('notify-first');
  const second = task('notify-second');
  await notifyTask(first, options);
  await notifyTask(second, options);
  await acknowledgeTask(first, first.notification.key, options);
  assert.equal(queue.items.length, 1);
  assert.doesNotMatch(queue.items[0].input[0].text, /notify-first/);
  second.status = 'running';
  saveTask(second);
  await reconcileThread(second.codexThread, options);
  assert.equal(queue.items.length, 0);
});

test('local pending state survives notification transport failure without a resend loop', async () => {
  const queue = memoryQueue();
  queue.fail = true;
  const options = { clientFactory: queue.clientFactory };
  const value = task('notify-offline');
  await notifyTask(value, options);
  assert.equal(loadTask(value.id).status, 'review_pending');
  assert.equal(loadTask(value.id).notification.status, 'pending');
  assert.equal(queue.calls.length, 0);
  queue.fail = false;
  await notifyTask(loadTask(value.id), options);
  assert.equal(queue.items.length, 1);
});

test('quota, rate limit and network blockers are classified without treating normal credits as errors', () => {
  assert.equal(classifyBlocker('API error: insufficient_quota').type, 'quota');
  assert.equal(classifyBlocker('429 Too Many Requests').type, 'rate_limit');
  assert.equal(classifyBlocker('fetch failed: ENOTFOUND api.example.test').type, 'network');
  assert.equal(classifyBlocker('Credits: 8.2; task completed'), null);
});

test('a lost add reply remains uncertain and is not automatically submitted again', async () => {
  const queue = memoryQueue();
  let attempts = 0;
  const options = { clientFactory: async () => {
    const client = await queue.clientFactory();
    return { ...client, async add() {
      attempts += 1;
      const error = new Error('Connection closed after send');
      error.deliveryUncertain = true;
      throw error;
    } };
  } };
  const value = task('lost-add-reply');
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'uncertain');
  await notifyTask(value, options);
  assert.equal(value.notification.status, 'uncertain');
  assert.equal(attempts, 1);
});
