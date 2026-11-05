'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { saveTask, loadTask, taskDir, writeJsonAtomic } = require('../lib/util');
const { writeLease, leasePath } = require('../lib/worker-lease');
const { inspectLocal, recover, verifyNative, diagnose, diagnoseTerminal, terminalComparison } = require('../lib/zcode-reconciliation');
const { envelopeDigest } = require('../lib/zcode-readiness');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reconcile-'));
let sequence = 0;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture() {
  const stateDir = path.join(root, String(++sequence)); process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const timestamp = Date.now(), iso = delta => new Date(timestamp + delta).toISOString();
  const task = { id: 'fixture-reconcile', agent: 'zcode', stateDir, cwd: stateDir, herdrSession: 'stub',
    paneId: 'own-pane', terminalId: 'own-terminal', workerSessionId: 'own-native', round: 1,
    status: 'submission_unknown', history: [{ round: 1, status: 'submitted', timestamp: iso(-6000) }], observerGeneration: 0,
    submission: { status: 'uncertain', attemptId: 'fixture-attempt' } };
  const dir = taskDir(task.id); fs.mkdirSync(path.join(dir, 'deliveries'), { recursive: true });
  task.promptPath = path.join(dir, 'round-001-prompt.md'); task.deliveryPath = path.join(dir, 'deliveries', 'round-001.md');
  task.submission.file = path.join(dir, 'round-001-submission-fixture-attempt.json');
  fs.writeFileSync(task.promptPath, 'exact fixture requirements'); fs.writeFileSync(task.deliveryPath, 'FAIL: needs technical rework');
  fs.utimesSync(task.deliveryPath, new Date(timestamp - 1000), new Date(timestamp - 1000));
  const envelope = { type: 'sendText', sessionId: task.workerSessionId, commandId: 'own-command', issuedAt: timestamp - 5000,
    payload: { text: fs.readFileSync(task.promptPath, 'utf8') } };
  const ack = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0,
    result: { type: 'inputAccepted', inputId: envelope.commandId, delivery: 'startNow' } };
  const command = { envelope, ack, status: 'terminal', turnState: 'completedSuccess', timestamp: iso(-500) };
  const header = { kind: 'turnHeader', rowId: 1, sourceCommandId: envelope.commandId, state: 'completedSuccess', endedAt: timestamp - 2000 };
  const binding = { taskId: task.id, round: 1, sessionId: task.workerSessionId, commandId: envelope.commandId,
    paneId: task.paneId, terminalId: task.terminalId, observerGeneration: 0 };
  const observation = { ...binding, timestamp: iso(-1500), phase: 'completedSuccess', result: { seen: true, terminal: true,
    state: 'completedSuccess', evidence: 'snapshot', header, headerRowId: 1, seq: 10, logEpoch: 'fixture-epoch' } };
  const state = { ...binding, state: 'idle', turnState: 'completedSuccess', timestamp: iso(0), herdrSession: task.herdrSession,
    cwd: task.cwd, commandSha256: envelopeDigest(envelope), workerPid: 9001, workerProcessStartedAt: iso(-20000), source: 'zcode-v4', readinessProtocol: 1 };
  const files = { command: path.join(dir, 'round-001-zcode-command.json'), observation: path.join(dir, 'round-001-zcode-observation.json'),
    state: path.join(dir, 'zcode-state.json'), attempt: task.submission.file };
  const attempt = { protocol: 1, attemptId: task.submission.attemptId, taskId: task.id, round: 1, agent: 'zcode',
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId, workerSessionId: task.workerSessionId,
    promptSha256: sha(fs.readFileSync(task.promptPath)), status: 'uncertain', createdAt: iso(-6000) };
  for (const [key, value] of Object.entries({ command, observation, state, attempt })) writeJsonAtomic(files[key], value);
  saveTask(task); writeLease(task);
  const agent = { pane_id: task.paneId, terminal_id: task.terminalId, agent: 'zcode', agent_status: 'idle', state_change_seq: 30 };
  const snapshot = { ...structuredClone(require('./fixtures/zcode-snapshot.json')), sessionId: task.workerSessionId,
    seq: 20, logEpoch: 'fixture-epoch' };
  snapshot.rows.window = [header]; snapshot.control = { ...snapshot.control, phase: 'completedSuccess', activeWorks: [], canStop: false, stopState: 'idle' };
  snapshot.queue.items = []; snapshot.pendingInteractions = []; snapshot.inputRouting = { mode: 'startNow' };
  const calls = [];
  class Remote extends EventEmitter {
    async connect() { calls.push('connect'); }
    async attachProject(_cwd, options) { assert.equal(options.create, false); calls.push('attach'); }
    async query(e) { calls.push('query'); return { results: [{ key: { commandId: e.commandId, sessionId: e.sessionId }, result: ack }] }; }
    async close() { calls.push('close'); }
    async command() { throw new Error('No remote mutation permitted'); }
  }
  const nativeDeps = { createRemote: () => new Remote(), createConversation: () => ({ snapshot,
    async subscribe() { calls.push('subscribe'); }, async dispose() { calls.push('dispose'); } }) };
  const deps = { inspect: () => agent, inspectPane: () => ({ pane_id: task.paneId, terminal_id: task.terminalId }),
    alive: () => false, call: (_s, args) => { assert.equal(args[1], 'process-info'); return { result: { process_info: {} } }; },
    prove: async () => ({ pid: 9001, processStartedAt: state.workerProcessStartedAt }),
    verify: (t, p) => verifyNative(t, p, nativeDeps) };
  return { task, files, command, observation, state, attempt, agent, snapshot, ack, calls, deps, nativeDeps };
}

test('exact completed native command recovers to review_pending without rewriting uncertain transport or accepting FAIL', async () => {
  const f = fixture(), originalAttempt = fs.readFileSync(f.files.attempt), originalCommand = fs.readFileSync(f.files.command);
  const result = await recover(f.task, f.deps);
  assert.equal(result.status, 'review_pending'); assert.equal(result.submission.status, 'observed');
  assert.equal(result.submission.inputReceipt, undefined); assert.equal(result.submission.reconciledFrom, 'uncertain');
  assert.deepEqual(fs.readFileSync(f.files.attempt), originalAttempt); assert.deepEqual(fs.readFileSync(f.files.command), originalCommand);
  assert.equal(result.history[0].status, 'submitted'); assert.equal(result.history.at(-1).source, 'zcode-native-reconciliation');
  assert.deepEqual(f.calls, ['connect', 'attach', 'query', 'subscribe', 'dispose', 'close']);
  const calls = f.calls.length; await assert.rejects(recover(loadTask(f.task.id), f.deps), /not an uncertain/);
  assert.equal(f.calls.length, calls);
});

test('wrong round, native, command, terminal, attempt hash, lease and missing report never change the task', async () => {
  for (const variant of ['round', 'native', 'command', 'terminal', 'hash', 'lease', 'report', 'header', 'pid', 'generation']) {
    const f = fixture(), before = fs.readFileSync(path.join(taskDir(f.task.id), 'task.json'));
    if (variant === 'round') { f.observation.round++; writeJsonAtomic(f.files.observation, f.observation); }
    if (variant === 'native') { f.command.envelope.sessionId = 'foreign'; writeJsonAtomic(f.files.command, f.command); }
    if (variant === 'command') { f.command.ack.commandId = 'foreign'; writeJsonAtomic(f.files.command, f.command); }
    if (variant === 'terminal') { f.state.terminalId = 'foreign'; writeJsonAtomic(f.files.state, f.state); }
    if (variant === 'hash') fs.appendFileSync(f.task.promptPath, 'changed');
    if (variant === 'lease') writeJsonAtomic(leasePath(f.task.stateDir, f.task.herdrSession, f.task.paneId), { taskId: 'foreign' });
    if (variant === 'report') fs.unlinkSync(f.task.deliveryPath);
    if (variant === 'header') { f.observation.result.header.sourceCommandId = 'foreign'; writeJsonAtomic(f.files.observation, f.observation); }
    if (variant === 'pid') f.deps.prove = async () => ({ pid: 9002, processStartedAt: f.state.workerProcessStartedAt });
    if (variant === 'generation') { f.state.observerGeneration++; writeJsonAtomic(f.files.state, f.state); }
    await assert.rejects(recover(f.task, f.deps)); assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readFileSync(path.join(taskDir(f.task.id), 'task.json')), before);
  }
});

test('active work, approval, queue, unknown admission, stale epoch and network failure remain uncertain without reconnect', async () => {
  for (const variant of ['active', 'approval', 'queue', 'unknown', 'epoch', 'network', 'header']) {
    const f = fixture(), before = fs.readFileSync(path.join(taskDir(f.task.id), 'task.json'));
    if (variant === 'active') f.snapshot.control.activeWorks = [{ sourceCommandId: 'foreign' }];
    if (variant === 'approval') f.snapshot.pendingInteractions = [{}];
    if (variant === 'queue') f.snapshot.queue.items = [{}];
    if (variant === 'unknown') f.ack.status = 'unknown';
    if (variant === 'epoch') f.snapshot.logEpoch = 'new-epoch';
    if (variant === 'header') f.snapshot.rows.window = [{ ...f.snapshot.rows.window[0], endedAt: 1 }];
    if (variant === 'network') { const create = f.nativeDeps.createRemote; f.nativeDeps.createRemote = () => {
      const r = create(); r.query = async () => { f.calls.push('query'); throw new Error('fixture offline'); }; return r; }; }
    await assert.rejects(recover(f.task, f.deps));
    assert.equal(f.calls.filter(c => c === 'connect').length, 1); assert.equal(f.calls.at(-1), 'close');
    assert.deepEqual(fs.readFileSync(path.join(taskDir(f.task.id), 'task.json')), before);
  }
});

test('proof is reread after native verification; delivery or Pane changes prevent settlement', async () => {
  for (const variant of ['delivery', 'pane', 'seq']) {
    const f = fixture(), original = f.deps.verify;
    f.deps.verify = async (...args) => { const proof = await original(...args);
      if (variant === 'delivery') fs.appendFileSync(f.task.deliveryPath, 'changed after proof');
      if (variant === 'pane') f.agent.terminal_id = 'replacement';
      if (variant === 'seq') f.agent.state_change_seq++;
      return proof; };
    await assert.rejects(recover(f.task, f.deps)); assert.equal(loadTask(f.task.id).status, 'submission_unknown');
  }
});

test('official recover CLI uses the native reconciliation branch with isolated read-only adapters', () => {
  const f = fixture(), dir = path.dirname(f.task.promptPath), preload = path.join(dir, 'preload.cjs');
  const moduleRoot = path.resolve(__dirname, '../lib');
  // Fixture adapters expose no command or terminal-write implementation. / 测试适配器不提供任何命令或终端写入实现。
  fs.writeFileSync(preload, `const {EventEmitter}=require('node:events');const base=${JSON.stringify(moduleRoot)};
const herdr=require(base+'/herdr');herdr.agentInfo=()=>(${JSON.stringify(f.agent)});herdr.paneInfo=()=>(${JSON.stringify({ pane_id: f.task.paneId, terminal_id: f.task.terminalId })});
herdr.api=(_s,a)=>{if(a[1]!=='process-info')throw Error('terminal write forbidden');return {result:{process_info:{}}}};
require(base+'/windows-worker-process').proveWorkerProcess=async()=>(${JSON.stringify({ pid: 9001, processStartedAt: f.state.workerProcessStartedAt })});
const r=require(base+'/zcode-remote');r.readBinding=()=>({});r.ZCodeRemote=class extends EventEmitter{async connect(){} async attachProject(){} async close(){} async query(e){return {results:[{key:{commandId:e.commandId,sessionId:e.sessionId},result:${JSON.stringify(require('./fixtures/zcode-command-query-summary.json').results[0].result)}}]}}};
r.Conversation=class{constructor(){this.snapshot=${JSON.stringify(f.snapshot)}}async subscribe(){}async dispose(){}};
require(base+'/notify').notifyTask=async()=>({status:'fixture-only'});`);
  const cliOptions = { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.task.stateDir }, encoding: 'utf8', timeout: 15000, windowsHide: true };
  const validPreload = fs.readFileSync(preload, 'utf8');
  fs.writeFileSync(preload, validPreload.replace(JSON.stringify(f.snapshot), JSON.stringify({ ...f.snapshot, seq: 9 })));
  const refused = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id], cliOptions);
  assert.equal(refused.status, 0, refused.stderr);
  const failure = JSON.parse(refused.stdout)[0];
  assert.deepEqual(failure.failedChecks, ['seq']); assert.equal(fs.existsSync(failure.diagnosticFile), true);
  assert.equal(JSON.parse(fs.readFileSync(failure.diagnosticFile)).turn.seq, 9);
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
  fs.writeFileSync(preload, validPreload);
  const terminalArgs = ['--require', preload, path.resolve(__dirname, '../bin/agent-bridge.js'), 'diagnose-zcode-terminal', f.task.id];
  const terminalResult = spawnSync(process.execPath, terminalArgs, cliOptions);
  assert.equal(terminalResult.status, 0, terminalResult.stderr);
  assert.equal(JSON.parse(terminalResult.stdout).nativeChecksPassed, true);
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
  const terminalRepeated = spawnSync(process.execPath, terminalArgs, cliOptions);
  assert.equal(JSON.parse(terminalRepeated.stdout).connected, false);
  const diagnosticArgs = ['--require', preload, path.resolve(__dirname, '../bin/agent-bridge.js'), 'diagnose-zcode-admission', f.task.id];
  const diagnostic = spawnSync(process.execPath, diagnosticArgs, cliOptions);
  assert.equal(diagnostic.status, 0, diagnostic.stderr); assert.equal(JSON.parse(diagnostic.stdout).status, 'captured');
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
  const repeated = spawnSync(process.execPath, diagnosticArgs, cliOptions);
  assert.equal(repeated.status, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).reused, true);
  const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id],
    cliOptions);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /terminal reconciled to review_pending/);
  assert.equal(loadTask(f.task.id).status, 'review_pending');
});

test('diagnostic captures optional-result query shape once without claiming native admission or changing task', async () => {
  const f = fixture(); delete f.ack.result;
  const taskFile = path.join(taskDir(f.task.id), 'task.json'), before = fs.readFileSync(taskFile);
  const result = await diagnose(f.task, { ...f.deps, createRemote: f.nativeDeps.createRemote });
  assert.equal(result.status, 'captured'); assert.equal(result.localEvidenceStable, true);
  const record = JSON.parse(fs.readFileSync(result.file));
  assert.deepEqual(record.response.results[0].result, f.ack); assert.equal(record.response.results[0].result.result, undefined);
  assert.equal(record.responseSha256, sha(JSON.stringify(record.response)));
  assert.deepEqual(fs.readFileSync(taskFile), before);
  const calls = f.calls.length;
  assert.equal((await diagnose(f.task, { ...f.deps, createRemote: f.nativeDeps.createRemote })).reused, true);
  assert.equal(f.calls.length, calls);
  const verified = await verifyNative(f.task, inspectLocal(f.task), f.nativeDeps);
  assert.equal(verified.queryAckKind, 'summary'); assert.equal(Object.hasOwn(verified.ack, 'result'), false);
  assert.deepEqual(fs.readFileSync(taskFile), before);
});

test('query failure is recorded without raw errors and diagnostics never reconnect on repetition', async () => {
  const f = fixture(), create = f.nativeDeps.createRemote;
  const deps = { ...f.deps, createRemote: () => { const r = create(); r.query = async () => {
    f.calls.push('query'); throw new Error('PRIVATE_DIAGNOSTIC_SENTINEL'); }; return r; } };
  const result = await diagnose(f.task, deps);
  assert.equal(result.status, 'query_failed_or_unconfirmed');
  assert.equal(fs.readFileSync(result.file, 'utf8').includes('PRIVATE_DIAGNOSTIC_SENTINEL'), false);
  assert.equal((await diagnose(f.task, deps)).reused, true);
  assert.equal(f.calls.filter(c => c === 'query').length, 1); assert.equal(f.calls.filter(c => c === 'connect').length, 1);
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
});

test('diagnostic preserves unexpected raw shape and flags local changes without settling', async () => {
  const f = fixture(), create = f.nativeDeps.createRemote, response = { results: [{ key: { commandId: 'unexpected' }, result: 'unknown' }], extra: 1 };
  const result = await diagnose(f.task, { ...f.deps, createRemote: () => { const r = create(); r.query = async () => {
    f.agent.state_change_seq++; return response; }; return r; } });
  const record = JSON.parse(fs.readFileSync(result.file));
  assert.deepEqual(record.response, response); assert.equal(record.localEvidenceStable, false);
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
});

test('redacted real summary query fixture reconciles only with original detailed ACK and fresh terminal proof', async () => {
  const f = fixture(), response = structuredClone(require('./fixtures/zcode-command-query-summary.json'));
  const create = f.nativeDeps.createRemote;
  f.nativeDeps.createRemote = () => { const remote = create(); remote.query = async envelope => {
    assert.equal(envelope.sessionId, response.results[0].key.sessionId);
    assert.equal(envelope.commandId, response.results[0].key.commandId);
    f.calls.push('query'); return response;
  }; return remote; };
  const attemptBefore = fs.readFileSync(f.files.attempt), commandBefore = fs.readFileSync(f.files.command);
  const result = await recover(f.task, f.deps), proof = JSON.parse(fs.readFileSync(result.submission.reconciliationFile));
  assert.equal(result.status, 'review_pending'); assert.equal(proof.native.queryAckKind, 'summary');
  assert.deepEqual(proof.native.ack, response.results[0].result);
  assert.equal(Object.hasOwn(proof.native.ack, 'result'), false);
  assert.deepEqual(fs.readFileSync(f.files.command), commandBefore); assert.deepEqual(fs.readFileSync(f.files.attempt), attemptBefore);
});

test('summary compatibility never accepts conflicting query fields, key, original ACK or stale native terminal', async () => {
  for (const variant of ['null-result', 'foreign-input', 'different-delivery', 'revision', 'missing-revision',
    'command', 'session-key', 'status', 'original-ack', 'stale-terminal']) {
    const f = fixture(), response = structuredClone(require('./fixtures/zcode-command-query-summary.json'));
    const item = response.results[0];
    if (variant === 'null-result') item.result.result = null;
    if (variant === 'foreign-input') item.result.result = { type: 'inputAccepted', inputId: 'foreign', delivery: 'startNow' };
    if (variant === 'different-delivery') item.result.result = { ...f.ack.result, delivery: 'queue' };
    if (variant === 'revision') item.result.revisionAtDecision = 1;
    if (variant === 'missing-revision') delete item.result.revisionAtDecision;
    if (variant === 'command') item.result.commandId = 'foreign';
    if (variant === 'session-key') item.key.sessionId = 'foreign';
    if (variant === 'status') item.result.status = 'failed';
    if (variant === 'original-ack') { delete f.command.ack.result; writeJsonAtomic(f.files.command, f.command); }
    if (variant === 'stale-terminal') f.snapshot.seq = 9;
    const create = f.nativeDeps.createRemote;
    f.nativeDeps.createRemote = () => { const remote = create(); remote.query = async () => { f.calls.push('query'); return response; }; return remote; };
    const taskBefore = fs.readFileSync(path.join(taskDir(f.task.id), 'task.json'));
    await assert.rejects(recover(f.task, f.deps));
    assert.deepEqual(fs.readFileSync(path.join(taskDir(f.task.id), 'task.json')), taskBefore);
    assert.ok(f.calls.filter(c => c === 'query').length <= 1);
  }
});

test('live observer, approval projection, missing sequence and PID reuse block before opening Relay', async () => {
  for (const variant of ['observer', 'blocked', 'sequence', 'birth', 'other-owner']) {
    const f = fixture();
    if (variant === 'observer') { f.task.watcherPid = 9002; saveTask(f.task); f.deps.alive = () => true; }
    if (variant === 'blocked') f.agent.agent_status = 'blocked';
    if (variant === 'sequence') delete f.agent.state_change_seq;
    if (variant === 'birth') f.deps.prove = async () => ({ pid: 9001, processStartedAt: '2000-01-01T00:00:00Z' });
    if (variant === 'other-owner') saveTask({ ...f.task, id: 'another-owner', status: 'running' });
    await assert.rejects(recover(f.task, f.deps));
    assert.equal(f.calls.length, 0); assert.equal(loadTask(f.task.id).status, 'submission_unknown');
  }
});

test('terminal comparison reports every mismatching field and preserves exact values/types', () => {
  const f = fixture(), proof = inspectLocal(f.task), turn = structuredClone(f.observation.result);
  turn.header.rowId = '1'; turn.header.endedAt++; turn.logEpoch = 'other-epoch'; turn.seq = 1;
  const result = terminalComparison(proof, turn);
  assert.deepEqual(result.failedChecks, ['headerRowId', 'endedAt', 'logEpoch', 'seq']);
  assert.equal(result.checks.headerRowId.actualType, 'string'); assert.equal(result.checks.headerRowId.expected, 1);
  assert.equal(result.checks.endedAt.actual, turn.header.endedAt); assert.equal(result.checks.seq.expected.minimum, 10);
});

test('one-shot terminal diagnostic captures rejected proof and all mismatches without task writes or reconnect', async () => {
  const f = fixture(); f.snapshot.seq = 9; f.snapshot.rows.window = [{ ...f.snapshot.rows.window[0], endedAt: 1 }];
  const before = fs.readFileSync(path.join(taskDir(f.task.id), 'task.json'));
  const result = await diagnoseTerminal(f.task, f.deps);
  assert.equal(result.status, 'captured'); assert.equal(result.nativeChecksPassed, false); assert.equal(result.terminalCaptured, true);
  assert.equal(result.localEvidenceStable, true); assert.deepEqual(result.failedChecks, ['endedAt', 'seq']);
  const record = JSON.parse(fs.readFileSync(result.nativeDiagnosticFile));
  assert.deepEqual(record.turn.header, f.snapshot.rows.window[0]); assert.equal(record.turnSha256, sha(JSON.stringify(record.turn)));
  assert.equal(record.snapshotBefore.seq, 9); assert.equal(record.snapshotAtDetach.logEpoch, 'fixture-epoch');
  assert.equal(record.expectedTurn.logEpoch, 'fixture-epoch'); assert.equal(record.status, 'rejected-or-unconfirmed');
  assert.deepEqual(fs.readFileSync(path.join(taskDir(f.task.id), 'task.json')), before);
  const count = f.calls.length; assert.equal((await diagnoseTerminal(f.task, f.deps)).reused, true);
  assert.equal(f.calls.length, count);
});

function rebuiltFixture() {
  const f = fixture(), real = structuredClone(require('./fixtures/zcode-rebuilt-terminal.json'));
  f.command.envelope.issuedAt = real.commandIssuedAt;
  f.attempt.createdAt = new Date(real.commandIssuedAt - 1000).toISOString();
  f.observation.result = real.expectedTurn;
  f.observation.timestamp = new Date(real.expectedTurn.header.endedAt + 500).toISOString();
  f.state.commandSha256 = envelopeDigest(f.command.envelope);
  for (const [key, value] of Object.entries({ command: f.command, attempt: f.attempt, observation: f.observation, state: f.state })) writeJsonAtomic(f.files[key], value);
  f.snapshot.seq = real.snapshotBefore.seq; f.snapshot.logEpoch = real.snapshotBefore.logEpoch; f.snapshot.rows.window = [];
  const page = { rows: real.historyPage.headers, atSeq: real.historyPage.atSeq, atLogEpoch: real.historyPage.atLogEpoch, hasMore: false };
  const create = f.nativeDeps.createRemote;
  f.nativeDeps.createRemote = () => { const r = create(); r.call = async (_channel, method, params) => {
    assert.equal(method, 'conversationRowsRangeV4'); assert.equal(params.sessionId, f.task.workerSessionId);
    f.calls.push('history'); return structuredClone(page);
  }; return r; };
  return { ...f, page };
}

test('redacted real rebuilt projection recovers using stable identities and two fresh history reads, preserving old evidence', async () => {
  const f = rebuiltFixture(), before = Object.fromEntries(Object.entries(f.files).map(([k, p]) => [k, fs.readFileSync(p)]));
  const result = await recover(f.task, f.deps), proof = JSON.parse(fs.readFileSync(result.submission.reconciliationFile));
  assert.equal(result.status, 'review_pending'); assert.equal(proof.native.proofMode, 'rebuilt-history');
  const diagnostic = JSON.parse(fs.readFileSync(proof.native.diagnosticFile));
  assert.deepEqual(diagnostic.historicalComparison.failedChecks, ['endedAt', 'logEpoch', 'seq']);
  assert.deepEqual(diagnostic.failedChecks, []); assert.equal(f.calls.filter(c => c === 'history').length, 2);
  assert.equal(diagnostic.expectedTurn.header.endedAt - diagnostic.turn.header.endedAt, 29);
  for (const [key, file] of Object.entries(f.files)) assert.deepEqual(fs.readFileSync(file), before[key]);
  assert.equal(result.submission.inputReceipt, undefined); assert.equal(fs.readFileSync(f.task.deliveryPath, 'utf8').includes('FAIL'), true);
});

test('rebuilt proof rejects identity, chronology, current watermark, terminal, and concurrent history changes', async () => {
  for (const variant of ['turnId', 'entityId', 'productTurnId', 'origin', 'executionKind', 'row', 'source', 'missing-identity',
    'start-before-input', 'end-after-observation', 'time-order', 'not-integer', 'history-epoch', 'history-seq', 'failed', 'running', 'changed-history', 'changed-epoch']) {
    const f = rebuiltFixture(), h = f.page.rows[0], before = fs.readFileSync(path.join(taskDir(f.task.id), 'task.json'));
    if (['turnId', 'entityId', 'productTurnId', 'origin', 'executionKind'].includes(variant)) h[variant] = 'foreign';
    if (variant === 'row') h.rowId++;
    if (variant === 'source') h.sourceCommandId = 'foreign';
    if (variant === 'missing-identity') delete h.productTurnId;
    if (variant === 'start-before-input') h.startedAt = f.command.envelope.issuedAt - 1;
    if (variant === 'end-after-observation') h.endedAt = Date.parse(f.observation.timestamp) + 1;
    if (variant === 'time-order') h.startedAt = h.endedAt + 1;
    if (variant === 'not-integer') h.endedAt = String(h.endedAt);
    if (variant === 'history-epoch') f.page.atLogEpoch = 'foreign';
    if (variant === 'history-seq') f.page.atSeq = f.snapshot.seq - 1;
    if (variant === 'failed') h.state = 'failed';
    if (variant === 'running') f.snapshot.control.activeWorks = [{ sourceCommandId: 'own-command' }];
    if (['changed-history', 'changed-epoch'].includes(variant)) {
      const create = f.nativeDeps.createRemote; let calls = 0;
      f.nativeDeps.createRemote = () => { const r = create(), call = r.call; r.call = async (...args) => {
        const page = await call(...args);
        if (++calls === 2) { if (variant === 'changed-history') page.rows[0].endedAt++; else f.snapshot.logEpoch = 'third-epoch'; }
        return page;
      }; return r; };
    }
    await assert.rejects(recover(f.task, f.deps), undefined, variant);
    assert.deepEqual(fs.readFileSync(path.join(taskDir(f.task.id), 'task.json')), before, variant);
    assert.equal(f.calls.filter(c => c === 'connect').length, 1);
  }
});

test('new epoch cannot use only a matching tail header or skip the second history confirmation', async () => {
  const f = rebuiltFixture(); f.snapshot.rows.window = structuredClone(f.page.rows);
  const create = f.nativeDeps.createRemote;
  f.nativeDeps.createRemote = () => { const r = create(), call = r.call; let count = 0; r.call = async (...args) => {
    if (++count === 2) throw new Error('fixture disconnected'); return call(...args);
  }; return r; };
  await assert.rejects(recover(f.task, f.deps), /fixture disconnected/);
  assert.equal(loadTask(f.task.id).status, 'submission_unknown'); assert.equal(f.calls.at(-1), 'close');
});

test('official recover CLI handles the real rebuilt shape with read-only adapters and does not replay input', () => {
  const f = rebuiltFixture(), root = path.resolve(__dirname, '../lib'), preload = path.join(taskDir(f.task.id), 'rebuilt-preload.cjs');
  fs.writeFileSync(preload, `const {EventEmitter}=require('node:events');const root=${JSON.stringify(root)};
const h=require(root+'/herdr');h.agentInfo=()=>(${JSON.stringify(f.agent)});h.paneInfo=()=>(${JSON.stringify({pane_id:f.task.paneId,terminal_id:f.task.terminalId})});
h.api=(_s,a)=>{if(a[1]!=='process-info')throw Error('terminal write forbidden');return {result:{process_info:{}}}};
require(root+'/windows-worker-process').proveWorkerProcess=async()=>(${JSON.stringify({pid:9001,processStartedAt:f.state.workerProcessStartedAt})});
const z=require(root+'/zcode-remote');z.readBinding=()=>({});z.ZCodeRemote=class extends EventEmitter{async connect(){}async attachProject(){}async close(){}
async query(e){return {results:[{key:{commandId:e.commandId,sessionId:e.sessionId},result:${JSON.stringify(f.ack)}}]}}
async call(_channel,method){if(method!=='conversationRowsRangeV4')throw Error('write forbidden');return ${JSON.stringify(f.page)}}};
z.Conversation=class{constructor(){this.snapshot=${JSON.stringify(f.snapshot)}}async subscribe(){}async dispose(){}};
require(root+'/notify').notifyTask=async()=>({status:'fixture-only'});`);
  const before = fs.readFileSync(f.files.attempt);
  const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../bin/agent-bridge.js'), 'recover', f.task.id],
    { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: f.task.stateDir }, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /terminal reconciled to review_pending/);
  const task = loadTask(f.task.id); assert.equal(task.status, 'review_pending');
  assert.equal(JSON.parse(fs.readFileSync(task.submission.reconciliationFile)).native.proofMode, 'rebuilt-history');
  assert.deepEqual(fs.readFileSync(f.files.attempt), before);
});

test('terminal diagnostic captures history watermark mismatch before resolver rejection', async () => {
  const f = fixture(); f.snapshot.rows.window = []; const create = f.nativeDeps.createRemote;
  f.nativeDeps.createRemote = () => { const remote = create(); remote.call = async () => ({ rows: [], hasMore: false, atSeq: 20, atLogEpoch: 'foreign-history-epoch' }); return remote; };
  const result = await diagnoseTerminal(f.task, f.deps), record = JSON.parse(fs.readFileSync(result.nativeDiagnosticFile));
  assert.equal(result.nativeChecksPassed, false); assert.equal(record.stage, 'resolve-turn');
  assert.equal(record.historyPages[0].atLogEpoch, 'foreign-history-epoch'); assert.equal(record.snapshotBefore.logEpoch, 'fixture-epoch');
  assert.equal(loadTask(f.task.id).status, 'submission_unknown');
});

test('approval and queue diagnostic projections exclude user text and never proceed to terminal acceptance', async () => {
  const f = fixture(); f.snapshot.queue.items = [{ text: 'PRIVATE_QUEUED_TEXT_SENTINEL' }];
  f.snapshot.pendingInteractions = [{ question: 'PRIVATE_APPROVAL_TEXT_SENTINEL' }];
  const result = await diagnoseTerminal(f.task, f.deps), bytes = fs.readFileSync(result.nativeDiagnosticFile, 'utf8'), record = JSON.parse(bytes);
  assert.equal(result.nativeChecksPassed, false); assert.equal(record.stage, 'quiescent-before');
  assert.equal(record.snapshotBefore.queue.count, 1); assert.equal(record.snapshotBefore.pendingInteractionCount, 1);
  assert.equal(bytes.includes('PRIVATE_QUEUED_TEXT_SENTINEL'), false); assert.equal(bytes.includes('PRIVATE_APPROVAL_TEXT_SENTINEL'), false);
});
