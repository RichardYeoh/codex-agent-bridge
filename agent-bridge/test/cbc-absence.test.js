'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertWorkerAbsent, cbcProcessProof } = require('../lib/worker-identity');
const proof = { kind: 'cbc', pid: 12123, processStartedAt: '2026-11-04T01:00:00Z' };
const task = { agent: 'cbc', id: 'cbc-absence-fixture', cbcTurnProtocol: 1,
  herdrSession: 'fixture', paneId: 'old-pane', terminalId: 'old-terminal', workerSessionId: 'native-fixture',
  submission: { inputReceipt: { processProof: proof } } };
const inventory = (_s, args) => ({ result: args[0] === 'pane' ? { panes: [] } : { agents: [] } });

test('missing Pane and optional native ref cannot conceal a live original CBC process', () => {
  assert.throws(() => assertWorkerAbsent(task, { call: inventory, alive: () => true }),
    error => error.code === 'WORKER_SESSION_IN_USE');
  assert.equal(assertWorkerAbsent(task, { call: inventory, alive: () => false }).originalPaneAbsent, true);
});

test('new-protocol missing process evidence never proves original worker absence', () => {
  assert.throws(() => assertWorkerAbsent({ ...task, submission: null }, { call: inventory, alive: () => false }),
    /process absence cannot be verified/);
});

test('current process proof wins over the previously closed source worker', () => {
  const current = { ...task, cbcPriorProcessProof: { ...proof, pid: 12124 } };
  assert.equal(cbcProcessProof(current).pid, proof.pid);
  assert.throws(() => assertWorkerAbsent(current, { call: inventory, alive: pid => pid === proof.pid }),
    error => error.code === 'WORKER_SESSION_IN_USE');
});

test('cold context can carry the closed source proof until a new submission exists', () => {
  const cold = { ...task, submission: null, cbcPriorProcessProof: proof };
  assert.equal(cbcProcessProof(cold), proof);
  assert.equal(assertWorkerAbsent(cold, { call: inventory, alive: () => false }).originalTerminalAbsent, true);
});
