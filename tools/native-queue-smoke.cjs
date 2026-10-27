'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const bridgeRoot = path.resolve(__dirname, '../agent-bridge');
process.env.AGENT_BRIDGE_STATE_DIR = path.join(__dirname, '../.local', `native-state-${Date.now()}`);
const { saveTask } = require(path.join(bridgeRoot, 'lib/util'));
const { createQueueClient } = require(path.join(bridgeRoot, 'lib/codex-client'));
const { notifyTask, acknowledgeTask } = require(path.join(bridgeRoot, 'lib/notify'));
const { scope, ownsItem, reconcileThread, setPaused } = require(path.join(bridgeRoot, 'lib/notification-control'));

async function main() {
  const thread = process.env.CODEX_THREAD_ID;
  assert.ok(thread, 'An active controller thread is required');
  const client = await createQueueClient();
  const current = scope(thread);
  const counts = { add: 0, update: 0 };
  const options = { clientFactory: async () => ({ ...client, close() {},
    async add(...args) { counts.add += 1; return client.add(...args); },
    async update(...args) { counts.update += 1; return client.update(...args); },
  }) };
  const initial = await client.list(thread);
  let sentinel;
  const result = { thread, stateRoot: current.root, initialQueue: initial.length };
  const owned = async () => (await client.list(thread)).filter(item => ownsItem(item, current, new Set()));
  try {
    sentinel = await client.add(thread, 'Temporary queue preservation probe; remove before controller turn ends.', crypto.randomUUID());
    const value = { id: 'native-notify-test', agent: 'cbc', stateDir: current.root,
      codexThread: thread, round: 1, status: 'review_pending', history: [] };
    for (let round = 1; round <= 6; round += 1) {
      value.round = round;
      value.completionSeq = round;
      await notifyTask(value, options);
      assert.equal(value.notification.status, 'queued', value.notification.error);
      assert.equal((await owned()).length, 1);
    }
    assert.equal(counts.add, 1);
    assert.equal(counts.update, 5);
    await acknowledgeTask(value, value.notification.key, options);
    assert.equal((await owned()).length, 0);
    result.sixRounds = { ...counts, ownedAfterAck: 0 };
    value.round = 7;
    await notifyTask(value, options);
    await setPaused(thread, true, options);
    assert.equal((await owned()).length, 0);
    assert.ok((await client.list(thread)).some(item => item.id === sentinel.id));
    value.round = 8;
    await notifyTask(value, options);
    assert.equal(value.notification.status, 'paused');
    await setPaused(thread, false, options);
    assert.equal((await owned()).length, 1);
    value.status = 'accepted';
    saveTask(value);
    await reconcileThread(thread, options);
    assert.equal((await owned()).length, 0);
    await setPaused(thread, false, options);
    assert.equal((await owned()).length, 0);
    result.pauseResumeAccept = 'passed';
    result.preservedOtherQueueEntry = true;
    result.passed = true;
  } finally {
    // Withdraw only entries created by this experiment. / 仅撤回本次实验创建的条目。
    for (const item of await owned()) await client.remove(thread, item.id);
    if (sentinel) await client.remove(thread, sentinel.id);
    const final = await client.list(thread);
    result.finalQueue = final.length;
    result.finalOwned = final.filter(item => ownsItem(item, current, new Set())).length;
    result.initialEntriesPreserved = initial.every(item => final.some(entry => entry.id === item.id));
    client.close();
    fs.writeFileSync(path.join(__dirname, '../.local/native-queue-result.json'), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
