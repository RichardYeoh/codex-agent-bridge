'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, homePath } = require('./util');
const { leasePath } = require('./worker-lease');
const { renderSubmissionPointer } = require('./worker-policy');

const TURN_PHASES = new Set(['sending', 'observed', 'uncertain']);
const ATTEMPT_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{2,47}$/;
const NATIVE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function time(value) {
  return typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
}

function refuse(state, reason) {
  const error = new Error(reason);
  error.turnState = state;
  throw error;
}

function requireProof(condition, reason, state = 'invalid') {
  if (!condition) refuse(state, reason);
}

function parseJsonLines(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const completeEnd = text.lastIndexOf('\n') + 1;
  const complete = text.slice(0, completeEnd);
  const entries = [];
  for (const line of complete.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        refuse('invalid', 'CBC Hook journal contains a malformed complete JSONL record');
      }
      entries.push(entry);
    } catch {
      refuse('invalid', 'CBC Hook journal contains a malformed complete JSONL record');
    }
  }
  return entries;
}

function readHookEvents(file, injectedReader) {
  if (injectedReader) {
    let value;
    try { value = injectedReader(file); }
    catch { refuse('unconfirmed', 'CBC Hook journal is unavailable'); }
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' || Buffer.isBuffer(value)) return parseJsonLines(value);
    refuse('invalid', 'test Hook event reader returned an unsupported value');
  }

  try { return require('./cbc-evidence-cache').readJsonlSnapshot(file); }
  catch (error) {
    refuse(error.code === 'CBC_EVIDENCE_READ' ? 'unconfirmed' : 'invalid',
      error.code === 'CBC_EVIDENCE_TOO_LARGE' ? 'CBC evidence exceeds the 64 MiB bound'
        : error.code === 'CBC_EVIDENCE_INVALID_LINE' ? 'CBC evidence contains a malformed complete JSONL record' : error.message);
  }
}

function captureSubmission(event, task) {
  if (!event || (event.hook_event_name || event.event) !== 'UserPromptSubmit'
      || typeof event.prompt !== 'string') return { promptSha256: null };

  const promptSha256 = sha256(Buffer.from(event.prompt, 'utf8'));
  const promptSha256Origin = 'hook-prompt';
  const phase = task?.submission?.phase ?? task?.submission?.status;
  const attemptId = task?.submission?.attemptId;
  if (!task || task.cbcTurnProtocol !== 1 || !TURN_PHASES.has(phase) || typeof attemptId !== 'string'
      || !ATTEMPT_ID_PATTERN.test(attemptId)) return { promptSha256, promptSha256Origin };

  try {
    if (event.prompt === renderSubmissionPointer(task)) {
      return { promptSha256, promptSha256Origin, submissionAttemptId: attemptId };
    }
  } catch {
    // Invalid or legacy task metadata may be hashed, but cannot claim an attempt. / 旧任务元数据无效时仅记录哈希，不得认领提交尝试。
  }
  return { promptSha256, promptSha256Origin };
}

function validateLocalBinding(task) {
  requireProof(task && task.agent === 'cbc' && task.cbcTurnProtocol === 1,
    'task is not enrolled in CBC native-turn protocol');
  requireProof(typeof task.id === 'string' && TASK_ID_PATTERN.test(task.id), 'task ID is invalid');
  requireProof(typeof task.stateDir === 'string' && path.isAbsolute(task.stateDir), 'task state directory is invalid');
  requireProof(Number.isSafeInteger(task.round) && task.round > 0, 'task round is invalid');
  requireProof(typeof task.herdrSession === 'string' && task.herdrSession
    && typeof task.paneId === 'string' && task.paneId
    && typeof task.terminalId === 'string' && task.terminalId
    && typeof task.workerSessionId === 'string' && NATIVE_ID_PATTERN.test(task.workerSessionId),
  'task native identity is incomplete');
  requireProof(Number.isFinite(time(task.workerStartedAt)), 'task worker start time is invalid');

  const phase = task.submission?.phase ?? task.submission?.status;
  requireProof(TURN_PHASES.has(phase), 'task submission phase is outside native-turn proof');
  const attemptId = task.submission?.attemptId;
  if (typeof attemptId !== 'string' || !attemptId) {
    refuse('unconfirmed', 'submission attempt is missing; use explicit native transcript reconciliation');
  }
  requireProof(ATTEMPT_ID_PATTERN.test(attemptId), 'submission attempt ID is invalid');

  const root = path.join(path.resolve(task.stateDir), 'tasks', task.id);
  const taskFile = path.join(root, 'task.json');
  const round = String(task.round).padStart(3, '0');
  const promptFile = path.join(root, `round-${round}-prompt.md`);
  const attemptFile = path.join(root, `round-${round}-submission-${attemptId}.json`);
  requireProof(typeof task.promptPath === 'string' && samePath(task.promptPath, promptFile), 'task prompt path is not round-bound');
  requireProof(typeof task.submission.file === 'string' && samePath(task.submission.file, attemptFile), 'submission journal path is not attempt-bound');

  let saved;
  try { saved = readJson(taskFile); }
  catch { refuse('invalid', 'persisted task journal is unavailable or malformed'); }
  const taskIdentity = ['id', 'agent', 'round', 'cbcTurnProtocol', 'herdrSession', 'paneId', 'terminalId',
    'workerSessionId', 'promptPath'];
  requireProof(taskIdentity.every(key => saved?.[key] === task[key])
    && typeof saved.stateDir === 'string' && samePath(saved.stateDir, task.stateDir)
    && saved.submission?.attemptId === attemptId
    && typeof saved.submission.file === 'string' && samePath(saved.submission.file, attemptFile),
  'persisted task identity or submission pointer changed');
  requireProof(TURN_PHASES.has(saved.submission?.phase ?? saved.submission?.status), 'persisted submission phase is invalid');

  let attempt;
  try { attempt = readJson(attemptFile); }
  catch (error) {
    if (error.code === 'ENOENT') refuse('unconfirmed', 'original submission journal is missing; use explicit native transcript reconciliation');
    refuse('invalid', 'original submission journal is malformed');
  }
  requireProof(attempt?.protocol === 1 && attempt.agent === 'cbc' && attempt.status
    && TURN_PHASES.has(attempt.status) && attempt.attemptId === attemptId && attempt.taskId === task.id
    && attempt.round === task.round && attempt.herdrSession === task.herdrSession
    && attempt.paneId === task.paneId && attempt.terminalId === task.terminalId
    && attempt.workerSessionId === task.workerSessionId,
  'original submission journal identity mismatch');
  requireProof(typeof attempt.promptSha256 === 'string' && /^[a-f0-9]{64}$/.test(attempt.promptSha256),
    'original submission journal has no prompt hash; use explicit native transcript reconciliation', 'unconfirmed');
  const createdAt = time(attempt.createdAt);
  requireProof(Number.isFinite(createdAt) && createdAt >= time(task.workerStartedAt), 'submission attempt time is invalid');

  const attemptFiles = fs.readdirSync(root).filter(name => name.startsWith(`round-${round}-submission-`) && name.endsWith('.json'));
  const activeAttempts = [];
  for (const name of attemptFiles) {
    let record;
    try { record = readJson(path.join(root, name)); }
    catch { refuse('invalid', 'round contains a malformed submission journal'); }
    if (record.status !== 'rejected-before-input') activeAttempts.push(name);
  }
  requireProof(activeAttempts.length === 1 && activeAttempts[0] === path.basename(attemptFile),
    'round has repeated or ambiguous submission attempts');
  let promptBytes;
  try { promptBytes = fs.readFileSync(promptFile); }
  catch { refuse('invalid', 'current round prompt is unavailable'); }
  requireProof(sha256(promptBytes) === attempt.promptSha256, 'current prompt bytes differ from original submission journal');

  const leaseFile = leasePath(task.stateDir, task.herdrSession, task.paneId);
  let lease;
  try { lease = readJson(leaseFile); }
  catch { refuse('invalid', 'current Pane lease is unavailable or malformed'); }
  requireProof(lease.taskId === task.id && lease.herdrSession === task.herdrSession
    && lease.paneId === task.paneId && lease.terminalId === task.terminalId
    && lease.workerSessionId === task.workerSessionId && lease.workerStartedAt === task.workerStartedAt,
  'current Pane lease does not match task/native identity');

  let pointer;
  try { pointer = renderSubmissionPointer(task); }
  catch { refuse('invalid', 'current task cannot render its native submission pointer'); }
  return { attemptId, attemptFile, attempt, createdAt, pointerSha256: sha256(Buffer.from(pointer, 'utf8')) };
}

function exactBoundIdentity(event, task) {
  return event?.identityBound === true && event.taskId === task.id && event.round === task.round
    && event.sessionId === task.workerSessionId && event.herdrSession === task.herdrSession
    && event.paneId === task.paneId && event.terminalId === task.terminalId;
}

function iso(value) {
  return new Date(value).toISOString();
}

// Validate a native history pointer, never search other sessions or accept arbitrary files. / 校验原生历史指针，不搜索其他会话或读取任意文件。
function nativeTranscriptPath(file, task, root = homePath('.codebuddy', 'projects')) {
  if (typeof file !== 'string' || !path.isAbsolute(file)
      || path.basename(file) !== `${task?.workerSessionId}.jsonl`) return null;
  try {
    const actualRoot = fs.realpathSync(root), actual = fs.realpathSync(file);
    const relative = path.relative(actualRoot, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return null;
    return actual;
  } catch { return null; }
}

function transcriptForTurn(task, proof, terminalEvents, supplied, root) {
  const paths = terminalEvents.filter(x => x.event.name === 'UserPromptSubmit' && exactBoundIdentity(x.event, task))
    .map(x => x.event.nativeTranscript).filter(Boolean);
  if (supplied) paths.push(supplied);
  if (!paths.length && task.submission.reconciliationFile) {
    const expected = path.join(task.stateDir, 'tasks', task.id,
      `round-${String(task.round).padStart(3, '0')}-cbc-reconciliation-${proof.attemptId}.json`);
    requireProof(samePath(task.submission.reconciliationFile, expected), 'native reconciliation receipt path mismatch');
    const receipt = readJson(expected);
    requireProof(receipt.taskId === task.id && receipt.round === task.round && receipt.attemptId === proof.attemptId,
      'native reconciliation receipt identity mismatch');
    if (receipt.nativeTranscript) paths.push(receipt.nativeTranscript);
  }
  if (!paths.length) return null;
  const resolved = paths.map(file => nativeTranscriptPath(file, task, root));
  requireProof(resolved.every(Boolean) && resolved.every(file => samePath(file, resolved[0])),
    'native transcript path is unavailable, outside its store, or conflicting');
  const users = readHookEvents(resolved[0]).filter(record => record.type === 'message' && record.role === 'user'
    && time(record.timestamp) >= proof.createdAt);
  if (!users.length) refuse('unconfirmed', 'native transcript has not persisted this submission yet');
  const first = users[0];
  requireProof(first.sessionId === task.workerSessionId && typeof first.cwd === 'string' && samePath(first.cwd, task.cwd)
    && Array.isArray(first.content) && first.content.length === 1 && first.content[0].type === 'input_text'
    && typeof first.content[0].text === 'string' && sha256(first.content[0].text) === proof.pointerSha256,
  'first native user message after attempt is not the exact submitted pointer');
  requireProof(users.every(record => record.sessionId === task.workerSessionId
    && typeof record.cwd === 'string' && samePath(record.cwd, task.cwd)), 'native transcript identity changed');
  return { file: resolved[0], submittedAt: time(first.timestamp), laterInputAt: users[1] ? time(users[1].timestamp) : null };
}

function readTurn(task, { readEvents, nativeTranscript, nativeTranscriptRoot } = {}) {
  const attemptId = typeof task?.submission?.attemptId === 'string' ? task.submission.attemptId : null;
  try {
    const proof = validateLocalBinding(task);
    const eventsFile = path.join(task.stateDir, 'hook-events.ndjson');
    const events = readHookEvents(eventsFile, readEvents);
    requireProof(Array.isArray(events) && events.every(event => event && typeof event === 'object' && !Array.isArray(event)),
      'CBC Hook journal contains a malformed event record');
    const terminalEvents = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || event.herdrSession !== task.herdrSession || event.paneId !== task.paneId
          || event.terminalId !== task.terminalId) continue;
      const timestamp = time(event.timestamp);
      requireProof(Number.isFinite(timestamp), 'current terminal Hook event has an invalid timestamp');
      if (timestamp < proof.createdAt) continue;
      requireProof(event.sessionId === task.workerSessionId, 'current terminal changed native session during submission');
      terminalEvents.push({ event, timestamp, index });
    }

    const native = transcriptForTurn(task, proof, terminalEvents, nativeTranscript, nativeTranscriptRoot);
    const tagged = terminalEvents.filter(({ event }) => event.name === 'UserPromptSubmit'
      && event.submissionAttemptId === proof.attemptId);
    requireProof(tagged.length <= 1, 'submission attempt appears on repeated native UserPromptSubmit events');
    if (tagged.length === 1) {
      requireProof(tagged[0].event.promptSha256 === proof.pointerSha256,
        'attempt-tagged native prompt hash differs from the rendered pointer');
    }
    let submitted = tagged[0];
    if (native) {
      // Hook prompt may aggregate metadata; native persisted text is compared exactly, without normalization. / Hook文本可能合并元数据；原生落盘文本逐字比较，不做归一化。
      const inputs = terminalEvents.filter(({ event }) => event.name === 'UserPromptSubmit');
      requireProof(inputs.length > 0 && inputs[0].timestamp >= native.submittedAt,
        'native user record has no corresponding ordered submission Hook', 'unconfirmed');
      requireProof(!submitted || submitted.index === inputs[0].index, 'native and tagged submission boundaries conflict');
      submitted = inputs[0];
    }
    if (!submitted) {
      const userEvents = terminalEvents.filter(({ event }) => event.name === 'UserPromptSubmit');
      if (userEvents.some(({ event }) => typeof event.promptSha256 !== 'string')) {
        refuse('unconfirmed', 'native Hook event predates prompt hashing; use explicit native transcript reconciliation');
      }
      refuse('unconfirmed', 'no native UserPromptSubmit uniquely matches the recorded attempt and pointer hash');
    }

    requireProof(submitted.timestamp >= proof.createdAt, 'native submission predates its recorded attempt');
    requireProof(exactBoundIdentity(submitted.event, task), 'matching native submission is not bound to the current task identity');
    const laterEvents = terminalEvents.filter(item => item.index > submitted.index);
    let laterInput = null;
    let lastStop = null;
    let latestTurnEvent = submitted;
    for (const item of laterEvents) {
      requireProof(item.timestamp >= submitted.timestamp, 'Hook event order conflicts with native submission timestamps');
      const event = item.event;
      if (event.name === 'UserPromptSubmit') {
        laterInput = item;
        break;
      }
      requireProof(exactBoundIdentity(event, task), 'post-submission Hook event conflicts with task/round/native identity');
      latestTurnEvent = item;
      if (event.name === 'Stop' && item.timestamp >= proof.createdAt) lastStop = item;
    }

    const submittedAt = iso(submitted.timestamp);
    const stopAt = lastStop ? iso(lastStop.timestamp) : null;
    const laterInputAt = laterInput ? iso(laterInput.timestamp) : null;
    if (laterInput || native?.laterInputAt) return {
      state: 'superseded', reason: lastStop
        ? 'a later native user submission followed a Stop; automatic settlement or retry is unsafe'
        : 'a later native user submission superseded the observed turn before Stop',
      attemptId: proof.attemptId, submittedAt, stopAt, laterInputAt: laterInputAt || iso(native.laterInputAt),
    };
    if (latestTurnEvent.event.name === 'Notification') {
      requireProof(latestTurnEvent.event.notificationType === 'permission_prompt',
        'native Notification does not identify a permission prompt');
      return {
      state: 'blocked', reason: 'current native turn is blocked on a permission prompt',
      attemptId: proof.attemptId, submittedAt, stopAt: null, laterInputAt: null,
      };
    }
    if (latestTurnEvent.event.name === 'Stop') {
      return { state: 'stopped', attemptId: proof.attemptId, submittedAt, stopAt, laterInputAt: null };
    }
    if (['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(latestTurnEvent.event.name)) {
      return { state: 'active', attemptId: proof.attemptId, submittedAt, stopAt: null, laterInputAt: null };
    }
    return {
      state: 'unconfirmed', reason: 'latest native Hook event cannot establish active or stopped turn state',
      attemptId: proof.attemptId, submittedAt, stopAt: null, laterInputAt: null,
    };
  } catch (error) {
    return { state: error.turnState || 'invalid', reason: error.message,
      attemptId, submittedAt: null, stopAt: null, laterInputAt: null };
  }
}

module.exports = { captureSubmission, readTurn, nativeTranscriptPath };
