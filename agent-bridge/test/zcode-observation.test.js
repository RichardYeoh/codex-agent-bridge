'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTurn, observeExecution, queryAdmission } = require('../lib/zcode-observation');
const { waitExecution } = require('../lib/zcode-settlement');
const fixture = require('./fixtures/zcode-snapshot.json');
function snapshot(state = 'running') {
  const value = structuredClone(fixture);
  value.rows.window = [{ kind: 'turnHeader', rowId: 1, sourceCommandId: 'original', state }];
  return value;
}

test('truncated active command is running; unrelated activity and delivery cannot prove completion', async () => {
  const value = snapshot(); value.rows.window = [];
  value.control.activeWorks = [{ sourceCommandId: 'original' }];
  assert.equal((await resolveTurn({}, value, 'original')).state, 'running');
  value.control.activeWorks = [{ sourceCommandId: 'other' }];
  assert.equal((await resolveTurn({ call: async () => ({ rows: [], hasMore: false, atSeq: value.seq, atLogEpoch: value.logEpoch }) }, value, 'original')).seen, false);
});

test('history pagination finds exact terminal command outside 60 rows, validates epoch', async () => {
  const value = snapshot(); value.rows.window = [];
  const calls = [];
  const remote = { target: {}, call: async (_channel, method, args) => {
    calls.push(args); assert.equal(method, 'conversationRowsRangeV4');
    return { atSeq: 9, atLogEpoch: value.logEpoch, hasMore: calls.length === 1,
      rows: calls.length === 1 ? [{ rowId: 201, kind: 'toolCall' }]
        : [{ rowId: 1, kind: 'turnHeader', sourceCommandId: 'original', state: 'completedSuccess' }] };
  } };
  const result = await resolveTurn(remote, value, 'original');
  assert.equal(result.terminal, true); assert.equal(result.evidence, 'conversationRowsRangeV4');
  assert.equal(calls[1].beforeRowId, 201);
  remote.call = async () => ({ atLogEpoch: 'different' });
  await assert.rejects(resolveTurn(remote, value, 'original'), /epoch changed/);
});

test('many observation windows renew without blocking or resubmitting the native task', async () => {
  let windows = 0, reconnects = 0;
  const conversation = { snapshot: snapshot(), remote: {}, wait: async () => {
    const error = new Error('window'); error.code = 'ZCODE_OBSERVATION_WINDOW'; throw error;
  } };
  const result = await observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    refresh: async () => { if (++windows === 4) conversation.snapshot = snapshot('completedSuccess'); },
    reconnect: async () => reconnects++ });
  assert.equal(windows, 4); assert.equal(reconnects, 0); assert.equal(result.result.terminal, true);
});

test('an admitted but not yet visible command gets a time-based snapshot grace without history scans', async () => {
  let clock = 0, polls = 0, refreshes = 0, historyCalls = 0;
  const conversation = { snapshot: snapshot(), remote: { call: async () => { historyCalls++; throw new Error('history scan forbidden during startup grace'); } },
    wait: async () => {
      clock += 1000; polls++;
      if (polls === 4) { conversation.snapshot = snapshot('completedSuccess'); conversation.snapshot.seq = polls; }
    } };
  conversation.snapshot.rows.window = [];
  const result = await observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    admissionConfirmed: true, unseenGraceMs: 10000, unseenPollMs: 2000, clock: () => clock,
    refresh: async () => { refreshes++; } });
  assert.equal(result.result.terminal, true); assert.equal(result.result.state, 'completedSuccess');
  assert.equal(polls, 4); assert.equal(refreshes, 4); assert.equal(historyCalls, 0);
});

test('a previously seen long-running command is recovered from authoritative history after its header leaves the tail', async () => {
  let historyCalls = 0;
  const conversation = { snapshot: snapshot(), remote: { call: async () => {
    historyCalls++;
    return { atSeq: conversation.snapshot.seq, atLogEpoch: conversation.snapshot.logEpoch, hasMore: false,
      rows: [{ kind: 'turnHeader', rowId: 1, sourceCommandId: 'original', state: 'completedSuccess' }] };
  } }, wait: async () => { conversation.snapshot.rows.window = []; conversation.snapshot.control.activeWorks = []; } };
  conversation.snapshot.rows.window = [];
  conversation.snapshot.control.activeWorks = [{ sourceCommandId: 'original' }];
  const result = await observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    admissionConfirmed: true, initialHeaderRowId: 1, refresh: async () => {} });
  assert.equal(result.result.terminal, true);
  assert.equal(result.result.state, 'completedSuccess');
  assert.equal(result.result.evidence, 'conversationRowsRangeV4');
  assert.equal(historyCalls, 1);
});

test('accepted admission remains execution-unconfirmed after the bounded observation grace', async () => {
  let clock = 0, historyCalls = 0;
  const conversation = { snapshot: snapshot(), remote: { call: async () => { historyCalls++; return {
    rows: [], hasMore: false, atSeq: conversation.snapshot.seq, atLogEpoch: conversation.snapshot.logEpoch }; } },
    wait: async () => { clock += 5000; } };
  conversation.snapshot.rows.window = [];
  await assert.rejects(observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    admissionConfirmed: true, unseenGraceMs: 6000, unseenPollMs: 5000, clock: () => clock,
    refresh: async () => {} }), /observation grace; execution remains unconfirmed/);
  assert.equal(historyCalls, 1);
});

test('network recovery is bounded and exclusive seat conflict never reconnects', async () => {
  let retries = 0;
  const conversation = { snapshot: snapshot(), remote: {}, wait: async () => { throw new Error('network disconnected'); } };
  await assert.rejects(observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    refresh: async () => {}, reconnect: async () => { retries++; }, maxReconnects: 3, sleep: async () => {} }), /network/);
  assert.equal(retries, 3);
  conversation.wait = async () => { throw new Error('ZCode relay KICKED'); };
  await assert.rejects(observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    reconnect: async () => retries++, sleep: async () => {} }), /KICKED/);
  assert.equal(retries, 3);
});

test('approval and native failure remain explicit; missing evidence stays uncertain', async () => {
  const conversation = { snapshot: snapshot('failed'), remote: {} };
  const options = { getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    maxUnconfirmed: 1 };
  assert.equal((await observeExecution(options)).result.state, 'failed');
  conversation.snapshot = snapshot(); conversation.snapshot.pendingInteractions = [{}];
  assert.equal((await observeExecution(options)).interaction, true);
  conversation.snapshot = snapshot(); conversation.snapshot.rows.window = [];
  conversation.remote.call = async () => ({ rows: [], hasMore: false, atSeq: 0, atLogEpoch: 'test-epoch' });
  await assert.rejects(observeExecution(options), /submission_unconfirmed/);
});

test('uncertain create/send acknowledgement queries original key without sending', async () => {
  for (const sessionId of [null, 'session-test']) {
    const envelope = { commandId: 'original', sessionId }; let queries = 0;
    const ack = { status: 'accepted', commandId: 'original' };
    const remote = { query: async received => {
      assert.equal(received, envelope);
      return { results: [{ key: envelope, result: ++queries === 1 ? 'unknown' : ack }] };
    } };
    assert.equal(await queryAdmission(remote, envelope, { sleep: async () => {} }), ack);
    assert.equal(queries, 2);
  }
});

test('watcher ignores stale blocked projection and survives multiple long windows and a moved tab', async () => {
  let clock = 0, reads = 0;
  const task = { herdrSession: 'test', paneId: 'w1:p1', terminalId: 'terminal', agent: 'zcode' };
  const result = await waitExecution(task, { clock: () => clock,
    inspect: () => ({ agent: 'zcode', terminal_id: 'terminal', tab_id: 'moved', agent_status: 'blocked' }),
    read: () => ++reads === 1 ? null : { state: reads === 6 ? 'idle' : 'working' },
    pause: async () => { clock += 1800000; }, startupMs: 3600000 });
  assert.equal(result.agent_status, 'idle'); assert.equal(reads, 6);
});

test('persisted header cursor retrieves fresh terminal state without scanning a huge tail', async () => {
  const value = snapshot(); value.rows.window = [];
  let cursor;
  const result = await resolveTurn({ call: async (_channel, _method, args) => {
    cursor = args.beforeRowId;
    return { atLogEpoch: value.logEpoch, atSeq: value.seq, rows: [
      { rowId: 1, kind: 'turnHeader', sourceCommandId: 'original', state: 'completedSuccess' }], hasMore: false };
  } }, value, 'original', { headerRowId: 1 });
  assert.equal(cursor, 2); assert.equal(result.terminal, true);
  value.control.activeWorks = [{ sourceCommandId: 'original' }]; value.rows.window = [result.header];
  assert.equal((await resolveTurn({}, value, 'original')).terminal, false);
});

test('disconnected admission reconnects read-only and cancelled rounds stop local observation', async () => {
  let connects = 0;
  const envelope = { commandId: 'original', sessionId: 'session-test' };
  const remote = { query: async () => { if (!connects) throw new Error('disconnected');
    return { results: [{ key: envelope, result: { commandId: 'original', status: 'accepted' } }] }; } };
  assert.equal((await queryAdmission(() => remote, envelope, { reconnect: async () => connects++, sleep: async () => {} })).status, 'accepted');
  assert.equal(connects, 1);
  assert.equal(await waitExecution({}, { isActive: () => false, inspect: () => { throw new Error('must not inspect'); } }), null);
});

test('an old completed command cannot settle a session with newer untracked native work', async () => {
  const conversation = { snapshot: snapshot('completedSuccess'), remote: {} };
  conversation.snapshot.control.activeWorks = [{ sourceCommandId: 'manual-next-command' }];
  const result = await observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test' });
  assert.equal(result.foreignWork, true); assert.equal(result.result.state, 'completedSuccess');
});

test('local seat contention stops observation and admission recovery without retrying another owner', async () => {
  let reconnects = 0;
  const error = Object.assign(new Error('local owner'), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
  const conversation = { snapshot: snapshot(), remote: {}, wait: async () => { throw error; } };
  await assert.rejects(observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    reconnect: async () => reconnects++, sleep: async () => {} }), { code: error.code });
  await assert.rejects(queryAdmission({ query: async () => { throw error; } }, {}, {
    reconnect: async () => reconnects++, sleep: async () => {} }), { code: error.code });
  assert.equal(reconnects, 0);
});

test('a replaced local binding detaches observation without reconnecting to the old Pane', async () => {
  let reconnects = 0;
  const conversation = { snapshot: snapshot(), remote: {}, wait: async () => new Promise(() => {}) };
  const error = Object.assign(new Error('Pane binding replaced'), { code: 'ZCODE_LOCAL_BINDING_REPLACED' });
  await assert.rejects(observeExecution({ getConversation: () => conversation, commandId: 'original', sessionId: 'session-test',
    checkpoint: () => { throw error; }, reconnect: async () => { reconnects++; }, sleep: async () => {} }), { code: error.code });
  assert.equal(reconnects, 0);
});
