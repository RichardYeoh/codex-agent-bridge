'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyContinuations, RECOVERY_TEXT } = require('../lib/cbc-native-continuations');

function fixture() {
  const common = { type: 'message', sessionId: 'native-fixture', cwd: process.cwd() };
  return [
    { ...common, id: 'input', role: 'user', timestamp: 1000,
      content: [{ type: 'input_text', text: 'exact task pointer' }],
      providerData: { agent: 'cli', conversationRequestId: 'request-a' } },
    { ...common, id: 'error', parentId: 'input', role: 'assistant', timestamp: 2000, status: 'incomplete',
      content: [{ type: 'output_text', text: 'Connection interrupted. Retrying automatically...' }],
      providerData: { agent: 'cli', conversationRequestId: 'request-a', skipRun: true,
        error: { code: 'ECONNRESET', isNetworkError: true, networkErrorAutoRetry: true,
          isRetryable: true, isStreamTimeout: false } } },
    { ...common, id: 'retry', parentId: 'error', role: 'user', timestamp: 3000,
      content: [{ type: 'input_text', text: RECOVERY_TEXT }],
      providerData: { agent: 'cli', conversationRequestId: 'request-a', isMeta: true, startsNewUserRequest: false } },
  ];
}

test('sanitized native ECONNRESET pair is a continuation; original records are unchanged', () => {
  const rows = fixture(), before = JSON.stringify(rows), result = classifyContinuations(rows);
  assert.deepEqual(result.users.map(x => x.id), ['input']);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].nativeMessageId, 'retry');
  assert.match(result.ignored[0].evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rows), before);
});

const invalid = {
  'ordinary user pasted identical reminder': r => { delete r[2].providerData.isMeta; },
  'new request flag': r => { r[2].providerData.startsNewUserRequest = true; },
  'foreign request': r => { r[2].providerData.conversationRequestId = 'other'; },
  'foreign parent request': r => { r[1].providerData.conversationRequestId = 'other'; },
  'foreign session': r => { r[2].sessionId = 'other'; },
  'foreign cwd': r => { r[1].cwd += '/other'; },
  'broken parent': r => { r[2].parentId = 'unrelated'; },
  'non-network failure': r => { r[1].providerData.error.isNetworkError = false; },
  'quota 429': r => { r[1].providerData.error.code = '429'; },
  'retry disabled': r => { r[1].providerData.error.networkErrorAutoRetry = false; },
  'terminal parent': r => { r[1].status = 'completed'; },
  'no skipRun': r => { delete r[1].providerData.skipRun; },
  'injected history': r => { r[2].providerData.injectedHistory = true; },
  'changed text': r => { r[2].content[0].text += ' do new work'; },
  'extra content': r => { r[2].content.push({ type: 'input_text', text: 'another task' }); },
  'non-CLI source': r => { r[2].providerData.agent = 'other'; },
  'out-of-order': r => { r[2].timestamp = 1999; },
  'missing anchor request': r => { delete r[0].providerData.conversationRequestId; },
  'duplicate native ID': r => { r.push({ ...r[2] }); },
  'missing parent': r => { r.splice(1, 1); },
  'foreign input before retry': r => { r.splice(1, 0, { ...r[0], id: 'foreign', timestamp: 1500,
    providerData: { agent: 'cli', conversationRequestId: 'other' } }); },
};
for (const [name, mutate] of Object.entries(invalid)) test(`do not exclude: ${name}`, () => {
  const rows = fixture(); mutate(rows);
  assert.equal(classifyContinuations(rows).ignored.length, 0);
  assert.ok(classifyContinuations(rows).users.some(x => x.id === 'retry'));
});

test('a later real user input remains a boundary after automatic recovery', () => {
  const rows = fixture(); rows.push({ ...rows[0], id: 'next-task', timestamp: 4000,
    providerData: { agent: 'cli', conversationRequestId: 'request-b' } });
  assert.deepEqual(classifyContinuations(rows).users.map(x => x.id), ['input', 'next-task']);
});

test('repeated verified retries retain the original request and one proof per retry', () => {
  const rows = fixture(); rows.push({ ...rows[1], id: 'error-2', timestamp: 4000 },
    { ...rows[2], id: 'retry-2', parentId: 'error-2', timestamp: 5000 });
  const result = classifyContinuations(rows);
  assert.equal(result.ignored.length, 2); assert.equal(result.users.length, 1);
});
