'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectRejection } = require('../lib/submission-rejection');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-submission-rejection-'));
const cliPath = path.resolve(__dirname, '..', 'bin', 'agent-bridge.js');
const herdrGuardPath = path.join(root, 'herdr-call-guard.cjs');
const herdrCallLog = path.join(root, 'herdr-calls.ndjson');
fs.writeFileSync(herdrGuardPath, "require('node:fs').appendFileSync(process.env.HERDR_CALL_LOG, 'called\\n'); process.exit(73);\n");
let serial = 0;

test.after(() => {
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(temp + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function rawError({ code = 'agent_not_ready', message, id = 'cli:agent:prompt' } = {}) {
  return JSON.stringify({ error: { code, message: message || `agent pane-${serial} is not an active named agent` }, id });
}

function fullDispatchCommand(id) {
  return [
    String.raw`powershell -NoProfile -Command "& 'C:\Program Files\nodejs\node.exe' 'C:\bridge\bin\agent-bridge.js' dispatch`,
    String.raw`--task-id '${id}' --cwd 'C:\workspace\project'"`,
  ].join(' `\r\n ');
}

function msysDispatchCommand(id, stateDir) {
  return `MSYSTEM=UCRT64 AGENT_BRIDGE_STATE_DIR="${stateDir}" `
    + `AGENT_BRIDGE_CBC="C:\\Program Files\\CodeBuddy\\cbc.cmd" `
    + `"/d/Program Files/nodejs/node.exe" "C:\\bridge\\agent-bridge\\bin\\agent-bridge.js" `
    + `dispatch --agent cbc --cwd "C:\\workspace\\project" --task-id ${id} `
    + `--worker-key main --resume-task older-task --full-context --spec-file delegation/tasks/spec.json `
    + '--trust-folder --wait-timeout-ms 7200000';
}

function fixture({ code = 'agent_not_ready', rejection = 'inactive', includeHook = false, legacy = false } = {}) {
  const sequence = ++serial, id = `hark-rejection-${sequence}`;
  const stateDir = path.join(root, `state-${sequence}`), taskDir = path.join(stateDir, 'tasks', id);
  const cwd = path.join(root, `project-${sequence}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const round = 5, paneId = `pane-${sequence}`;
  const message = rejection === 'foreground' ? `agent ${paneId} is no longer the pane foreground process`
    : `agent ${paneId} is not an active named agent`;
  const error = rawError({ code, message });
  const promptPath = path.join(taskDir, `round-${String(round).padStart(3, '0')}-prompt.md`);
  const promptBytes = Buffer.from(`Delivery protocol\nOriginal isolated request ${sequence}\n`, 'utf8');
  fs.writeFileSync(promptPath, promptBytes);
  const attemptId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const attemptFile = legacy ? null : path.join(taskDir, `round-${String(round).padStart(3, '0')}-submission-${attemptId}.json`);
  const attempt = legacy ? null : { protocol: 1, attemptId, taskId: id, round, agent: 'cbc',
    herdrSession: `session-${sequence}`, paneId, terminalId: `terminal-${sequence}`,
    workerSessionId: `native-${sequence}`, promptSha256: sha256(promptBytes), status: 'uncertain',
    createdAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString(),
    errorCode: code, inputAccepted: false };
  if (attemptFile) fs.writeFileSync(attemptFile, JSON.stringify(attempt, null, 2));
  const task = { id, stateDir, cwd, agent: 'cbc', agentName: `worker-${sequence}`,
    status: 'submission_unknown', round, paneId,
    herdrSession: `session-${sequence}`, terminalId: `terminal-${sequence}`,
    workerSessionId: `native-${sequence}`, workerKey: 'primary', promptPath,
    submission: { status: 'uncertain', baselineCompletion: 3,
      ...(!legacy ? { attemptId, file: attemptFile } : {}) },
    watcherPid: null, error,
    history: [
      { round: 4, status: 'submitted', timestamp: new Date(Date.now() - 12000).toISOString() },
      { round, status: 'submitted', timestamp: new Date(Date.now() - 4000).toISOString() },
      { round, status: 'submission_unknown', timestamp: new Date(Date.now() - 2000).toISOString(), message: error },
    ] };
  const taskFile = path.join(taskDir, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
  const eventsFile = path.join(stateDir, 'events.ndjson');
  const events = [
    { timestamp: new Date(Date.now() - 11000).toISOString(), taskId: id, round: 4, type: 'submitted' },
    { timestamp: new Date(Date.now() - 3000).toISOString(), taskId: id, round, type: 'submission_uncertain', message: error },
    { timestamp: new Date(Date.now() - 1000).toISOString(), taskId: id, round, type: 'dispatch_failed', message: error },
  ];
  fs.writeFileSync(eventsFile, `${events.map(item => JSON.stringify(item)).join('\n')}\n`);
  if (includeHook) {
    fs.writeFileSync(path.join(stateDir, 'hook-events.ndjson'), `${JSON.stringify({ timestamp: new Date().toISOString(),
      taskId: id, round, paneId, sessionId: task.workerSessionId, name: 'UserPromptSubmit', source: 'agy-native-hook' })}\n`);
  }
  const receiptFile = path.join(root, `receipt-${sequence}.json`);
  const receipt = { command: fullDispatchCommand(id), exit_code: 1, stdout: '',
    stderr: JSON.stringify({ error, code: 'HERDR_COMMAND_FAILED' }) };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  return { id, stateDir, taskDir, taskFile, task, attempt, attemptFile, eventsFile,
    promptPath, promptBytes, receiptFile, receipt };
}

function inspect(f, task = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'))) {
  return inspectRejection(task, { receiptFile: f.receiptFile });
}

function writeTask(f, mutate) {
  const task = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'));
  mutate(task);
  fs.writeFileSync(f.taskFile, JSON.stringify(task, null, 2));
  return task;
}

function writeReceipt(f, mutate) {
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'));
  mutate(receipt);
  fs.writeFileSync(f.receiptFile, JSON.stringify(receipt, null, 2));
}

function runCli(f, args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: {
    ...process.env,
    AGENT_BRIDGE_STATE_DIR: f.stateDir,
    HERDR_BIN_PATH: herdrGuardPath,
    HERDR_CALL_LOG: herdrCallLog,
  } });
}

function rewriteRawError(f, error) {
  const task = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'));
  task.error = error;
  const unknown = task.history.findLast(item => item.round === task.round && item.status === 'submission_unknown');
  unknown.message = error;
  fs.writeFileSync(f.taskFile, JSON.stringify(task, null, 2));
  const events = fs.readFileSync(f.eventsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  for (const event of events) if (event.taskId === task.id && event.round === task.round
      && ['submission_uncertain', 'dispatch_failed'].includes(event.type)) event.message = error;
  fs.writeFileSync(f.eventsFile, `${events.map(item => JSON.stringify(item)).join('\n')}\n`);
  writeReceipt(f, receipt => {
    receipt.stderr = JSON.stringify({ error, code: 'HERDR_COMMAND_FAILED' });
  });
}

test('accepts an exact pre-input Herdr rejection and returns only read-only hashes', () => {
  const f = fixture({ rejection: 'foreground' });
  const files = [f.taskFile, f.attemptFile, f.eventsFile, f.promptPath, f.receiptFile];
  const before = files.map(file => fs.readFileSync(file));
  const proof = inspect(f);
  const after = files.map(file => fs.readFileSync(file));
  const binding = { stateDir: path.resolve(f.task.stateDir), taskId: f.task.id, round: f.task.round,
    agent: f.task.agent, cwd: path.resolve(f.task.cwd), workerKey: f.task.workerKey,
    agentName: f.task.agentName || null,
    herdrSession: f.task.herdrSession, paneId: f.task.paneId, terminalId: f.task.terminalId,
    workerSessionId: f.task.workerSessionId };
  assert.deepEqual(Object.keys(proof), ['state', 'source', 'taskId', 'round', 'code', 'operation',
    'bindingSha256', 'taskSha256', 'receiptSha256', 'promptSha256', 'originalSubmissionPreserved', 'nativeWorkState']);
  assert.equal(proof.state, 'not_sent');
  assert.equal(proof.source, 'herdr-pre-input-rejection');
  assert.equal(proof.source, 'herdr-pre-input-rejection');
  assert.equal(proof.taskId, f.id);
  assert.equal(proof.round, 5);
  assert.equal(proof.code, 'agent_not_ready');
  assert.equal(proof.operation, 'agent.prompt');
  assert.equal(proof.bindingSha256, sha256(Buffer.from(JSON.stringify(binding))));
  assert.equal(proof.taskSha256, sha256(before[0]));
  assert.equal(proof.receiptSha256, sha256(before[4]));
  assert.equal(proof.promptSha256, sha256(f.promptBytes));
  assert.equal(proof.originalSubmissionPreserved, true);
  assert.equal(proof.nativeWorkState, 'not_checked');
  assert.deepEqual(after, before);
});

test('legacy task without attempt journals is proven through the exact RPC, event, history and full PowerShell command', () => {
  const f = fixture({ legacy: true });
  const proof = inspect(f);
  assert.equal(proof.state, 'not_sent');
  assert.equal(proof.source, 'legacy-rpc-crosscheck');
  assert.equal(proof.taskId, f.id);
  assert.equal(proof.promptSha256, sha256(f.promptBytes));

  const metadataCase = fixture({ legacy: true });
  writeTask(metadataCase, task => { task.submission.attemptId = 'missing-attempt-journal'; });
  assert.equal(inspect(metadataCase).state, 'unresolved');

  const journalCase = fixture({ legacy: true });
  fs.writeFileSync(path.join(journalCase.taskDir, 'round-005-submission-orphan.json'), JSON.stringify({ status: 'uncertain' }));
  assert.equal(inspect(journalCase).state, 'unresolved');
});

test('newer manual hook evidence does not imply the old rejected prompt was delivered', () => {
  const f = fixture({ includeHook: true });
  const hookFile = path.join(f.stateDir, 'hook-events.ndjson');
  fs.appendFileSync(hookFile, `${JSON.stringify({ timestamp: new Date().toISOString(), taskId: f.id,
    round: f.task.round, name: 'Stop', source: 'manual-native-work' })}\n`);
  const proof = inspect(f);
  assert.equal(proof.state, 'not_sent');
  assert.equal(proof.nativeWorkState, 'not_checked');
});

test('rejects stale caller snapshots and changed task or Pane bindings', () => {
  const f = fixture();
  const stale = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'));
  writeTask(f, task => { task.agentName = 'renamed-worker'; });
  assert.equal(inspect(f, stale).state, 'unresolved');

  const paneCase = fixture();
  const attempt = JSON.parse(fs.readFileSync(paneCase.attemptFile, 'utf8'));
  attempt.paneId = 'pane-replaced';
  fs.writeFileSync(paneCase.attemptFile, JSON.stringify(attempt));
  assert.equal(inspect(paneCase).state, 'unresolved');
});

test('rejects wrong rounds and malformed current-round submission history', () => {
  const f = fixture();
  writeTask(f, task => { task.round += 1; });
  assert.equal(inspect(f).state, 'unresolved');

  const historyCase = fixture();
  writeTask(historyCase, task => { task.history.push({ round: task.round, status: 'submitted', timestamp: new Date().toISOString() }); });
  assert.equal(inspect(historyCase).state, 'unresolved');
});

test('rejects changed prompt bytes and any ambiguous current-round submission attempt', () => {
  const promptCase = fixture();
  fs.appendFileSync(promptCase.promptPath, 'edited after rejection');
  assert.equal(inspect(promptCase).state, 'unresolved');

  const attemptCase = fixture();
  const secondAttempt = { ...attemptCase.attempt, attemptId: '10000000-0000-4000-8000-000000000001', status: 'sending' };
  fs.writeFileSync(path.join(attemptCase.taskDir, `round-005-submission-${secondAttempt.attemptId}.json`), JSON.stringify(secondAttempt));
  assert.equal(inspect(attemptCase).state, 'unresolved');
});

test('rejects success, later retry, or duplicate uncertainty events in the same round', () => {
  const successCase = fixture();
  const success = { timestamp: new Date().toISOString(), taskId: successCase.id,
    round: successCase.task.round, type: 'submitted', paneId: successCase.task.paneId };
  fs.appendFileSync(successCase.eventsFile, `${JSON.stringify(success)}\n`);
  assert.equal(inspect(successCase).state, 'unresolved');

  const laterCase = fixture();
  fs.appendFileSync(laterCase.eventsFile, `${JSON.stringify({ ...success, taskId: laterCase.id,
    round: laterCase.task.round, type: 'submission_uncertain', message: 'later bridge attempt' })}\n`);
  assert.equal(inspect(laterCase).state, 'unresolved');
});

test('rejects another RPC kind and timeout errors even when the outer receipt matches', () => {
  const rpcCase = fixture();
  rewriteRawError(rpcCase, rawError({ message: `agent ${rpcCase.task.paneId} is not an active named agent`, id: 'cli:agent:cancel' }));
  assert.equal(inspect(rpcCase).state, 'unresolved');

  const timeoutCase = fixture();
  rewriteRawError(timeoutCase, rawError({ code: 'timeout', message: 'Herdr request timed out' }));
  assert.equal(inspect(timeoutCase).state, 'unresolved');
});

test('rejects a receipt for a different command or an altered nested raw error', () => {
  const commandCase = fixture();
  writeReceipt(commandCase, receipt => { receipt.command = `echo dispatch --task-id ${commandCase.id}`; });
  assert.equal(inspect(commandCase).state, 'unresolved');

  const errorCase = fixture();
  writeReceipt(errorCase, receipt => { receipt.stderr = JSON.stringify({ error: 'different error', code: 'HERDR_COMMAND_FAILED' }); });
  assert.equal(inspect(errorCase).state, 'unresolved');
});

test('PowerShell command parser accepts one exact dispatch and rejects other operations, duplicates and command injection', () => {
  const wrongTask = fixture();
  writeReceipt(wrongTask, receipt => { receipt.command = fullDispatchCommand('hark-rejection-999'); });
  assert.equal(inspect(wrongTask).state, 'unresolved');

  const wrongOperation = fixture();
  writeReceipt(wrongOperation, receipt => { receipt.command = String.raw`node C:\bridge\bin\agent-bridge.js status hark-rejection-1`; });
  assert.equal(inspect(wrongOperation).state, 'unresolved');

  const duplicate = fixture();
  writeReceipt(duplicate, receipt => { receipt.command = `${fullDispatchCommand(duplicate.id)}; node C:\\bridge\\bin\\agent-bridge.js dispatch --task-id ${duplicate.id}`; });
  assert.equal(inspect(duplicate).state, 'unresolved');

  const nestedEcho = fixture();
  writeReceipt(nestedEcho, receipt => { receipt.command = `powershell -NoProfile -Command "Write-Output 'dispatch --task-id ${nestedEcho.id}'"`; });
  assert.equal(inspect(nestedEcho).state, 'unresolved');

  const appendedCommand = fixture();
  writeReceipt(appendedCommand, receipt => { receipt.command = `${fullDispatchCommand(appendedCommand.id)}; echo done`; });
  assert.equal(inspect(appendedCommand).state, 'unresolved');
});

test('MSYS2 receipt accepts only literal whitelisted environment assignments bound to the task state root', () => {
  const accepted = fixture();
  writeReceipt(accepted, receipt => { receipt.command = msysDispatchCommand(accepted.id, accepted.stateDir); });
  assert.equal(inspect(accepted).state, 'not_sent');

  const wrongState = fixture();
  writeReceipt(wrongState, receipt => { receipt.command = msysDispatchCommand(wrongState.id, path.join(root, 'other-state')); });
  assert.equal(inspect(wrongState).state, 'unresolved');

  const hostileEnv = fixture();
  writeReceipt(hostileEnv, receipt => {
    receipt.command = msysDispatchCommand(hostileEnv.id, hostileEnv.stateDir)
      .replace('AGENT_BRIDGE_CBC="C:\\Program Files\\CodeBuddy\\cbc.cmd"', 'AGENT_BRIDGE_CBC="$(echo bad)"');
  });
  assert.equal(inspect(hostileEnv).state, 'unresolved');

  const extraEnv = fixture();
  writeReceipt(extraEnv, receipt => {
    receipt.command = `PATH=C:\\evil ${msysDispatchCommand(extraEnv.id, extraEnv.stateDir)}`;
  });
  assert.equal(inspect(extraEnv).state, 'unresolved');

  const externalCommand = fixture();
  writeReceipt(externalCommand, receipt => {
    receipt.command = `echo ${msysDispatchCommand(externalCommand.id, externalCommand.stateDir)}`;
  });
  assert.equal(inspect(externalCommand).state, 'unresolved');
});

test('rejects tasks that are not an unresolved CBC submission with no watcher', () => {
  for (const mutate of [
    task => { task.agent = 'agy'; },
    task => { task.status = 'running'; },
    task => { task.submission.status = 'observed'; },
    task => { task.watcherPid = 1234; },
  ]) {
    const f = fixture();
    writeTask(f, mutate);
    assert.equal(inspect(f).state, 'unresolved');
  }
});

test('rejects a non-empty stdout or malformed/missing uncertainty evidence', () => {
  const stdoutCase = fixture();
  writeReceipt(stdoutCase, receipt => { receipt.stdout = 'output'; });
  assert.equal(inspect(stdoutCase).state, 'unresolved');

  const eventCase = fixture();
  const events = fs.readFileSync(eventCase.eventsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .filter(item => item.type !== 'submission_uncertain');
  fs.writeFileSync(eventCase.eventsFile, `${events.map(item => JSON.stringify(item)).join('\n')}\n`);
  assert.equal(inspect(eventCase).state, 'unresolved');
});

test('real reconcile-submission CLI returns the rejection proof without changing task bytes or calling Herdr', () => {
  const f = fixture();
  fs.rmSync(herdrCallLog, { force: true });
  const before = fs.readFileSync(f.taskFile);
  const result = runCli(f, ['reconcile-submission', f.id, '--rejection-receipt', f.receiptFile]);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.state, 'not_sent');
  assert.equal(proof.source, 'herdr-pre-input-rejection');
  assert.equal(proof.taskId, f.id);
  assert.equal(proof.round, f.task.round);
  assert.equal(proof.nativeWorkState, 'not_checked');
  assert.deepEqual(fs.readFileSync(f.taskFile), before);
  assert.equal(fs.existsSync(herdrCallLog), false);
});

test('real abandon CLI consumes only the proof, preserves submission/history/native identity and fences the whole project', () => {
  const f = fixture();
  fs.rmSync(herdrCallLog, { force: true });
  const before = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'));
  const result = runCli(f, ['abandon', f.id, '--rejection-receipt', f.receiptFile,
    '--reason', 'Original bridge attempt rejected before input', '--actor', 'fixture-operator']);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(f.taskFile, 'utf8'));
  assert.equal(saved.status, 'abandoned');
  assert.notEqual(saved.status, 'cancelled');
  assert.deepEqual(saved.submission, before.submission);
  assert.deepEqual(saved.history.slice(0, before.history.length), before.history);
  assert.equal(saved.workerSessionId, before.workerSessionId);
  assert.equal(saved.herdrSession, before.herdrSession);
  assert.equal(saved.paneId, before.paneId);
  assert.equal(saved.terminalId, before.terminalId);
  assert.equal(saved.submissionReconciliation.state, 'not_sent');
  assert.equal(saved.submissionReconciliation.nativeWorkState, 'not_checked');
  assert.equal(saved.abandonment.proof.state, 'not_sent');
  assert.equal(saved.abandonment.proof.nativeWorkState, 'not_checked');
  assert.equal(saved.abandonment.resourceFence.active, true);
  assert.equal(saved.abandonment.resourceFence.wholeProject, true);
  const { assertSingleActive } = require('../lib/worker-scheduling');
  const next = { ...before, id: 'independent-next', status: 'created', workerKey: 'other',
    paneId: 'new-pane', terminalId: 'new-terminal', workerSessionId: 'new-native', allowedWritePaths: ['unrelated-file'] };
  assert.throws(() => assertSingleActive(next, [saved]), /resource conflict/);
  assert.doesNotThrow(() => assertSingleActive({ ...next, cwd: path.join(root, 'separate-project') }, [saved]));
  assert.equal(fs.existsSync(herdrCallLog), false);
});

test('real CLI leaves task bytes unchanged when the rejection receipt is invalid', () => {
  const f = fixture();
  writeReceipt(f, receipt => { receipt.command = `echo dispatch --task-id ${f.id}`; });
  fs.rmSync(herdrCallLog, { force: true });
  const before = fs.readFileSync(f.taskFile);

  const reconcile = runCli(f, ['reconcile-submission', f.id, '--rejection-receipt', f.receiptFile]);
  assert.equal(reconcile.error, undefined);
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.equal(JSON.parse(reconcile.stdout).state, 'unresolved');
  assert.deepEqual(fs.readFileSync(f.taskFile), before);

  const abandon = runCli(f, ['abandon', f.id, '--rejection-receipt', f.receiptFile,
    '--reason', 'Invalid receipt must not settle the task', '--actor', 'fixture-operator']);
  assert.equal(abandon.error, undefined);
  assert.equal(abandon.status, 1);
  assert.match(JSON.parse(abandon.stderr).error, /not proved/);
  assert.deepEqual(fs.readFileSync(f.taskFile), before);
  assert.equal(fs.existsSync(herdrCallLog), false);
});
