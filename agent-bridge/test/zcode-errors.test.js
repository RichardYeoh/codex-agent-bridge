'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnostic, failureReason } = require('../lib/zcode-errors');
const { ZCodeRemote } = require('../lib/zcode-remote');

test('diagnostics retain stage and safe error while excluding login URLs and payload values', () => {
  const error = new Error('connect https://host/path?token=sensitive-jwt-123 Bearer abc token=xyz session_private');
  const value = diagnostic(error, 'subscribe');
  assert.equal(value.stage, 'subscribe');
  for (const secret of ['sensitive-jwt-123', 'abc', 'xyz', 'session_private']) assert.equal(value.message.includes(secret), false);
  assert.equal(failureReason(new Error('ZCode relay KICKED'), 'fallback'), 'relay_kicked');
  const cause = new Error('private payload'); cause.issues = [{ path: ['rows', 2], code: 'invalid_type', input: 'private payload' }];
  assert.equal(JSON.stringify(diagnostic(new Error('validation', { cause }), 'observe')).includes('private payload'), false);
});

test('a KICKED during RPC stays KICKED rather than generic disposal, so recovery cannot compete for seat', async () => {
  const remote = new ZCodeRemote({}); remote.on('fault', () => {});
  let rejectCall;
  remote.client = { getChannel: () => ({ call: () => new Promise((_resolve, reject) => { rejectCall = reject; }) }),
    dispose: () => rejectCall(new Error('ChannelClient disposed')) };
  const pending = remote.call('zcode-agent', 'read');
  remote.fail('ZCode relay KICKED');
  await assert.rejects(pending, /KICKED/);
  await assert.rejects(remote.call('zcode-agent', 'read'), /KICKED/);
});
