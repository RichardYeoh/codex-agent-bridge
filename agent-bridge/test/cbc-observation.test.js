'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitExecution } = require('../lib/cbc-observation');

function makeTask(waitTimeoutMs = 100) {
  return { id: 'cbc-observation-fixture', agent: 'cbc', herdrSession: 'fixture-herdr',
    paneId: 'w1:p1', terminalId: 'fixture-terminal', agentName: 'cbc-fixture',
    workerSessionId: 'fixture-native-session', waitTimeoutMs };
}

function worker(agent_status = 'idle', state_change_seq = 9) {
  return { agent: 'codebuddy', name: 'cbc-fixture', terminal_id: 'fixture-terminal',
    agent_session: { value: 'fixture-native-session' }, agent_status, state_change_seq };
}

function fakeTime() {
  let now = 0;
  const pauses = [];
  return { clock: () => now, pauses, pause: async ms => { pauses.push(ms); now += ms; }, now: () => now };
}

const noVerify = async () => {};
const activeTurn = () => ({ state: 'active', submittedAt: '2026-11-04T00:00:00.000Z' });
const stoppedTurn = stopAt => ({ ...activeTurn(), state: 'stopped', stopAt });

test('temporary process query failure is retried, but denied or mismatched identity is not', async () => {
  const time = fakeTime(); let calls = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => worker(), read: () => stoppedTurn('stop'), clock: time.clock, pause: time.pause,
    verify: async () => { if (++calls === 1) throw Object.assign(new Error('query'), { processProofCode: 'query-timeout' }); },
  });
  assert.equal(result.turn.state, 'stopped'); assert.equal(calls, 3);
  for (const processProofCode of ['query-access-denied', 'process-identity-changed']) {
    let count = 0;
    await assert.rejects(waitExecution(makeTask(), {
      inspect: () => worker(), read: () => stoppedTurn('stop'), pause: time.pause,
      verify: async () => { count++; throw Object.assign(new Error('query'), { processProofCode }); },
    }), error => error.processProofCode === processProofCode);
    assert.equal(count, 1);
  }
});


test('Herdr idle with an active native turn never settles', async () => {
  const time = fakeTime(); let reads = 0; let admitted = 0;
  await assert.rejects(waitExecution(makeTask(20), {
    inspect: () => worker('idle'), read: () => { reads++; return activeTurn(); },
    clock: time.clock, pause: time.pause, pollMs: 10, admissionMs: 5,
    verify: noVerify, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'ETIMEDOUT' && /may continue/.test(error.message));
  assert.equal(reads, 3);
  assert.equal(admitted, 1);
  assert.equal(time.now(), 20);
});


test('only the same exact Stop on a stable idle worker settles', async () => {
  const time = fakeTime(); const states = ['idle', 'idle', 'idle'];
  const turns = [{ state: 'idle' }, stoppedTurn('stop-1'), stoppedTurn('stop-1')];
  let inspectCount = 0, readCount = 0, verifyCount = 0, admitted = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => worker(states[Math.min(inspectCount++, states.length - 1)]),
    read: () => turns[Math.min(readCount++, turns.length - 1)],
    clock: time.clock, pause: time.pause, pollMs: 5, verify: async () => { verifyCount++; },
    onAdmitted: async () => { admitted++; },
  });
  assert.equal(result.turn.state, 'stopped');
  assert.equal(result.turn.stopAt, 'stop-1');
  assert.equal(result.agent.agent_status, 'idle');
  assert.equal(readCount, 3);
  assert.equal(inspectCount, 3);
  assert.equal(verifyCount, 2);
  assert.equal(admitted, 1);
});


test('a changed Stop boundary cannot settle the prior turn', async () => {
  const time = fakeTime(); let reads = 0, admitted = 0;
  await assert.rejects(waitExecution(makeTask(10), {
    inspect: () => worker('idle'),
    read: () => stoppedTurn(`stop-${++reads}`),
    clock: time.clock, pause: time.pause, pollMs: 5, admissionMs: 5,
    verify: noVerify, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'ETIMEDOUT');
  assert.ok(reads >= 4);
  assert.equal(admitted, 1);
});


test('after a poll the live working state remains unsettled', async () => {
  const time = fakeTime();
  const agents = [worker('idle'), worker('working'), worker('working'), worker('working')];
  const turns = [{ state: 'idle' }, activeTurn(), activeTurn(), activeTurn()];
  let inspectCount = 0, readCount = 0;
  await assert.rejects(waitExecution(makeTask(15), {
    inspect: () => agents[Math.min(inspectCount++, agents.length - 1)],
    read: () => turns[Math.min(readCount++, turns.length - 1)],
    clock: time.clock, pause: time.pause, pollMs: 5, admissionMs: 5, verify: noVerify,
  }), error => error.code === 'ETIMEDOUT');
  assert.ok(time.pauses.length >= 2);
  assert.ok(inspectCount >= 3);
  assert.ok(readCount >= 3);
});


test('superseded native input is rejected before admission or settlement', async () => {
  let verifyCount = 0, admitted = 0, readCount = 0;
  await assert.rejects(waitExecution(makeTask(), {
    inspect: () => worker('idle'), read: () => { readCount++; return { state: 'superseded' }; },
    verify: async () => { verifyCount++; }, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'CBC_TURN_SUPERSEDED');
  assert.equal(readCount, 1);
  assert.equal(verifyCount, 0);
  assert.equal(admitted, 0);
});


test('a new input appearing during Stop revalidation is rejected', async () => {
  let reads = 0, admitted = 0;
  await assert.rejects(waitExecution(makeTask(), {
    inspect: () => worker('idle'),
    read: () => ++reads === 1 ? stoppedTurn('stop-1') : { state: 'superseded' },
    verify: noVerify, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'CBC_TURN_SUPERSEDED');
  assert.equal(reads, 2);
  assert.equal(admitted, 1);
});


test('temporary ECONNRESET recovers and exact Stop can still settle', async () => {
  const time = fakeTime(); let inspections = 0, reads = 0, verifies = 0, admitted = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => {
      if (++inspections === 1) throw Object.assign(new Error('temporary transport reset'), { code: 'ECONNRESET' });
      return worker('idle');
    },
    read: () => { reads++; return stoppedTurn('stop-after-reconnect'); },
    clock: time.clock, pause: time.pause, pollMs: 7, verify: async () => { verifies++; },
    onAdmitted: async () => { admitted++; },
  });
  assert.equal(result.turn.stopAt, 'stop-after-reconnect');
  assert.equal(inspections, 3);
  assert.equal(reads, 2);
  assert.deepEqual(time.pauses, [7]);
  assert.equal(verifies, 2);
  assert.equal(admitted, 1);
});


test('three consecutive read failures terminate observation', async () => {
  const time = fakeTime(); let inspections = 0;
  const transient = Object.assign(new Error('Herdr temporarily unavailable'), { code: 'ECONNRESET' });
  await assert.rejects(waitExecution(makeTask(), {
    inspect: () => { inspections++; throw transient; }, read: () => assert.fail('read must not run'),
    clock: time.clock, pause: time.pause, pollMs: 3, maxReadFailures: 3,
    verify: noVerify,
  }), error => error === transient);
  assert.equal(inspections, 3);
  assert.deepEqual(time.pauses, [3, 3]);
});


test('approval blocked is returned as blocked and is never mistaken for Stop', async () => {
  let verifies = 0, admitted = 0, reads = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => worker('blocked'), read: () => { reads++; return { state: 'blocked', submittedAt: '2026-11-04T00:00:00.000Z' }; },
    verify: async () => { verifies++; }, onAdmitted: async turn => { admitted++; assert.equal(turn.state, 'blocked'); },
  });
  assert.equal(result.agent.agent_status, 'blocked');
  assert.equal(result.turn.state, 'blocked');
  assert.equal(result.turn.stopAt, undefined);
  assert.equal(reads, 1);
  assert.equal(verifies, 1);
  assert.equal(admitted, 1);
});


test('observation window timeout reports that native execution may continue', async () => {
  const time = fakeTime(); let admitted = 0;
  await assert.rejects(waitExecution(makeTask(10), {
    inspect: () => worker('working'), read: activeTurn,
    clock: time.clock, pause: time.pause, pollMs: 5, admissionMs: 5, verify: noVerify,
    onAdmitted: async () => { admitted++; },
  }), error => error.code === 'ETIMEDOUT' && /native execution may continue/.test(error.message));
  assert.equal(time.now(), 10);
  assert.equal(admitted, 1);
});


test('admission timeout without an exact native receipt remains unconfirmed', async () => {
  const time = fakeTime(); let verifies = 0, admitted = 0, reads = 0;
  await assert.rejects(waitExecution(makeTask(1000), {
    inspect: () => worker('idle'), read: () => { reads++; return { state: 'idle' }; },
    clock: time.clock, pause: time.pause, pollMs: 5, admissionMs: 10,
    verify: async () => { verifies++; }, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'CBC_ADMISSION_UNCONFIRMED');
  assert.equal(time.now(), 10);
  assert.equal(reads, 3);
  assert.equal(verifies, 0);
  assert.equal(admitted, 0);
});


test('observer generation exit stops polling without settling', async () => {
  const time = fakeTime(); let active = true, inspections = 0, reads = 0, verifies = 0, admitted = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => { inspections++; return worker('working'); },
    read: () => { reads++; return activeTurn(); },
    clock: time.clock, pause: async ms => { await time.pause(ms); active = false; }, pollMs: 5,
    isActive: () => active, verify: async () => { verifies++; }, onAdmitted: async () => { admitted++; },
  });
  assert.equal(result, null);
  assert.equal(inspections, 1);
  assert.equal(reads, 1);
  assert.equal(verifies, 1);
  assert.equal(admitted, 1);
});


test('onAdmitted runs once across active polls and exact Stop settlement', async () => {
  const time = fakeTime();
  const agents = [worker('working'), worker('working'), worker('idle'), worker('idle')];
  const turns = [activeTurn(), activeTurn(), stoppedTurn('stop-once'), stoppedTurn('stop-once')];
  let inspections = 0, reads = 0, verifies = 0, admitted = 0;
  const result = await waitExecution(makeTask(), {
    inspect: () => agents[Math.min(inspections++, agents.length - 1)],
    read: () => turns[Math.min(reads++, turns.length - 1)],
    clock: time.clock, pause: time.pause, pollMs: 2,
    verify: async () => { verifies++; }, onAdmitted: async () => { admitted++; await Promise.resolve(); },
  });
  assert.equal(result.turn.stopAt, 'stop-once');
  assert.equal(admitted, 1);
  assert.equal(verifies, 2);
  assert.equal(reads, 4);
  assert.equal(inspections, 4);
});


test('process identity verification failure refuses admission and Stop settlement', async t => {
  await t.test('admission verification rejects before recording admission', async () => {
    let verifies = 0, admitted = 0;
    await assert.rejects(waitExecution(makeTask(), {
      inspect: () => worker('working'), read: activeTurn,
      verify: async () => { verifies++; throw Object.assign(new Error('process changed'), { code: 'WORKER_IDENTITY_MISMATCH' }); },
      onAdmitted: async () => { admitted++; },
    }), error => error.code === 'WORKER_IDENTITY_MISMATCH');
    assert.equal(verifies, 1);
    assert.equal(admitted, 0);
  });

  await t.test('terminal verification rejects an otherwise exact Stop', async () => {
    let verifies = 0;
    await assert.rejects(waitExecution(makeTask(), {
      inspect: () => worker('idle'), read: () => stoppedTurn('verified-stop'),
      verify: async () => {
        if (++verifies === 2) throw Object.assign(new Error('process changed before settlement'), { code: 'WORKER_IDENTITY_MISMATCH' });
      },
      onAdmitted: noVerify,
    }), error => error.code === 'WORKER_IDENTITY_MISMATCH');
    assert.equal(verifies, 2);
  });
});


test('invalid native evidence is rejected without admission or settlement', async () => {
  let reads = 0, verifies = 0, admitted = 0;
  await assert.rejects(waitExecution(makeTask(), {
    inspect: () => worker('idle'), read: () => { reads++; return { state: 'invalid', reason: 'conflicting boundary' }; },
    verify: async () => { verifies++; }, onAdmitted: async () => { admitted++; },
  }), error => error.code === 'CBC_EVIDENCE_INVALID');
  assert.equal(reads, 1);
  assert.equal(verifies, 0);
  assert.equal(admitted, 0);
});
