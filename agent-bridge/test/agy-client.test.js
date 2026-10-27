'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { AgyClient, buildArgs } = require('../lib/agy-client');
const binary = path.join(__dirname, 'fixtures', 'agy-stub.cjs');

function session(t, id) {
  const client = new AgyClient(binary, { cwd: __dirname, skipPermissions: true }, id);
  t.after(async () => {
    if (client.child.exitCode !== null) return;
    const exited = once(client.child, 'exit'); client.child.kill(); await exited;
  });
  return client;
}

test('agy arguments pin explicit conversation/model/effort without selecting the most recent conversation', () => {
  const args = buildArgs({ permissionMode: 'acceptEdits', skipPermissions: false, model: 'chosen', effort: 'low' }, 'native-id');
  assert.deepEqual(args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
    '--conversation', 'native-id', '--mode', 'accept-edits', '--model', 'chosen', '--effort', 'low']);
  assert.equal(buildArgs({ skipPermissions: true }).includes('--dangerously-skip-permissions'), true);
  assert.equal(args.includes('--continue'), false);
});

test('native identity survives a fresh CLI process and multiple warm prompts', async t => {
  const first = session(t);
  const id = await first.ready;
  assert.equal((await first.prompt('ONE')).response, '中文结果');
  assert.equal((await first.prompt('TWO')).status, 'SUCCESS');
  const second = session(t, id);
  assert.equal(await second.ready, id);
  assert.equal((await second.prompt('THREE')).conversation_id, id);
});

test('concurrent prompts and corrupt transport never trigger automatic retries', async t => {
  const client = session(t); await client.ready;
  const waiting = client.prompt('WAIT');
  await assert.rejects(client.prompt('SECOND'), /busy/);
  client.receive(Buffer.from('invalid json\n'));
  await assert.rejects(waiting, /Invalid Antigravity JSON/);
});

test('unexpected native identity blocks cold restoration before sending a prompt', async t => {
  const client = session(t, 'expected');
  const fault = once(client, 'fault');
  // Feed an unexpected native ID before the fixture can initialize. / 在夹具初始化前注入不匹配的原生ID。
  client.receive(Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'wrong' }) + '\n'));
  await assert.rejects(client.ready, /identity changed/);
  assert.match((await fault)[0].message, /identity changed/);
});

test('CLI error envelopes preserve failure instead of claiming task success', async t => {
  const client = session(t); await client.ready;
  const result = await client.prompt('ERROR');
  assert.equal(result.status, 'ERROR'); assert.equal(result.error, 'quota exhausted');
});

test('soft-denied tools remain observable even when the CLI reports SUCCESS', async t => {
  const client = session(t); await client.ready;
  // Structured tool evidence is independent of stderr delivery ordering. / 结构化工具证据不依赖stderr到达顺序。
  const pending = client.prompt('WAIT');
  client.receive(Buffer.from(JSON.stringify({ event: 'step_update', step_update: { conversation_id: client.sessionId,
    tool_info: { error: { message: 'permission denied: requires approval' } } } }) + '\n'));
  client.receive(Buffer.from(JSON.stringify({ event: 'result', result: { conversation_id: client.sessionId, status: 'SUCCESS' } }) + '\n'));
  const result = await pending;
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.permissionDenied, true);
});
