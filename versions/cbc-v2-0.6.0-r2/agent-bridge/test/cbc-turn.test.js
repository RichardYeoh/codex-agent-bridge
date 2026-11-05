'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { writeLease } = require('../lib/worker-lease');
const { renderSubmissionPointer } = require('../lib/worker-policy');
const { captureSubmission, readTurn } = require('../lib/cbc-turn');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-turn-proof-'));
let serial = 0;
test.after(() => {
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
});

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture({ phase = 'uncertain' } = {}) {
  const stateDir = path.join(root, `state-${++serial}`);
  const id = `cbc-turn-${serial}`;
  const taskRoot = path.join(stateDir, 'tasks', id);
  fs.mkdirSync(taskRoot, { recursive: true });
  const base = Date.now() - 10_000;
  const iso = offset => new Date(base + offset).toISOString();
  const promptPath = path.join(taskRoot, 'round-003-prompt.md');
  const promptBytes = Buffer.from('Task brief secret body must never enter hook journal.');
  const submissionFile = path.join(taskRoot, 'round-003-submission-attempt-fixture.json');
  const task = {
    id, stateDir, agent: 'cbc', cbcTurnProtocol: 1, round: 3, status: 'submission_unknown',
    cwd: path.join(root, `project-${serial}`), herdrSession: `service-${serial}`, paneId: `w1:p${serial}`,
    terminalId: `terminal-${serial}`, workerSessionId: `native-session-${serial}`,
    workerStartedAt: iso(-5000), promptPath,
    submission: { status: phase, attemptId: 'attempt-fixture', file: submissionFile },
  };
  fs.writeFileSync(promptPath, promptBytes);
  const attempt = {
    protocol: 1, attemptId: task.submission.attemptId, taskId: id, round: task.round, agent: 'cbc',
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId,
    workerSessionId: task.workerSessionId, promptSha256: sha(promptBytes), status: phase, createdAt: iso(0),
  };
  writeJson(path.join(taskRoot, 'task.json'), task);
  writeJson(submissionFile, attempt);
  writeLease(task);
  const pointer = renderSubmissionPointer(task);
  const submit = {
    timestamp: iso(1000), name: 'UserPromptSubmit', source: 'test-hook', sessionId: task.workerSessionId,
    taskId: task.id, round: task.round, herdrSession: task.herdrSession,
    paneId: task.paneId, terminalId: task.terminalId, identityBound: true,
    promptSha256: sha(Buffer.from(pointer, 'utf8')), submissionAttemptId: task.submission.attemptId,
  };
  const hookFile = path.join(stateDir, 'hook-events.ndjson');
  const nativeTranscriptRoot = path.join(root, `native-${serial}`);
  const nativeTranscript = path.join(nativeTranscriptRoot, `${task.workerSessionId}.jsonl`);
  const setEvents = events => fs.writeFileSync(hookFile, events.map(JSON.stringify).join('\n') + '\n');
  const appendEvents = events => fs.appendFileSync(hookFile, events.map(JSON.stringify).join('\n') + '\n');
  const nativeUser = (offset, text = pointer, overrides = {}) => ({
    id: `native-user-${serial}-${offset}`, type: 'message', role: 'user',
    sessionId: task.workerSessionId, cwd: task.cwd, timestamp: iso(offset),
    content: [{ type: 'input_text', text }], ...overrides,
  });
  const writeNative = (records, tail = '') => {
    fs.mkdirSync(nativeTranscriptRoot, { recursive: true });
    fs.writeFileSync(nativeTranscript, records.map(JSON.stringify).join('\n') + (records.length ? '\n' : '') + tail);
  };
  const hook = (name, offset, overrides = {}) => ({
    timestamp: iso(offset), name, source: 'test-hook', sessionId: task.workerSessionId,
    taskId: task.id, round: task.round, herdrSession: task.herdrSession,
    paneId: task.paneId, terminalId: task.terminalId, identityBound: true, ...overrides,
  });
  setEvents([submit]);
  return { stateDir, taskRoot, task, attempt, promptPath, promptBytes, submissionFile, pointer, submit,
    hookFile, nativeTranscriptRoot, nativeTranscript, nativeUser, writeNative,
    iso, setEvents, appendEvents, hook, read: options => readTurn(task, options) };
}

function captureChild(script, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('captureSubmission hashes only native string prompts and tags only an exact protocol pointer', () => {
  const f = fixture();
  for (const phase of ['sending', 'observed', 'uncertain']) {
    const exact = captureSubmission({ hook_event_name: 'UserPromptSubmit', prompt: f.pointer },
      { ...f.task, submission: { ...f.task.submission, status: phase } });
    assert.deepEqual(exact, { promptSha256: sha(Buffer.from(f.pointer, 'utf8')),
      promptSha256Origin: 'hook-prompt', submissionAttemptId: f.task.submission.attemptId });
  }
  const foreignText = 'private manual prompt body';
  const foreign = captureSubmission({ event: 'UserPromptSubmit', prompt: foreignText }, f.task);
  assert.deepEqual(foreign, { promptSha256: sha(Buffer.from(foreignText, 'utf8')), promptSha256Origin: 'hook-prompt' });
  assert.ok(!JSON.stringify(foreign).includes(foreignText));
  assert.deepEqual(captureSubmission({ event: 'Stop', prompt: f.pointer }, f.task), { promptSha256: null });
  assert.deepEqual(captureSubmission({ event: 'UserPromptSubmit', prompt: 7 }, f.task), { promptSha256: null });
  const empty = captureSubmission({ event: 'UserPromptSubmit', prompt: '' }, f.task);
  assert.deepEqual(empty, { promptSha256: sha(Buffer.alloc(0)), promptSha256Origin: 'hook-prompt' });
  const oldTask = { ...f.task, cbcTurnProtocol: undefined };
  assert.deepEqual(captureSubmission({ event: 'UserPromptSubmit', prompt: f.pointer }, oldTask),
    { promptSha256: sha(Buffer.from(f.pointer, 'utf8')), promptSha256Origin: 'hook-prompt' });
  const invalidAttempt = { ...f.task, submission: { ...f.task.submission, attemptId: '../unsafe' } };
  assert.deepEqual(captureSubmission({ event: 'UserPromptSubmit', prompt: f.pointer }, invalidAttempt),
    { promptSha256: sha(Buffer.from(f.pointer, 'utf8')), promptSha256Origin: 'hook-prompt' });
});

test('normal current turn is active, an older Stop is ignored, and a later bound Stop proves stopped', () => {
  const f = fixture();
  f.setEvents([f.hook('Stop', 500), f.submit]);
  const active = f.read();
  assert.equal(active.state, 'active');
  assert.equal(active.attemptId, f.task.submission.attemptId);
  assert.equal(active.submittedAt, f.iso(1000));
  assert.equal(active.stopAt, null);
  f.appendEvents([f.hook('PreToolUse', 2000), f.hook('Stop', 3000)]);
  const stopped = f.read();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopAt, f.iso(3000));
  assert.equal(stopped.laterInputAt, null);
});

test('compact SessionStart and activity after an earlier Stop keep the turn active until its last Stop', () => {
  const f = fixture();
  f.setEvents([f.submit, f.hook('SessionStart', 2000, { source: 'compact' }),
    f.hook('Stop', 3000), f.hook('PostToolUse', 3500)]);
  assert.equal(f.read().state, 'active');
  f.appendEvents([f.hook('Stop', 4000)]);
  const stopped = f.read();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopAt, f.iso(4000));
});

test('foreign input is hash-only and cannot stand in for the recorded submission', () => {
  const f = fixture();
  const foreign = { ...f.submit, promptSha256: sha('foreign prompt'), submissionAttemptId: undefined };
  delete foreign.submissionAttemptId;
  f.setEvents([foreign]);
  const result = f.read();
  assert.equal(result.state, 'unconfirmed');
  assert.match(result.reason, /uniquely matches/);
  assert.equal(JSON.stringify(result).includes(f.pointer), false);
});

test('manual follow-up after Stop supersedes the old turn and carries ISO boundary times', () => {
  const f = fixture();
  const manual = {
    ...f.hook('UserPromptSubmit', 3000, { identityBound: false, taskId: null, round: null }),
    promptSha256: sha('new user request'),
  };
  f.setEvents([f.submit, f.hook('Stop', 2000), manual]);
  const result = f.read();
  assert.equal(result.state, 'superseded');
  assert.equal(result.submittedAt, f.iso(1000));
  assert.equal(result.stopAt, f.iso(2000));
  assert.equal(result.laterInputAt, f.iso(3000));
});

test('an empty manual prompt is still a native user boundary but never inherits the task attempt', () => {
  const f = fixture();
  const emptyCapture = captureSubmission({ event: 'UserPromptSubmit', prompt: '' }, f.task);
  assert.deepEqual(emptyCapture, { promptSha256: sha(Buffer.alloc(0)), promptSha256Origin: 'hook-prompt' });
  const emptyManual = { ...f.hook('UserPromptSubmit', 2500, { identityBound: false, taskId: null, round: null }),
    ...emptyCapture };
  f.setEvents([f.submit, f.hook('Stop', 2000), emptyManual]);
  assert.equal(f.read().state, 'superseded');
});

test('a partial append is ignored, while a malformed complete JSONL line invalidates proof', () => {
  const f = fixture();
  f.setEvents([f.submit, f.hook('Stop', 2000)]);
  fs.appendFileSync(f.hookFile, '{"timestamp":"partial');
  assert.equal(f.read().state, 'stopped');
  fs.appendFileSync(f.hookFile, '\n{broken}\n');
  const result = f.read();
  assert.equal(result.state, 'invalid');
  assert.match(result.reason, /malformed complete JSONL/);
});

test('identity conflicts, prompt tampering, and repeated attempts fail closed', () => {
  const identity = fixture();
  identity.setEvents([identity.submit, identity.hook('Stop', 2000, { round: identity.task.round + 1 })]);
  assert.equal(identity.read().state, 'invalid');

  const tampered = fixture();
  fs.appendFileSync(tampered.promptPath, 'changed');
  assert.equal(tampered.read().state, 'invalid');

  const repeated = fixture();
  repeated.appendEvents([repeated.submit]);
  assert.equal(repeated.read().state, 'invalid');

  const secondAttempt = fixture();
  writeJson(path.join(secondAttempt.taskRoot, 'round-003-submission-second.json'),
    { ...secondAttempt.attempt, attemptId: 'second', status: 'sending' });
  assert.equal(secondAttempt.read().state, 'invalid');
});

test('rejected-before-input journals do not block the unique current submission attempt', () => {
  const f = fixture();
  writeJson(path.join(f.taskRoot, 'round-003-submission-rejected.json'), {
    ...f.attempt, attemptId: 'attempt-rejected', status: 'rejected-before-input',
  });
  assert.equal(f.read().state, 'active');
});

test('watcher-owned task updates are tolerated, and only an exact bound Notification is blocked', () => {
  const f = fixture();
  f.task.watcherPid = 4321;
  f.task.submission.status = 'observed';
  const taskFile = path.join(f.taskRoot, 'task.json');
  const saved = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  saved.watcherPid = 4321;
  saved.submission.status = 'observed';
  writeJson(taskFile, saved);
  f.setEvents([f.submit, f.hook('Notification', 2000, { notificationType: 'permission_prompt' })]);
  assert.equal(f.read().state, 'blocked');
  f.setEvents([f.submit, f.hook('Notification', 2000,
    { notificationType: 'permission_prompt', round: f.task.round + 1 })]);
  assert.equal(f.read().state, 'invalid');
  f.setEvents([f.submit, f.hook('Notification', 2000, { notificationType: 'idle_prompt' })]);
  assert.equal(f.read().state, 'invalid');
});

test('injected Hook events remain test-only and do not bypass persisted task, attempt, prompt, or lease checks', () => {
  const f = fixture();
  const eventReads = [];
  const result = readTurn(f.task, { readEvents: file => { eventReads.push(file); return [f.submit]; } });
  assert.equal(result.state, 'active');
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0], f.hookFile);
  const leaseFile = require('../lib/worker-lease').leasePath(f.stateDir, f.task.herdrSession, f.task.paneId);
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  lease.workerSessionId = 'foreign-native';
  writeJson(leaseFile, lease);
  assert.equal(readTurn(f.task, { readEvents: () => [f.submit] }).state, 'invalid');
});

test('an oversized Hook journal is rejected before reading its contents', () => {
  const f = fixture();
  fs.truncateSync(f.hookFile, 64 * 1024 * 1024 + 1);
  const result = f.read();
  assert.equal(result.state, 'invalid');
  assert.match(result.reason, /64 MiB/);
});

test('old Hook submissions without hashes require explicit native transcript reconciliation', () => {
  const f = fixture();
  const old = { ...f.submit };
  delete old.promptSha256;
  delete old.submissionAttemptId;
  f.setEvents([old]);
  const result = f.read();
  assert.equal(result.state, 'unconfirmed');
  assert.match(result.reason, /explicit native transcript reconciliation/);
});

test('CBC Hook records hash-only unbound input and never leaks prompt text or marks an attempt', async () => {
  const stateDir = path.join(root, `hook-${++serial}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const paneId = 'w1:p-unbound', terminalId = 'terminal-unbound';
  const herdrStub = path.join(root, 'herdr-pane-stub.cjs');
  fs.writeFileSync(herdrStub,
    "process.stdout.write(JSON.stringify({result:{pane:{pane_id:process.env.HARK_HOOK_PANE_ID,terminal_id:process.env.HARK_HOOK_TERMINAL_ID}}}));\n");
  const secretPrompt = 'unique private prompt body 9d6c4f';
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), {
    AGENT_BRIDGE_STATE_DIR: stateDir, AGENT_BRIDGE_TASK_ID: 'cbc-turn-unbound',
    AGENT_BRIDGE_HERDR_SESSION: 'unbound-service', HERDR_ENV: '1', HERDR_PANE_ID: paneId,
    HERDR_BIN_PATH: herdrStub, HARK_HOOK_PANE_ID: paneId, HARK_HOOK_TERMINAL_ID: terminalId,
    AGENT_BRIDGE_HOOK_DRY_RUN: '1',
  }, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'native-unbound', prompt: secretPrompt }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  const event = JSON.parse(fs.readFileSync(path.join(stateDir, 'hook-events.ndjson'), 'utf8').trim());
  assert.equal(event.promptSha256, sha(Buffer.from(secretPrompt, 'utf8')));
  assert.equal(event.promptSha256Origin, 'hook-prompt');
  assert.equal(event.submissionAttemptId, undefined);
  assert.equal(event.identityBound, false);
  assert.equal(event.terminalId, terminalId);
  assert.equal(JSON.stringify(event).includes(secretPrompt), false);
});

test('CBC Hook logs the attempt ID only for its exact bound submission pointer', async () => {
  const f = fixture();
  const paneStub = path.join(root, 'herdr-pane-bound-stub.cjs');
  const userHome = path.join(root, `hook-home-${serial}`);
  const nativeTranscriptRoot = path.join(userHome, '.codebuddy', 'projects');
  const nativeTranscript = path.join(nativeTranscriptRoot, 'project', `${f.task.workerSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(nativeTranscript), { recursive: true });
  fs.writeFileSync(nativeTranscript, JSON.stringify(f.nativeUser(900)) + '\n');
  f.setEvents([]);
  fs.writeFileSync(paneStub,
    "process.stdout.write(JSON.stringify({result:{pane:{pane_id:process.env.HARK_HOOK_PANE_ID,terminal_id:process.env.HARK_HOOK_TERMINAL_ID}}}));\n");
  const result = await captureChild(path.join(__dirname, '..', 'hooks', 'herdr-codebuddy.js'), {
    AGENT_BRIDGE_STATE_DIR: f.stateDir, AGENT_BRIDGE_TASK_ID: f.task.id,
    AGENT_BRIDGE_HERDR_SESSION: f.task.herdrSession, HERDR_ENV: '1', HERDR_PANE_ID: f.task.paneId,
    HERDR_BIN_PATH: paneStub, HARK_HOOK_PANE_ID: f.task.paneId, HARK_HOOK_TERMINAL_ID: f.task.terminalId,
    AGENT_BRIDGE_HOOK_DRY_RUN: '1', USERPROFILE: userHome,
  }, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: f.task.workerSessionId,
    round: f.task.round, prompt: f.pointer, transcript_path: nativeTranscript }));
  assert.equal(result.code, 0, result.stderr);
  const event = JSON.parse(fs.readFileSync(f.hookFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(event.promptSha256, f.submit.promptSha256);
  assert.equal(event.promptSha256Origin, 'hook-prompt');
  assert.equal(event.submissionAttemptId, f.task.submission.attemptId);
  assert.equal(event.nativeTranscript, nativeTranscript);
  assert.equal(event.identityBound, true);
  assert.equal(JSON.stringify(event).includes(f.pointer), false);
  const turn = readTurn(f.task, { nativeTranscriptRoot });
  assert.equal(turn.state, 'active', turn.reason);
});

test('native transcript fallback accepts Hook metadata prompts only when the exact native pointer follows the attempt', () => {
  const f = fixture();
  const decoratedHook = { ...f.submit, promptSha256: sha('metadata envelope plus prompt'),
    promptSha256Origin: 'hook-prompt', nativeTranscript: f.nativeTranscript };
  delete decoratedHook.submissionAttemptId;
  f.setEvents([decoratedHook, f.hook('Stop', 2000)]);
  f.writeNative([f.nativeUser(900)]);
  const result = f.read({ nativeTranscriptRoot: f.nativeTranscriptRoot });
  assert.equal(result.state, 'stopped');
  assert.equal(result.submittedAt, f.iso(1000));
  assert.equal(result.stopAt, f.iso(2000));
});

test('native transcript paths must name this session inside the supplied temporary root', () => {
  const outside = fixture();
  const outsidePath = path.join(root, 'outside-native', path.basename(outside.nativeTranscript));
  fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
  fs.writeFileSync(outsidePath, JSON.stringify(outside.nativeUser(900)) + '\n');
  outside.setEvents([{ ...outside.submit, nativeTranscript: outsidePath }]);
  assert.equal(outside.read({ nativeTranscriptRoot: outside.nativeTranscriptRoot }).state, 'invalid');

  const wrongName = fixture();
  const foreignFile = path.join(wrongName.nativeTranscriptRoot, 'not-this-session.jsonl');
  fs.mkdirSync(wrongName.nativeTranscriptRoot, { recursive: true });
  fs.writeFileSync(foreignFile, JSON.stringify(wrongName.nativeUser(900)) + '\n');
  wrongName.setEvents([{ ...wrongName.submit, nativeTranscript: foreignFile }]);
  assert.equal(wrongName.read({ nativeTranscriptRoot: wrongName.nativeTranscriptRoot }).state, 'invalid');
});

test('old native transcript rows do not prove a submission created in the current attempt', () => {
  const f = fixture();
  f.setEvents([{ ...f.submit, nativeTranscript: f.nativeTranscript }]);
  f.writeNative([f.nativeUser(-100)]);
  const result = f.read({ nativeTranscriptRoot: f.nativeTranscriptRoot });
  assert.equal(result.state, 'unconfirmed');
  assert.match(result.reason, /has not persisted this submission yet/);
});

test('native transcript tail append is tolerated and a later native input supersedes even without a later Hook', () => {
  const partial = fixture();
  partial.setEvents([{ ...partial.submit, nativeTranscript: partial.nativeTranscript }, partial.hook('Stop', 2000)]);
  partial.writeNative([partial.nativeUser(900)], '{"partial":');
  assert.equal(partial.read({ nativeTranscriptRoot: partial.nativeTranscriptRoot }).state, 'stopped');

  const followup = fixture();
  followup.setEvents([{ ...followup.submit, nativeTranscript: followup.nativeTranscript }, followup.hook('Stop', 2000)]);
  followup.writeNative([followup.nativeUser(900), followup.nativeUser(2500, 'manual follow-up with no Hook')]);
  const result = followup.read({ nativeTranscriptRoot: followup.nativeTranscriptRoot });
  assert.equal(result.state, 'superseded');
  assert.equal(result.stopAt, followup.iso(2000));
  assert.equal(result.laterInputAt, followup.iso(2500));
});

test('empty and pre-attempt native transcripts remain unconfirmed, and Hook/native time conflicts invalidate proof', () => {
  const empty = fixture();
  empty.setEvents([{ ...empty.submit, nativeTranscript: empty.nativeTranscript }]);
  empty.writeNative([]);
  assert.equal(empty.read({ nativeTranscriptRoot: empty.nativeTranscriptRoot }).state, 'unconfirmed');

  const conflict = fixture();
  conflict.setEvents([{ ...conflict.submit, nativeTranscript: conflict.nativeTranscript }]);
  conflict.writeNative([conflict.nativeUser(1500)]);
  const conflictResult = conflict.read({ nativeTranscriptRoot: conflict.nativeTranscriptRoot });
  assert.equal(conflictResult.state, 'unconfirmed');
  assert.match(conflictResult.reason, /ordered submission Hook/);
});

test('native transcript reconciliation receipt must be bound to the exact task, round, attempt, and path', () => {
  const f = fixture();
  f.setEvents([f.submit, f.hook('Stop', 2000)]);
  f.writeNative([f.nativeUser(900)]);
  const receiptPath = path.join(f.taskRoot, 'round-003-cbc-reconciliation-attempt-fixture.json');
  f.task.submission.reconciliationFile = receiptPath;
  const taskFile = path.join(f.taskRoot, 'task.json');
  writeJson(taskFile, f.task);
  writeJson(receiptPath, { taskId: f.task.id, round: f.task.round,
    attemptId: f.task.submission.attemptId, nativeTranscript: f.nativeTranscript });
  assert.equal(f.read({ nativeTranscriptRoot: f.nativeTranscriptRoot }).state, 'stopped');

  writeJson(receiptPath, { taskId: f.task.id, round: f.task.round,
    attemptId: 'another-attempt', nativeTranscript: f.nativeTranscript });
  assert.equal(f.read({ nativeTranscriptRoot: f.nativeTranscriptRoot }).state, 'invalid');

  f.task.submission.reconciliationFile = path.join(f.taskRoot, 'wrong-receipt.json');
  writeJson(taskFile, f.task);
  assert.equal(f.read({ nativeTranscriptRoot: f.nativeTranscriptRoot }).state, 'invalid');
});

function localStatusRows(f) {
  return structuredClone(require('./fixtures/cbc-local-status.json')).map(({timestampOffset,...row})=>({
    ...row, sessionId:f.task.workerSessionId,cwd:f.task.cwd,timestamp:f.iso(2500+timestampOffset)
  }));
}

test('real local status group after Stop is audited but does not supersede the native model turn', () => {
  const f=fixture(), rows=localStatusRows(f);
  f.setEvents([{...f.submit,nativeTranscript:f.nativeTranscript},f.hook('Stop',2000)]);
  f.writeNative([f.nativeUser(900),...rows]);
  const before=fs.readFileSync(f.nativeTranscript), taskBefore=fs.readFileSync(path.join(f.taskRoot,'task.json'));
  const turn=f.read({nativeTranscriptRoot:f.nativeTranscriptRoot});
  assert.equal(turn.state,'stopped'); assert.equal(turn.laterInputAt,null);
  assert.equal(turn.ignoredLocalCommands[0].recordCount,3); assert.equal(turn.ignoredLocalCommands[0].recordsSha256,sha(JSON.stringify(rows)));
  assert.deepEqual(fs.readFileSync(f.nativeTranscript),before);assert.deepEqual(fs.readFileSync(path.join(f.taskRoot,'task.json')),taskBefore);
});

test('local status exclusion requires exact metadata, linked complete group, identity, and a prior bound Stop', () => {
  for(const variant of ['missing-skip','false-skip','other-agent','request','parent','id','missing-command','other-command','args','extra-body','before-stop','no-stop','foreign-identity','new-input','real-submit-hook']) {
    const f=fixture(), rows=localStatusRows(f);
    if(variant==='missing-skip')delete rows[0].providerData.skipRun;
    if(variant==='false-skip')rows[2].providerData.skipRun=false;
    if(variant==='other-agent')rows[1].providerData.agent='other';
    if(variant==='request')rows[2].providerData.conversationRequestId='other';
    if(variant==='parent')rows[2].parentId='other';
    if(variant==='id')rows[2].id=rows[0].id;
    if(variant==='missing-command')rows.pop();
    if(variant==='other-command')rows[2].content[0].text='<command-name>/clear</command-name>';
    if(variant==='args')rows[2].content[0].text+='<command-args>anything</command-args>';
    if(variant==='extra-body')rows[2].content.push({type:'input_text',text:'real work'});
    if(variant==='before-stop')rows.forEach((r,i)=>r.timestamp=f.iso(1500+i));
    if(variant==='foreign-identity')rows[2].sessionId='foreign';
    if(variant==='new-input')rows.push(f.nativeUser(3000,'new work'));
    const hooks=[{...f.submit,nativeTranscript:f.nativeTranscript}];
    if(variant!=='no-stop')hooks.push(f.hook('Stop',2000));
    if(variant==='real-submit-hook')hooks.push(f.hook('UserPromptSubmit',2600,{submissionAttemptId:null,promptSha256:sha('/status')}));
    f.setEvents(hooks);f.writeNative([f.nativeUser(900),...rows]);
    assert.notEqual(f.read({nativeTranscriptRoot:f.nativeTranscriptRoot}).state,'stopped',variant);
  }
});

test('official observed-turn reconciliation is read-only and accept handles local status without treating real input as safe', () => {
  const {spawnSync}=require('node:child_process');
  for(const later of [false,true]) {
    const f=fixture({phase:'observed'}), userHome=path.join(root,'accept-home-'+serial);
    const nativeRoot=path.join(userHome,'.codebuddy','projects');fs.mkdirSync(nativeRoot,{recursive:true});
    const transcript=path.join(nativeRoot,f.task.workerSessionId+'.jsonl');
    const rows=[f.nativeUser(900),...localStatusRows(f)];if(later)rows.push(f.nativeUser(3000,'actual new work'));
    fs.writeFileSync(transcript,rows.map(JSON.stringify).join('\n')+'\n');
    f.setEvents([{...f.submit,nativeTranscript:transcript},f.hook('Stop',2000)]);
    f.task.status='review_pending'; f.task.history=[];writeJson(path.join(f.taskRoot,'task.json'),f.task);
    const preload=path.join(f.taskRoot,'preload.cjs'), lib=path.resolve(__dirname,'../lib');
    fs.writeFileSync(preload,`const h=require(${JSON.stringify(lib+'/herdr')});h.agentInfo=()=>{throw Error('no live terminal permitted')};h.api=()=>{throw Error('no input permitted')};require(${JSON.stringify(lib+'/notify')}).notifyTask=async()=>({status:'fixture-only'});`);
    const args=['--require',preload,path.resolve(__dirname,'../bin/agent-bridge.js')];
    const env={...process.env,USERPROFILE:userHome,AGENT_BRIDGE_STATE_DIR:f.stateDir};
    const run=a=>spawnSync(process.execPath,[...args,...a],{env,encoding:'utf8',windowsHide:true,timeout:15000});
    const original=fs.readFileSync(path.join(f.taskRoot,'task.json'));
    const diagnostic=run(['reconcile-submission',f.task.id,'--cbc-transcript',transcript]);
    assert.equal(diagnostic.status,0,diagnostic.stderr);const result=JSON.parse(diagnostic.stdout);
    assert.equal(result.state,later?'superseded':'stopped');assert.equal(result.taskMutated,false);
    assert.deepEqual(fs.readFileSync(path.join(f.taskRoot,'task.json')),original);
    const accepted=run(['accept',f.task.id]);
    if(later){assert.equal(accepted.status,1);assert.equal(JSON.parse(accepted.stderr).code,'CBC_ACCEPT_TURN_UNCONFIRMED');assert.match(accepted.stderr,/superseded/);assert.deepEqual(fs.readFileSync(path.join(f.taskRoot,'task.json')),original);}
    else{assert.equal(accepted.status,0,accepted.stderr);assert.equal(JSON.parse(accepted.stdout).status,'accepted');}
  }
});

test('a later native model menu remains unconfirmed after excluding the read-only status group', () => {
  const f=fixture(), status=localStatusRows(f), model=[
    f.nativeUser(3500,status[0].content[0].text,{providerData:{skipRun:true,agent:'cli',conversationRequestId:'model-request'}}),
    f.nativeUser(3501,'<command-name>/model</command-name>',{providerData:{skipRun:true,agent:'cli',conversationRequestId:'model-request'}})
  ];
  f.setEvents([{...f.submit,nativeTranscript:f.nativeTranscript},f.hook('Stop',2000)]);
  f.writeNative([f.nativeUser(900),...status,...model]);
  const turn=f.read({nativeTranscriptRoot:f.nativeTranscriptRoot});
  assert.equal(turn.state,'unconfirmed');assert.match(turn.reason,/unsupported native local command/);
  assert.equal(turn.laterInputAt,f.iso(3500));assert.equal(turn.ignoredLocalCommands[0].recordCount,3);
});

test('completed native model and login administration do not invalidate an earlier Stop, but incomplete or unbound output does', () => {
  for(const command of ['/model','/login'])for(const mode of ['complete','missing-output','foreign-output']){
    const f=fixture(), status=localStatusRows(f), first={...status[0],id:'admin-caveat',timestamp:f.iso(3500)},
      input={...status[2],id:'admin-command',parentId:'admin-caveat',timestamp:f.iso(3501),content:[{type:'input_text',text:`<command-name>${command}</command-name>`}]},
      output={...status[2],id:'admin-output',parentId:mode==='foreign-output'?'foreign':'admin-command',timestamp:f.iso(3502),content:[{type:'input_text',text:'<local-command-stdout></local-command-stdout>'}]};
    f.setEvents([{...f.submit,nativeTranscript:f.nativeTranscript},f.hook('Stop',2000)]);
    f.writeNative([f.nativeUser(900),...status,first,input,...(mode==='missing-output'?[]:[output])]);
    const turn=f.read({nativeTranscriptRoot:f.nativeTranscriptRoot});
    assert.equal(turn.state,mode==='complete'?'stopped':'unconfirmed',command+'/'+mode);
    if(mode==='complete')assert.deepEqual(turn.ignoredLocalCommands.map(x=>x.command),['/status',command]);
  }
});
