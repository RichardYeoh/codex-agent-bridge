'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const priorStateDir = process.env.AGENT_BRIDGE_STATE_DIR;
const isolatedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-protocol-v2-'));
// Set an isolated root before loading protocol-v2; its lock helper reads this value. / 在加载协议模块前设置隔离状态根；锁实现会读取此值。
process.env.AGENT_BRIDGE_STATE_DIR = isolatedStateRoot;

const protocol = require('../lib/protocol-v2');
const cbcProtocol = require('../lib/cbc-protocol-v2');

const SPEC_SHA = protocol.sha('synthetic specification');
const PROMPT_SHA = protocol.sha('synthetic prompt');
const POINTER_SHA = protocol.sha('synthetic exact prompt pointer');
const ADMISSION_SHA = protocol.sha('synthetic admission proof');
const STOP_SHA = protocol.sha('synthetic stop proof');
const RESULT_SHA = protocol.sha('synthetic result manifest');
const OTHER_SHA = protocol.sha('different synthetic evidence');
const REQUEST_CREATED_AT = '2026-01-01T00:00:00.000Z';
const ADMITTED_AT = '2026-11-05T00:10:00.000Z';
const RESULT_AT = '2026-11-05T00:20:00.000Z';
const STOPPED_AT = '2026-11-05T00:30:00.000Z';

let nextFixture = 0;

function request(overrides = {}) {
  const number = ++nextFixture;
  return {
    schema: protocol.SCHEMA,
    taskId: `task-protocol-${number}`,
    round: 1,
    requestId: `request-protocol-${number}`,
    agent: 'fixture-agent',
    specSha256: SPEC_SHA,
    promptSha256: PROMPT_SHA,
    pointerSha256: POINTER_SHA,
    createdAt: REQUEST_CREATED_AT,
    cwd: path.join(isolatedStateRoot, 'fixture-workspace', String(number)),
    stateDir: path.join(isolatedStateRoot, 'requests', String(number)),
    binding: {
      agent: 'fixture-agent',
      sessionId: `fixture-session-${number}`,
      herdrSession: `fixture-herdr-session-${number}`,
      paneId: `fixture-pane-${number}`,
      terminalId: `fixture-terminal-${number}`,
      workerStartedAt: REQUEST_CREATED_AT,
    },
    allowedArtifacts: ['report.md'],
    ...overrides,
    binding: { ...{
      agent: 'fixture-agent',
      sessionId: `fixture-session-${number}`,
      herdrSession: `fixture-herdr-session-${number}`,
      paneId: `fixture-pane-${number}`,
      terminalId: `fixture-terminal-${number}`,
      workerStartedAt: REQUEST_CREATED_AT,
    }, ...(overrides.binding || {}) },
  };
}

function nativePayload(r, at, extra = {}) {
  return {
    sessionId: r.binding.sessionId,
    terminalId: r.binding.terminalId,
    paneId: r.binding.paneId,
    at,
    ...extra,
  };
}

function admission(r, at = ADMITTED_AT, evidenceSha256 = ADMISSION_SHA) {
  return protocol.event(r, 'native.admitted', nativePayload(r, at, {
    pointerSha256: r.pointerSha256,
    evidenceSha256,
  }));
}

function stop(r, at = STOPPED_AT, evidenceSha256 = STOP_SHA) {
  return protocol.event(r, 'native.stopped', nativePayload(r, at, { evidenceSha256 }));
}

function foreignInput(r, at) {
  return protocol.event(r, 'native.foreign_input', nativePayload(r, at, { inputKind: 'manual-prompt' }));
}

function result(r, outcome = 'delivered', manifestSha256 = RESULT_SHA, at = RESULT_AT) {
  return protocol.event(r, 'worker.result', {
    outcome,
    manifestSha256,
    at,
    reason: outcome === 'failed' ? 'Synthetic worker failure' : 'Synthetic fixture delivery',
  });
}

async function createRequest(r) {
  await protocol.create(r);
  return r;
}

async function appendAll(r, events) {
  let state;
  for (const item of events) state = await protocol.append(r, item);
  return state;
}

function assertProtocolError(operation, code = 'PROTOCOL_INVALID') {
  assert.throws(operation, error => error.code === code);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test.after(() => {
  fs.rmSync(isolatedStateRoot, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
  else process.env.AGENT_BRIDGE_STATE_DIR = priorStateDir;
});

test('normal request keeps transport, execution, observation, review, and resource projections separate', async () => {
  const r = await createRequest(request());
  assert.deepEqual(await protocol.inspect(r), {
    schema: protocol.SCHEMA,
    requestId: r.requestId,
    taskId: r.taskId,
    round: r.round,
    transport: 'prepared',
    execution: 'not_started',
    observation: 'healthy',
    review: 'not_ready',
    reviewIntegrity: 'consistent',
    resource: 'unknown',
    control: 'open',
    outcome: null,
    resultSha256: null,
    conflicts: [],
    waitingFor: ['native-admission'],
    eventCount: 0,
  });

  await appendAll(r, [
    protocol.event(r, 'transport.sending', { attempt: 1 }),
    protocol.event(r, 'transport.written', { bytes: 123 }),
    admission(r),
    result(r),
    stop(r),
    protocol.event(r, 'resource.busy', { owner: 'fixture', at: '2026-11-05T00:31:00.000Z' }),
    protocol.event(r, 'resource.released', {
      proofType: 'bound-worker-absent',
      evidenceSha256: OTHER_SHA,
      sessionId: r.binding.sessionId,
      at: '2026-11-05T00:32:00.000Z',
    }),
  ]);

  const state = await protocol.inspect(r);
  assert.equal(state.transport, 'admitted');
  assert.equal(state.execution, 'ended');
  assert.equal(state.observation, 'healthy');
  assert.equal(state.review, 'pending');
  assert.equal(state.resource, 'released');
  assert.equal(state.outcome, 'delivered');
  assert.match(state.resultSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.conflicts, []);
});

test('written input and unavailable observation do not imply execution failure or completion', async () => {
  const written = await createRequest(request());
  await protocol.append(written, protocol.event(written, 'transport.written', { bytes: 10 }));
  const writtenState = await protocol.inspect(written);
  assert.equal(writtenState.transport, 'written');
  assert.equal(writtenState.execution, 'unknown');
  assert.equal(writtenState.review, 'not_ready');
  assert.equal(writtenState.outcome, null);

  const offline = await createRequest(request());
  await appendAll(offline, [
    admission(offline),
    protocol.event(offline, 'observer.unavailable', { reason: 'synthetic-network-loss' }),
    protocol.event(offline, 'transport.unknown', { reason: 'synthetic-ack-timeout' }),
  ]);
  const offlineState = await protocol.inspect(offline);
  assert.equal(offlineState.transport, 'admitted');
  assert.equal(offlineState.execution, 'running');
  assert.equal(offlineState.observation, 'unavailable');
  assert.equal(offlineState.review, 'not_ready');
  assert.equal(offlineState.outcome, null);
  assert.deepEqual(offlineState.conflicts, []);
});

test('raw Hook digest stays separate from exact pointer and replay does not create foreign input', async () => {
  const r = request({ agent: 'cbc', binding: { agent: 'cbc' } });
  fs.mkdirSync(r.cwd, { recursive: true });
  await createRequest(r);
  const home = path.join(isolatedStateRoot, 'hook-fixture-home');
  const nativeDir = path.join(home, '.codebuddy', 'projects', 'fixture');
  fs.mkdirSync(nativeDir, { recursive: true });
  const pointerText = 'synthetic exact prompt pointer';
  assert.equal(protocol.sha(Buffer.from(pointerText)), r.pointerSha256);
  const transcript = path.join(nativeDir, `${r.binding.sessionId}.jsonl`);
  const row = {
    id: 'synthetic-native-input-1',
    type: 'message',
    role: 'user',
    timestamp: ADMITTED_AT,
    cwd: r.cwd,
    sessionId: r.binding.sessionId,
    content: [{ type: 'input_text', text: pointerText }],
  };
  fs.writeFileSync(transcript, `${JSON.stringify(row)}\n`, 'utf8');
  const task = {
    taskProtocol: 2,
    layeredRequestId: r.requestId,
    layeredRequestFile: path.join(protocol.requestDirectory(r), 'request.json'),
    stateDir: r.stateDir,
    id: r.taskId,
    agent: 'cbc',
    round: r.round,
    cwd: r.cwd,
    workerSessionId: r.binding.sessionId,
    terminalId: r.binding.terminalId,
    paneId: r.binding.paneId,
    herdrSession: r.binding.herdrSession,
    submission: { attemptId: r.requestId, status: 'sending' },
  };
  const rawPrompt = 'synthetic Hook wrapper differs from native pointer';
  const raw = {
    hook_event_name: 'UserPromptSubmit',
    session_id: r.binding.sessionId,
    transcript_path: transcript,
    prompt: rawPrompt,
  };
  const hookPromptSha256 = protocol.sha(Buffer.from(rawPrompt));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    await cbcProtocol.capture(task, raw, { promptSha256: hookPromptSha256 });
    const firstCount = protocol.load(r).events.length;
    await cbcProtocol.capture(task, raw, { promptSha256: hookPromptSha256 });
    assert.equal(protocol.load(r).events.length, firstCount, 'replaying the same Hook must be idempotent');
    assert.equal((await protocol.inspect(r)).execution, 'running');
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  }

  const events = protocol.load(r).events;
  const hook = events.find(item => item.kind === 'evidence.hook');
  const admitted = events.find(item => item.kind === 'native.admitted');
  assert.equal(hook.payload.promptSha256, hookPromptSha256);
  assert.notEqual(hook.payload.promptSha256, r.pointerSha256);
  assert.equal(admitted.payload.pointerSha256, r.pointerSha256);
  assert.equal(admitted.payload.nativeMessageId, row.id);
  assert.equal((await protocol.inspect(r)).execution, 'running');
});

test('a raw Hook boundary predating immutable request creation is rejected', async () => {
  const r = await createRequest(request());
  assertProtocolError(() => protocol.event(r, 'evidence.hook', {
    name: 'UserPromptSubmit',
    sessionId: r.binding.sessionId,
    paneId: r.binding.paneId,
    terminalId: r.binding.terminalId,
    at: '2025-12-31T23:59:59.000Z',
    promptSha256: POINTER_SHA,
  }));
});

test('a later Stop timestamp is not lost when its Hook event is persisted before UserPromptSubmit', async () => {
  const r = request({ agent: 'cbc', binding: { agent: 'cbc' } });
  fs.mkdirSync(r.cwd, { recursive: true });
  await createRequest(r);
  const home = path.join(isolatedStateRoot, 'out-of-order-hook-home');
  const nativeDir = path.join(home, '.codebuddy', 'projects', 'fixture');
  fs.mkdirSync(nativeDir, { recursive: true });
  const pointerText = 'synthetic exact prompt pointer';
  const transcript = path.join(nativeDir, `${r.binding.sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({
    id: 'ordered-native-input', type: 'message', role: 'user', timestamp: ADMITTED_AT,
    cwd: r.cwd, sessionId: r.binding.sessionId,
    content: [{ type: 'input_text', text: pointerText }],
  })}\n`, 'utf8');
  const stopAt = new Date(Date.now() + 60_000).toISOString();
  await protocol.append(r, protocol.event(r, 'evidence.hook', {
    name: 'Stop', sessionId: r.binding.sessionId, paneId: r.binding.paneId,
    terminalId: r.binding.terminalId, at: stopAt,
  }, 'stop-hook-arrived-first'));

  const task = {
    taskProtocol: 2,
    layeredRequestId: r.requestId,
    layeredRequestFile: path.join(protocol.requestDirectory(r), 'request.json'),
    stateDir: r.stateDir, id: r.taskId, agent: 'cbc', round: r.round,
    cwd: r.cwd, workerSessionId: r.binding.sessionId, terminalId: r.binding.terminalId,
    paneId: r.binding.paneId, herdrSession: r.binding.herdrSession,
    submission: { attemptId: r.requestId, status: 'sending' },
  };
  const rawPrompt = 'synthetic Hook wrapper differs from native pointer';
  const raw = { hook_event_name: 'UserPromptSubmit', session_id: r.binding.sessionId,
    transcript_path: transcript, prompt: rawPrompt };
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    await cbcProtocol.capture(task, raw, { promptSha256: protocol.sha(Buffer.from(rawPrompt)) });
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  }

  const state = await protocol.inspect(r);
  assert.equal(state.execution, 'ended', 'reconciliation must use Hook timestamps, not storage order');
  assert.ok(protocol.load(r).events.some(item => item.kind === 'native.stopped'));
});

test('a no-input rejection conflicts with a persisted transport-written fact', async () => {
  const r = await createRequest(request());
  await appendAll(r, [
    protocol.event(r, 'transport.sending', { attempt: 1 }),
    protocol.event(r, 'transport.written', { bytes: 41 }),
    protocol.event(r, 'transport.rejected', { inputWritten: false, reason: 'contradictory receipt' }),
  ]);
  const state = await protocol.inspect(r);
  assert.ok(state.conflicts.length > 0, 'written bytes and a no-input rejection cannot both be authoritative');
  assert.equal(state.observation, 'conflict');
});

test('manual input before Stop protects the request; input after Stop does not roll back delivery', async () => {
  const before = await createRequest(request());
  await appendAll(before, [
    admission(before),
    foreignInput(before, '2026-11-05T00:15:00.000Z'),
    result(before, 'delivered', RESULT_SHA, '2026-11-05T00:20:00.000Z'),
    stop(before, '2026-11-05T00:30:00.000Z'),
  ]);
  const protectedState = await protocol.inspect(before);
  assert.equal(protectedState.execution, 'unknown');
  assert.equal(protectedState.review, 'not_ready');
  assert.equal(protectedState.outcome, null);
  assert.ok(protectedState.conflicts.includes('foreign-input-during-request'));

  const after = await createRequest(request());
  await appendAll(after, [
    admission(after),
    result(after),
    stop(after),
    foreignInput(after, '2026-11-05T00:40:00.000Z'),
  ]);
  const deliveredState = await protocol.inspect(after);
  assert.equal(deliveredState.execution, 'ended');
  assert.equal(deliveredState.review, 'pending');
  assert.equal(deliveredState.outcome, 'delivered');
  assert.deepEqual(deliveredState.conflicts, []);
});

test('late pre-Stop foreign evidence contests acceptance integrity; post-Stop input preserves it', async () => {
  const preStop = await createRequest(request());
  await appendAll(preStop, [admission(preStop), result(preStop), stop(preStop)]);
  const preStopReady = await protocol.inspect(preStop);
  await protocol.append(preStop, protocol.event(preStop, 'review.accepted', {
    resultSha256: preStopReady.resultSha256,
  }));
  await protocol.append(preStop, foreignInput(preStop, '2026-11-05T00:25:00.000Z'));
  const invalidated = await protocol.inspect(preStop);
  assert.equal(invalidated.review, 'accepted', 'late conflict must preserve the historical acceptance decision');
  assert.equal(invalidated.reviewIntegrity, 'contested');
  assert.equal(invalidated.observation, 'conflict');
  assert.ok(invalidated.conflicts.includes('foreign-input-during-request'));
  assert.equal(protocol.load(preStop).events.some(item => item.kind === 'review.accepted'), true,
    'the prior acceptance event remains durable as historical evidence');
  await assert.rejects(protocol.append(preStop, protocol.event(preStop, 'review.accepted', {
    resultSha256: preStopReady.resultSha256,
  })), error => error.code === 'PROTOCOL_INVALID');

  const postStop = await createRequest(request());
  await appendAll(postStop, [admission(postStop), result(postStop), stop(postStop)]);
  const postStopReady = await protocol.inspect(postStop);
  await protocol.append(postStop, protocol.event(postStop, 'review.accepted', {
    resultSha256: postStopReady.resultSha256,
  }));
  await protocol.append(postStop, foreignInput(postStop, '2026-11-05T00:40:00.000Z'));
  const retained = await protocol.inspect(postStop);
  assert.equal(retained.review, 'accepted');
  assert.equal(retained.reviewIntegrity, 'consistent');
  assert.equal(retained.outcome, 'delivered');
  assert.deepEqual(retained.conflicts, []);
});

test('result, Stop, and admission arrival order converges without premature completion', async () => {
  const orders = [
    ['admission', 'result', 'stop'],
    ['stop', 'result', 'admission'],
    ['result', 'admission', 'stop'],
    ['result', 'stop', 'admission'],
    ['admission', 'stop', 'result'],
    ['stop', 'admission', 'result'],
  ];
  let reference;

  for (const order of orders) {
    const r = await createRequest(request());
    const facts = {
      admission: admission(r),
      result: result(r),
      stop: stop(r),
    };
    for (const [index, fact] of order.entries()) {
      const interim = await protocol.append(r, facts[fact]);
      if (index < order.length - 1) {
        assert.notEqual(interim.review, 'pending', 'review must wait for all three independent facts');
      }
    }
    const state = await protocol.inspect(r);
    const projection = {
      transport: state.transport,
      execution: state.execution,
      observation: state.observation,
      review: state.review,
      outcome: state.outcome,
      conflicts: state.conflicts,
    };
    assert.deepEqual(projection, {
      transport: 'admitted',
      execution: 'ended',
      observation: 'healthy',
      review: 'pending',
      outcome: 'delivered',
      conflicts: [],
    });
    if (reference) assert.deepEqual(projection, reference);
    else reference = projection;
  }
});

test('same event ID is idempotent but different content under that ID is rejected', async () => {
  const r = await createRequest(request());
  const first = protocol.event(r, 'transport.written', { bytes: 77 }, 'write-proof-1');
  await protocol.append(r, first);

  const retry = protocol.event(r, 'transport.written', { bytes: 77 }, 'write-proof-1');
  retry.createdAt = '2026-11-06T00:00:00.000Z';
  const repeated = await protocol.append(r, retry);
  assert.equal(repeated.eventCount, 1);

  const collision = protocol.event(r, 'transport.written', { bytes: 78 }, 'write-proof-1');
  await assert.rejects(protocol.append(r, collision), error => error.code === 'PROTOCOL_ID_CONFLICT');
  assert.equal((await protocol.inspect(r)).eventCount, 1);
});

test('request, task, round, native identity, and source mismatches are rejected', async () => {
  const r = request();
  await createRequest(r);
  const validAdmission = admission(r);

  for (const [field, value] of [
    ['requestId', 'another-request'],
    ['taskId', 'task-someone-else'],
    ['round', r.round + 1],
  ]) {
    const mismatch = { ...validAdmission, [field]: value };
    assertProtocolError(() => protocol.validateEvent(r, mismatch));
  }

  const wrongNativeIdentity = {
    ...validAdmission,
    payload: { ...validAdmission.payload, sessionId: 'unbound-synthetic-session' },
  };
  assertProtocolError(() => protocol.validateEvent(r, wrongNativeIdentity));

  const falseSource = { ...validAdmission, source: 'worker' };
  assertProtocolError(() => protocol.validateEvent(r, falseSource));

  const resultEvent = result(r);
  const controllerPretendingToBeWorker = { ...resultEvent, source: 'controller' };
  assertProtocolError(() => protocol.validateEvent(r, controllerPretendingToBeWorker));

  const changedRequest = { ...r, specSha256: OTHER_SHA };
  await assert.rejects(protocol.create(changedRequest), error => error.code === 'PROTOCOL_INVALID');
});

test('conflicting Stop or result claims become explicit conflicts; a failed result stays an execution outcome', async () => {
  const conflictingStops = await createRequest(request());
  await appendAll(conflictingStops, [
    admission(conflictingStops),
    result(conflictingStops),
    stop(conflictingStops, STOPPED_AT, STOP_SHA),
    stop(conflictingStops, '2026-11-05T00:31:00.000Z', OTHER_SHA),
  ]);
  const stopState = await protocol.inspect(conflictingStops);
  assert.ok(stopState.conflicts.includes('native.stopped'));
  assert.equal(stopState.review, 'not_ready');
  assert.equal(stopState.observation, 'conflict');

  const conflictingResults = await createRequest(request());
  await appendAll(conflictingResults, [
    admission(conflictingResults),
    stop(conflictingResults),
    result(conflictingResults, 'delivered', RESULT_SHA, '2026-11-05T00:20:00.000Z'),
    result(conflictingResults, 'failed', OTHER_SHA, '2026-11-05T00:21:00.000Z'),
  ]);
  const resultState = await protocol.inspect(conflictingResults);
  assert.ok(resultState.conflicts.includes('worker.result'));
  assert.equal(resultState.review, 'not_ready');

  const failed = await createRequest(request());
  await appendAll(failed, [
    admission(failed),
    result(failed, 'failed', RESULT_SHA, '2026-11-05T00:20:00.000Z'),
    stop(failed),
  ]);
  const failedState = await protocol.inspect(failed);
  assert.equal(failedState.transport, 'admitted');
  assert.equal(failedState.execution, 'ended');
  assert.equal(failedState.outcome, 'failed');
  assert.equal(failedState.review, 'pending');
  assert.deepEqual(failedState.conflicts, []);
});

test('review acceptance must bind the reducer-computed result digest', async () => {
  const r = await createRequest(request());
  await appendAll(r, [admission(r), result(r), stop(r)]);
  const ready = await protocol.inspect(r);

  const wrong = protocol.event(r, 'review.accepted', { resultSha256: OTHER_SHA });
  await assert.rejects(protocol.append(r, wrong), error => error.code === 'PROTOCOL_INVALID');
  assert.equal((await protocol.inspect(r)).review, 'pending');

  const accepted = protocol.event(r, 'review.accepted', { resultSha256: ready.resultSha256 });
  const acceptedState = await protocol.append(r, accepted);
  assert.equal(acceptedState.review, 'accepted');
  assert.equal(acceptedState.resultSha256, ready.resultSha256);
});

test('event journal survives a fresh Node process and detects persisted corruption', async () => {
  const r = await createRequest(request());
  await appendAll(r, [admission(r), result(r), stop(r)]);

  const childCode = 'const p = require(process.argv[1]); const r = JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify(p.inspect(r)));';
  const child = spawnSync(process.execPath, ['-e', childCode, require.resolve('../lib/protocol-v2'), JSON.stringify(r)], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).review, 'pending');

  const eventsFile = path.join(protocol.requestDirectory(r), 'events.json');
  const saved = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  saved.eventsSha256 = '0'.repeat(64);
  fs.writeFileSync(eventsFile, JSON.stringify(saved, null, 2), 'utf8');
  assertProtocolError(() => protocol.inspect(r));
});

test('event count and per-event size limits reject additions while preserving recorded evidence', async () => {
  const r = await createRequest(request());
  const eventsFile = path.join(protocol.requestDirectory(r), 'events.json');
  // Seed a valid boundary journal directly to avoid quadratic writes while exercising the append limit. / 直接构造合法边界日志，避免逐条写入造成平方级开销，同时验证追加容量限制。
  const events = Array.from({ length: 4096 }, (_, index) => ({
    schema: protocol.SCHEMA,
    eventId: `capacity-${index}`,
    source: 'observer',
    taskId: r.taskId,
    round: r.round,
    requestId: r.requestId,
    replyTo: r.requestId,
    kind: 'observer.healthy',
    payload: {},
    createdAt: '2026-11-05T00:00:00.000Z',
  }));
  fs.writeFileSync(eventsFile, JSON.stringify({
    schema: protocol.SCHEMA,
    requestSha256: protocol.digest(r),
    events,
    eventsSha256: protocol.digest(events),
  }, null, 2), 'utf8');

  assertProtocolError(() => protocol.event(r, 'observer.unavailable', { detail: 'x'.repeat(70_000) }));

  const before = fs.readFileSync(eventsFile, 'utf8');
  const overLimit = protocol.event(r, 'observer.healthy', {}, 'capacity-final');
  await assert.rejects(protocol.append(r, overLimit), error => error.code === 'PROTOCOL_INVALID');
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), before);
});

test('different request IDs keep their event journals and projections isolated', async () => {
  const first = request();
  const second = request({
    taskId: first.taskId,
    round: first.round,
    stateDir: first.stateDir,
  });
  await createRequest(first);
  await createRequest(second);
  await protocol.append(first, protocol.event(first, 'transport.written', { bytes: 19 }));

  assert.notEqual(protocol.requestDirectory(first), protocol.requestDirectory(second));
  assert.equal((await protocol.inspect(first)).transport, 'written');
  assert.equal((await protocol.inspect(second)).transport, 'prepared');
  assert.equal((await protocol.inspect(second)).eventCount, 0);
});

test('worker bridge-result CLI rejects caller attempts to choose event kind, source, or review action', async () => {
  const r = request({ reportPath: path.join(isolatedStateRoot, 'fixture-workspace', 'synthetic-report.md') });
  fs.mkdirSync(r.cwd, { recursive: true });
  r.reportPath = path.join(r.cwd, 'report.md');
  fs.writeFileSync(r.reportPath, 'Synthetic CLI report\n', 'utf8');
  await createRequest(r);
  await protocol.append(r, admission(r));
  const requestFile = path.join(protocol.requestDirectory(r), 'request.json');
  const cli = path.resolve(__dirname, '../bin/bridge-result.js');

  for (const [flag, value] of [['--source', 'controller'], ['--kind', 'review.accepted'], ['--accept', 'true']]) {
    const refused = spawnSync(process.execPath, [cli, '--request-file', requestFile,
      '--outcome', 'delivered', flag, value], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
    });
    assert.notEqual(refused.status, 0, `${flag} must be rejected`);
    assert.equal(protocol.load(r).events.some(item => item.kind === 'worker.result'), false);
    assert.equal(protocol.load(r).events.some(item => item.kind === 'review.accepted'), false);
  }

  const acceptedCommand = spawnSync(process.execPath, [cli, '--request-file', requestFile, '--outcome', 'delivered'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
  });
  assert.equal(acceptedCommand.status, 0, acceptedCommand.stderr);
  assert.equal(JSON.parse(acceptedCommand.stdout).resultRecorded, true);
  const events = protocol.load(r).events;
  assert.equal(events.find(item => item.kind === 'worker.result').source, 'worker');
  assert.equal(events.some(item => item.kind === 'review.accepted'), false);
});

test('loading a journal rejects repeated source and event IDs even when its digest is recomputed', async () => {
  const r = await createRequest(request());
  const item = protocol.event(r, 'observer.healthy', {}, 'duplicate-loaded-id');
  const events = [item, { ...item, createdAt: '2026-11-06T00:00:00.000Z' }];
  const file = path.join(protocol.requestDirectory(r), 'events.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: protocol.SCHEMA,
    requestSha256: protocol.digest(r),
    events,
    eventsSha256: protocol.digest(events),
  }, null, 2), 'utf8');

  assertProtocolError(() => protocol.load(r));
});

test('a crash before journal rename preserves the old state and a crash after rename is idempotently recoverable', async () => {
  const crashChild = position => [
    '-e',
    `const fs = require('node:fs');
     const rename = fs.renameSync;
     fs.renameSync = (from, to) => {
       if (String(to).endsWith('events.json')) {
         if (${JSON.stringify(position)} === 'before') process.exit(71);
         rename(from, to);
         process.exit(72);
       }
       return rename(from, to);
     };
     const p = require(process.argv[1]);
     const r = JSON.parse(process.argv[2]);
     const e = JSON.parse(process.argv[3]);
     p.append(r, e);`,
    require.resolve('../lib/protocol-v2'),
  ];

  const before = await createRequest(request());
  const beforeEvent = protocol.event(before, 'transport.written', { bytes: 31 }, 'before-rename-crash');
  const beforeCrash = spawnSync(process.execPath, [...crashChild('before'), JSON.stringify(before), JSON.stringify(beforeEvent)], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
  });
  assert.equal(beforeCrash.status, 71, beforeCrash.stderr);
  assert.equal((await protocol.inspect(before)).eventCount, 0);
  assert.equal((await protocol.append(before, beforeEvent)).eventCount, 1);

  const after = await createRequest(request());
  const afterEvent = protocol.event(after, 'transport.written', { bytes: 32 }, 'after-rename-crash');
  const afterCrash = spawnSync(process.execPath, [...crashChild('after'), JSON.stringify(after), JSON.stringify(afterEvent)], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: isolatedStateRoot },
  });
  assert.equal(afterCrash.status, 72, afterCrash.stderr);
  assert.equal((await protocol.inspect(after)).eventCount, 1);
  assert.equal((await protocol.append(after, afterEvent)).eventCount, 1);
});

test('create repairs a pre-initialization crash but refuses to recreate an initialized missing journal', async () => {
  const r = await createRequest(request());
  const journal = path.join(protocol.requestDirectory(r), 'events.json');
  const initialized = path.join(protocol.requestDirectory(r), 'initialized.json');
  fs.unlinkSync(journal);
  fs.unlinkSync(initialized);

  const repaired = await protocol.create(r);
  assert.equal(repaired.requestId, r.requestId);
  assert.equal(repaired.eventCount, 0);
  assert.equal((await protocol.inspect(r)).transport, 'prepared');

  await protocol.append(r, protocol.event(r, 'transport.written', { bytes: 12 }, 'journal-existed'));
  fs.unlinkSync(journal);
  await assert.rejects(protocol.create(r), error => error.code === 'PROTOCOL_INVALID');
});

test('a delayed pre-admission blocked event cannot regress the current running execution', async () => {
  const r = await createRequest(request());
  await protocol.append(r, admission(r, ADMITTED_AT));
  assert.equal((await protocol.inspect(r)).execution, 'running');

  await protocol.append(r, protocol.event(r, 'native.blocked', nativePayload(r,
    '2026-11-05T00:05:00.000Z', { reason: 'synthetic-old-block-snapshot' })));
  assert.notEqual((await protocol.inspect(r)).execution, 'blocked');
});

test('native progress after a bound approval blocker restores running projection', async () => {
  const r = await createRequest(request());
  await appendAll(r, [
    admission(r, ADMITTED_AT),
    protocol.event(r, 'native.blocked', nativePayload(r, '2026-11-05T00:15:00.000Z', { reason: 'approval-required' })),
  ]);
  assert.equal((await protocol.inspect(r)).execution, 'blocked');

  await protocol.append(r, protocol.event(r, 'native.progress', nativePayload(r, '2026-11-05T00:20:00.000Z', {
    reason: 'approval-observed-and-execution-resumed',
  })));
  assert.equal((await protocol.inspect(r)).execution, 'running');
});

test('a late observation cannot replace a newer observation, while offline observation preserves acceptance', async () => {
  const stale = await createRequest(request());
  const newerUnavailable = protocol.event(stale, 'observer.unavailable', { reason: 'newer' });
  newerUnavailable.createdAt = new Date(Date.now() + 1000).toISOString();
  const delayedHealthy = protocol.event(stale, 'observer.healthy', { reason: 'stale' });
  delayedHealthy.createdAt = new Date(Date.now() - 1000).toISOString();
  await protocol.append(stale, newerUnavailable);
  await protocol.append(stale, delayedHealthy);
  assert.notEqual((await protocol.inspect(stale)).observation, 'healthy');

  const accepted = await createRequest(request());
  await appendAll(accepted, [admission(accepted), result(accepted), stop(accepted)]);
  const ready = await protocol.inspect(accepted);
  await protocol.append(accepted, protocol.event(accepted, 'review.accepted', { resultSha256: ready.resultSha256 }));
  const observation = protocol.event(accepted, 'observer.unavailable', { reason: 'late-offline-snapshot' });
  observation.createdAt = new Date(Date.now() + 1000).toISOString();
  const state = await protocol.append(accepted, observation);
  assert.equal(state.observation, 'unavailable');
  assert.equal(state.review, 'accepted');
  assert.equal(state.outcome, 'delivered');
});

test('resource release requires a concrete release proof', async () => {
  const r = await createRequest(request());
  await protocol.append(r, protocol.event(r, 'resource.busy', { owner: 'fixture-agent' }));

  assertProtocolError(() => protocol.event(r, 'resource.released', {}));
});

test('later native activity contests a prior bound-worker-absent resource release', async () => {
  const r = await createRequest(request());
  await appendAll(r, [
    admission(r),
    protocol.event(r, 'resource.released', {
      proofType: 'bound-worker-absent',
      evidenceSha256: OTHER_SHA,
      sessionId: r.binding.sessionId,
      at: '2026-11-05T00:20:00.000Z',
    }),
  ]);
  assert.equal((await protocol.inspect(r)).resource, 'released');

  await protocol.append(r, protocol.event(r, 'native.progress', nativePayload(r, '2026-11-05T00:25:00.000Z', {
    reason: 'activity-after-absence-proof',
  })));
  const state = await protocol.inspect(r);
  assert.ok(state.conflicts.length > 0 || state.resource !== 'released',
    'activity after the release proof must reopen or quarantine this resource fence');
});

test('cancel request remains open until a proof-bound coordination close is recorded', async () => {
  const notSent = await createRequest(request());
  await protocol.append(notSent, protocol.event(notSent, 'control.cancel_requested', {
    actor: 'synthetic-controller',
    reason: 'fixture cancellation request',
  }));
  const pending = await protocol.inspect(notSent);
  assert.equal(pending.control, 'cancel_requested');
  assert.equal(pending.execution, 'not_started');
  assert.equal(pending.review, 'not_ready');

  const closed = await protocol.append(notSent, protocol.event(notSent, 'control.closed', {
    actor: 'synthetic-controller',
    reason: 'verified no transport was sent',
    proofType: 'not-sent',
    evidenceSha256: protocol.digest({ prepared: notSent.requestId }),
  }));
  assert.equal(closed.control, 'closed');
  assert.equal(closed.review, 'not_ready');

  const submitted = await createRequest(request());
  await appendAll(submitted, [
    admission(submitted),
    protocol.event(submitted, 'control.cancel_requested', {
      actor: 'synthetic-controller',
      reason: 'fixture cancellation request',
    }),
  ]);
  const falseClosure = protocol.event(submitted, 'control.closed', {
    actor: 'synthetic-controller',
    reason: 'invalid not-sent assertion',
    proofType: 'not-sent',
    evidenceSha256: protocol.digest({ prepared: submitted.requestId }),
  });
  await assert.rejects(protocol.append(submitted, falseClosure), error => error.code === 'PROTOCOL_INVALID');
  const stillPending = await protocol.inspect(submitted);
  assert.equal(stillPending.control, 'cancel_requested');
  assert.equal(stillPending.execution, 'running');
});

test('abandonment requires retained evidence and never rewrites execution facts or revives control', async () => {
  const invalid = request();
  const abandonedPayload = {
    actor: 'synthetic-controller',
    reason: 'synthetic operator abandonment decision',
    evidenceSha256: OTHER_SHA,
  };
  for (const missing of ['actor', 'reason', 'evidenceSha256']) {
    const payload = { ...abandonedPayload };
    delete payload[missing];
    assertProtocolError(() => protocol.event(invalid, 'control.abandoned', payload));
  }

  const written = await createRequest(request());
  await appendAll(written, [
    protocol.event(written, 'transport.written', { bytes: 1 }),
    protocol.event(written, 'control.abandoned', abandonedPayload),
  ]);
  let state = await protocol.inspect(written);
  assert.equal(state.execution, 'unknown', 'abandonment must retain uncertainty after transport write');
  assert.equal(state.control, 'abandoned');

  await protocol.append(written, protocol.event(written, 'control.cancel_requested', {
    actor: 'synthetic-controller',
    reason: 'later coordination update',
  }));
  await protocol.append(written, protocol.event(written, 'observer.healthy', { detail: 'later observation' }));
  state = await protocol.inspect(written);
  assert.equal(state.execution, 'unknown');
  assert.equal(state.control, 'abandoned', 'later control or observer events must not revive abandoned coordination');

  const admitted = await createRequest(request());
  await appendAll(admitted, [
    admission(admitted),
    protocol.event(admitted, 'control.abandoned', abandonedPayload),
  ]);
  state = await protocol.inspect(admitted);
  assert.equal(state.execution, 'running', 'abandonment must preserve the admitted-but-not-stopped fact');
  assert.equal(state.control, 'abandoned');
});

test('concurrent processes preserve both distinct event appends under the request lock', async () => {
  const r = await createRequest(request());
  const childCode = `const fs = require('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('events.json')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      return rename(from, to);
    };
    const p = require(process.argv[1]);
    const r = JSON.parse(process.argv[2]);
    const e = JSON.parse(process.argv[3]);
    p.append(r, e).catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });`;
  const common = [
    '-e', childCode,
    require.resolve('../lib/protocol-v2'),
    JSON.stringify(r),
  ];
  const first = protocol.event(r, 'transport.sending', { sequence: 1 }, 'concurrent-send');
  const second = protocol.event(r, 'transport.written', { sequence: 2 }, 'concurrent-write');
  const [firstProcess, secondProcess] = await Promise.all([
    runNode([...common, JSON.stringify(first)]),
    runNode([...common, JSON.stringify(second)]),
  ]);

  assert.equal(firstProcess.code, 0, firstProcess.stderr);
  assert.equal(secondProcess.code, 0, secondProcess.stderr);
  const data = protocol.load(r);
  assert.equal(data.events.length, 2);
  assert.deepEqual(new Set(data.events.map(item => item.kind)), new Set(['transport.sending', 'transport.written']));
});

test('append enforces the total journal byte cap before writing a snapshot', async () => {
  const r = await createRequest(request());
  const maxBytes = 8 * 1024 * 1024;
  const targetBytes = maxBytes - 16 * 1024;
  const eventCount = 128;
  let low = 64_000;
  let high = 65_200;
  let boundary;

  while (low <= high) {
    const detailLength = Math.floor((low + high) / 2);
    const events = Array.from({ length: eventCount }, (_, index) => ({
      schema: protocol.SCHEMA,
      eventId: `byte-cap-${index}`,
      source: 'observer',
      taskId: r.taskId,
      round: r.round,
      requestId: r.requestId,
      replyTo: r.requestId,
      kind: 'observer.healthy',
      payload: { detail: 'x'.repeat(detailLength) },
      createdAt: '2026-11-05T00:00:00.000Z',
    }));
    const draft = {
      schema: protocol.SCHEMA,
      requestSha256: protocol.digest(r),
      events,
      eventsSha256: '0'.repeat(64),
    };
    const size = Buffer.byteLength(JSON.stringify(draft, null, 2));
    const eventSize = Math.max(...events.map(item => Buffer.byteLength(JSON.stringify(item))));
    if (size <= targetBytes && eventSize <= 65_536) {
      boundary = { draft, size };
      low = detailLength + 1;
    } else high = detailLength - 1;
  }

  assert.ok(boundary, 'fixture should fit below the per-file and per-event limits');
  assert.ok(boundary.size > maxBytes - 65_536, 'fixture should leave less room than one valid event');
  boundary.draft.eventsSha256 = protocol.digest(boundary.draft.events);
  const file = path.join(protocol.requestDirectory(r), 'events.json');
  fs.writeFileSync(file, JSON.stringify(boundary.draft, null, 2), 'utf8');
  const before = fs.statSync(file).size;
  assert.ok(before <= maxBytes);

  const extra = protocol.event(r, 'observer.healthy', { detail: 'z'.repeat(63_000) }, 'over-byte-cap');
  await assert.rejects(protocol.append(r, extra), error => error.code === 'PROTOCOL_INVALID');
  assert.equal(fs.statSync(file).size, before);
});
