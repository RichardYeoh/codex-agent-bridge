'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { config, now, taskDir, writeJsonAtomic, readJson } = require('./util');

// Native CLI owns service discovery and authentication; never extract its token. / 原生CLI负责服务发现和鉴权，禁止提取令牌。
function call(operation, params = {}, body, cwd) {
  const binary = config().opencode;
  const args = ['api', operation];
  for (const [key, value] of Object.entries(params)) args.push('--param', `${key}=${value}`);
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  const result = spawnSync(binary.endsWith('.cjs') ? process.execPath : binary,
    binary.endsWith('.cjs') ? [binary, ...args] : args,
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  // Errors may contain provider payloads; expose only the operation and safe category. / 错误可能包含Provider报文，仅公开操作名和安全类别。
  if (result.error || result.status !== 0) {
    const error = new Error(`OpenCode ${operation} unavailable (${result.error?.code || 'API_ERROR'}); inspect native CLI`);
    error.code = 'OPENCODE_API_UNAVAILABLE'; error.operation = operation;
    throw error;
  }
  if (!result.stdout.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch {
    const error = new Error(`OpenCode ${operation} returned invalid JSON; inspect native CLI`);
    error.code = 'OPENCODE_API_MALFORMED'; error.operation = operation;
    throw error;
  }
  return Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
}

function sameDirectory(left, right) {
  return typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function modelRef(task, current) {
  if (!task.model && !task.effort) return null;
  let ref = current;
  if (task.model) {
    const [name, variant] = task.model.split('#');
    const slash = name.indexOf('/');
    if (slash < 1 || slash === name.length - 1) throw new Error('OpenCode --model requires provider/model[#variant]');
    ref = { providerID: name.slice(0, slash), id: name.slice(slash + 1), ...(variant ? { variant } : {}) };
  }
  if (!ref) throw new Error('OpenCode effort requires a selected model');
  return { ...ref, ...(task.effort ? { variant: task.effort } : {}) };
}

function verifySession(task, info) {
  if (!info?.id || (task.workerSessionId && task.workerSessionId !== info.id)
      || !sameDirectory(info.location?.directory, task.cwd)) throw new Error('OpenCode native session or directory mismatch');
}

function nativeState(task, request) {
  if (!task.workerSessionId) throw new Error('OpenCode native state requires the saved session ID');
  const params = { sessionID: task.workerSessionId };
  const info = request('session.get', params, undefined, task.cwd);
  verifySession(task, info);
  const active = request('session.active', {}, undefined, task.cwd);
  const permissions = request('session.permission.list', params, undefined, task.cwd);
  const forms = request('session.form.list', params, undefined, task.cwd);
  if (!active || typeof active !== 'object' || Array.isArray(active) || !Array.isArray(permissions) || !Array.isArray(forms)) {
    const error = new Error('OpenCode native execution state is unavailable or malformed');
    error.code = 'OPENCODE_API_MALFORMED'; error.operation = 'native-state'; throw error;
  }
  return { info, active: Boolean(active[info.id]), needsInput: permissions.length > 0 || forms.length > 0,
    permissions, forms };
}

const MAX_FAILED_ROUND_RETRIES = 2;

function admissionFiles(task, round = task.round) {
  const dir = taskDir(task.id);
  if (!fs.existsSync(dir)) return [];
  const baseName = `round-${String(round).padStart(3, '0')}-opencode-admission.json`;
  const retryPrefix = `round-${String(round).padStart(3, '0')}-opencode-retry-`;
  const files = fs.readdirSync(dir).filter(name => name === baseName
    || (name.startsWith(retryPrefix) && /^round-\d+-opencode-retry-\d+\.json$/.test(name)));
  return files.map(name => {
    const retry = name.match(/^round-\d+-opencode-retry-(\d+)\.json$/);
    const record = readJson(path.join(dir, name), null);
    if (!record || typeof record.id !== 'string' || !record.id.startsWith('msg_bridge')) {
      throw new Error('OpenCode admission journal is missing a valid stable ID');
    }
    if ((record.sessionId && record.sessionId !== task.workerSessionId)
        || (record.round != null && record.round !== round)) {
      throw new Error('OpenCode admission journal binding mismatch');
    }
    return { ...record, round, attemptNumber: retry ? Number(retry[1]) : 0,
      file: path.join(dir, name), source: retry ? 'retry' : 'initial' };
  }).sort((a, b) => a.attemptNumber - b.attemptNumber);
}

function currentAdmission(task, { includePrepared = false } = {}) {
  const records = admissionFiles(task);
  if (!records.length) throw new Error('OpenCode current round has no persisted admission ID');
  const retries = records.filter(record => record.attemptNumber > 0);
  const candidates = includePrepared ? records : records.filter(record => record.status !== 'prepared');
  const latest = candidates.at(-1) || records[0];
  if (retries.some((record, index) => record.attemptNumber !== index + 1)) {
    throw new Error('OpenCode retry admission journal sequence is incomplete');
  }
  return latest;
}

function asArray(value, operation) {
  const result = Array.isArray(value) ? value : value?.data;
  if (!Array.isArray(result)) {
    const error = new Error(`OpenCode ${operation} returned malformed data`);
    error.code = 'OPENCODE_API_MALFORMED'; error.operation = operation;
    throw error;
  }
  return result;
}

function nativeTurnEvidence(task, request = call) {
  const native = nativeState(task, request);
  const params = { sessionID: task.workerSessionId };
  const inbox = asArray(request('session.inbox.list', params, undefined, task.cwd), 'session.inbox.list');
  const messages = asArray(request('session.message.list', { ...params, order: 'desc', limit: '100' }, undefined, task.cwd), 'session.message.list');
  const admission = currentAdmission(task);
  if (admission.status === 'prepared' || !task.history?.some(item => item.round === task.round && item.status === 'submitted')) {
    throw new Error('OpenCode current round has no confirmed submitted admission history');
  }
  const ownMessageIndex = messages.findIndex(message => message?.id === admission.id && message.type === 'user');
  const latestUser = messages.find(message => message?.type === 'user');
  const hasLaterExternalMessage = ownMessageIndex >= 0 && messages.slice(0, ownMessageIndex)
    .some(message => ['user', 'shell', 'synthetic', 'agent-switched', 'model-switched', 'location-switched'].includes(message?.type));
  const pending = inbox.map(item => {
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || item.sessionID !== task.workerSessionId) {
      const error = new Error('OpenCode session inbox returned malformed or mismatched input');
      error.code = 'OPENCODE_API_MALFORMED'; error.operation = 'session.inbox.list';
      throw error;
    }
    return { id: item.id, type: item.type };
  });
  return { ...native, admission, inbox: pending, messages,
    latestUserMessageId: latestUser?.id || null,
    ownMessagePresent: ownMessageIndex >= 0,
    hasLaterExternalMessage };
}

function assertNoPendingInput(evidence) {
  const permissionIds = evidence.permissions.map(item => item?.id || item?.requestID).filter(Boolean);
  const formIds = evidence.forms.map(item => item?.id || item?.formID).filter(Boolean);
  if (permissionIds.length || formIds.length) {
    const pending = [...permissionIds.map(id => `permission:${id}`), ...formIds.map(id => `form:${id}`)].join(', ');
    throw new Error(`OpenCode session requires explicit user input (${pending}); no approval or form was answered`);
  }
  if (evidence.inbox.length) {
    throw new Error(`OpenCode session has queued native input (${evidence.inbox.map(item => `${item.type}:${item.id}`).join(', ')}); no external input was cancelled`);
  }
}

function turnFingerprintFromEvidence(task, evidence) {
  if (!evidence.active) throw new Error('OpenCode native turn is not active');
  assertNoPendingInput(evidence);
  if (!evidence.ownMessagePresent || evidence.latestUserMessageId !== evidence.admission.id || evidence.hasLaterExternalMessage) {
    throw new Error('OpenCode active turn does not match the current bridge admission');
  }
  const stable = { taskId: task.id, round: task.round, sessionId: evidence.info.id,
    directory: path.resolve(evidence.info.location.directory).toLowerCase(), admissionId: evidence.admission.id };
  return `oc-turn-v1-${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

function turnFingerprint(task, { request = call } = {}) {
  return turnFingerprintFromEvidence(task, nativeTurnEvidence(task, request));
}

function assertNoOtherSessionOwner(task) {
  const other = require('./worker-scheduling').taskList(task.stateDir).find(item => item.id !== task.id
    && item.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(item.status));
  if (other) throw new Error('OpenCode native session has another unresolved task owner');
}

function authorizePaneLessInterrupt(task, { request = call } = {}) {
  if (!task.workerSessionId || !task.herdrSession || !task.paneId || !task.terminalId) {
    throw new Error('OpenCode pane-less interrupt requires the saved session and Pane binding');
  }
  if (!['running', 'blocked', 'submission_unknown', 'cancel_pending'].includes(task.status)) {
    throw new Error('OpenCode pane-less interrupt requires an unresolved active task');
  }
  const lease = require('./worker-lease').leaseForEvent(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (!lease || lease.taskId !== task.id || lease.terminalId !== task.terminalId
      || (lease.workerStartedAt && task.workerStartedAt && lease.workerStartedAt !== task.workerStartedAt)) {
    throw new Error('OpenCode pane-less interrupt Pane lease mismatch');
  }
  assertNoOtherSessionOwner(task);
  const first = nativeTurnEvidence(task, request);
  const firstFingerprint = turnFingerprintFromEvidence(task, first);
  const second = nativeTurnEvidence(task, request);
  const secondFingerprint = turnFingerprintFromEvidence(task, second);
  if (firstFingerprint !== secondFingerprint) throw new Error('OpenCode native turn changed during pane-less authorization');
  return { turnFingerprint: secondFingerprint, admissionId: second.admission.id,
    binding: { taskId: task.id, round: task.round, sessionId: task.workerSessionId, cwd: task.cwd,
      herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId },
    evidence: { active: second.active, pendingInbox: second.inbox.length,
      latestUserMessageId: second.latestUserMessageId, approvals: 0, forms: 0 } };
}

function reconcileSubmission(task, { request = call } = {}) {
  const admission = currentAdmission(task, { includePrepared: true });
  const params = { sessionID: task.workerSessionId };
  const inbox = asArray(request('session.inbox.list', params, undefined, task.cwd), 'session.inbox.list');
  for (const item of inbox) {
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || item.sessionID !== task.workerSessionId) {
      const error = new Error('OpenCode session inbox returned malformed or mismatched input');
      error.code = 'OPENCODE_API_MALFORMED'; error.operation = 'session.inbox.list'; throw error;
    }
  }
  const pending = inbox.find(item => item?.id === admission.id && item.sessionID === task.workerSessionId);
  const native = nativeState(task, request);
  const binding = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
    cwd: path.resolve(task.cwd).toLowerCase() };
  const reconciled = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
    admissionId: admission.id, attemptNumber: admission.attemptNumber, binding,
    active: native.active, needsInput: native.needsInput, info: native.info };
  if (pending) return { ...reconciled, state: 'admitted', via: 'inbox',
    admissionId: admission.id,
    active: native.active, needsInput: native.needsInput, info: native.info, inbox: pending };
  try {
    const message = request('session.message.get', { ...params, messageID: admission.id }, undefined, task.cwd);
    const info = message?.info || message;
    if (info?.id === admission.id && info.type === 'user') return { ...reconciled, state: 'admitted', via: 'message', message: info };
  } catch { /* A missing or unreadable message cannot prove that an uncertain admission was never accepted. / 消息不存在或不可读不能证明不确定准入从未被接受。 */ }
  if (admission.status === 'prepared') return { ...reconciled, state: 'not_sent', noRequestStarted: true,
    admissionId: admission.id, active: native.active, needsInput: native.needsInput, info: native.info, inbox: null };
  return { ...reconciled, state: 'unresolved', noRequestStarted: false, admissionId: admission.id,
    active: native.active, needsInput: native.needsInput, info: native.info, inbox: null };
}

function confirmReconciledSubmission(task, evidence) {
  if (!evidence || evidence.state !== 'admitted') {
    throw new Error('OpenCode admission confirmation requires admitted reconciliation evidence');
  }
  const expectedBinding = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
    cwd: path.resolve(task.cwd).toLowerCase() };
  if (evidence.taskId !== task.id || evidence.round !== task.round
      || evidence.sessionId !== task.workerSessionId || !task.workerSessionId
      || !evidence.binding || Object.entries(expectedBinding).some(([key, value]) => evidence.binding[key] !== value)) {
    throw new Error('OpenCode admission reconciliation binding does not match the saved task');
  }
  verifySession(task, evidence.info);

  const admission = currentAdmission(task, { includePrepared: true });
  if (evidence.admissionId !== admission.id || evidence.attemptNumber !== admission.attemptNumber) {
    throw new Error('OpenCode admission reconciliation ID or attempt does not match the persisted journal');
  }
  if (evidence.via === 'inbox') {
    if (evidence.inbox?.id !== admission.id || evidence.inbox?.type !== 'user'
        || evidence.inbox?.sessionID !== task.workerSessionId) {
      throw new Error('OpenCode admitted Inbox evidence does not match the current user admission');
    }
  } else if (evidence.via === 'message') {
    if (evidence.message?.id !== admission.id || evidence.message?.type !== 'user') {
      throw new Error('OpenCode admitted message evidence does not match the current user admission');
    }
  } else {
    throw new Error('OpenCode admission evidence has an unknown native confirmation source');
  }

  const record = readJson(admission.file, null);
  if (!record || record.id !== admission.id || record.sessionId !== task.workerSessionId
      || (record.round != null && record.round !== task.round)) {
    throw new Error('OpenCode admission journal changed before reconciliation confirmation');
  }
  if (!['prepared', 'sending', 'confirmed'].includes(record.status)) {
    throw new Error('OpenCode admission journal is not eligible for native reconciliation confirmation');
  }
  if (record.status !== 'confirmed') {
    record.status = 'confirmed';
    record.reconciledAt = now();
    record.reconciledVia = evidence.via;
    record.timestamp = record.reconciledAt;
    writeJsonAtomic(admission.file, record);
  }
  return { state: 'confirmed', taskId: task.id, round: task.round,
    sessionId: task.workerSessionId, admissionId: admission.id,
    attemptNumber: admission.attemptNumber, status: record.status,
    file: admission.file, reconciledVia: evidence.via };
}

function confirmCompletion(task, { request = call } = {}) {
  const observe = () => {
    const evidence = nativeTurnEvidence(task, request);
    assertNoPendingInput(evidence);
    if (evidence.active || !evidence.ownMessagePresent || evidence.latestUserMessageId !== evidence.admission.id
        || evidence.hasLaterExternalMessage || !['success', 'completed'].includes(evidence.info.outcome)) {
      throw new Error('OpenCode current admission has no successful native terminal');
    }
    const startedAt = Number.isFinite(evidence.admission.requestStartedAt) ? evidence.admission.requestStartedAt
      : Date.parse(evidence.admission.requestStartedAt || evidence.admission.timestamp || '');
    const idleAt = evidence.info.time?.idle;
    if (!Number.isFinite(startedAt) || !Number.isFinite(idleAt) || idleAt <= startedAt
        || task.opencodeSubmissionBaseline && idleAt <= task.opencodeSubmissionBaseline.idleAt) {
      throw new Error('OpenCode native terminal predates the current admission');
    }
    return { admissionId: evidence.admission.id, idleAt, sessionId: task.workerSessionId, round: task.round };
  };
  const first = observe(), second = observe();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('OpenCode native completion changed during reconciliation');
  return { confirmed: true, ...second };
}

function failedRetryFingerprint(task, request = call) {
  if (!task.opencodeSubmissionBaseline || task.round < 1 || !['blocked', 'failed'].includes(task.status)) {
    throw new Error('OpenCode failed-round retry requires a blocked submitted round and its baseline');
  }
  const evidence = nativeTurnEvidence(task, request);
  if (evidence.active || evidence.needsInput || evidence.inbox.length) {
    throw new Error('OpenCode failed-round retry requires native idle with no approvals, forms or queued input');
  }
  if (evidence.info.outcome !== 'failed' || !Number.isFinite(evidence.info.time?.idle)
      || !Number.isFinite(task.opencodeSubmissionBaseline.idleAt)
      || evidence.info.time.idle <= task.opencodeSubmissionBaseline.idleAt) {
    throw new Error('OpenCode failed-round retry requires a new native failed terminal after the round baseline');
  }
  const baseline = task.opencodeSubmissionBaseline;
  const expected = { taskId: task.id, round: task.round, sessionId: task.workerSessionId, cwd: task.cwd,
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId };
  if (!baselineMatches(task, baseline, expected)) {
    throw new Error('OpenCode failed-round retry baseline binding mismatch');
  }
  if (!evidence.ownMessagePresent || evidence.latestUserMessageId !== evidence.admission.id || evidence.hasLaterExternalMessage) {
    throw new Error('OpenCode failed round is no longer the latest bridge-owned input');
  }
  const admittedAt = Number.isFinite(evidence.admission.requestStartedAt) ? evidence.admission.requestStartedAt
    : Date.parse(evidence.admission.requestStartedAt || evidence.admission.timestamp || '');
  if (!Number.isFinite(admittedAt) || evidence.info.time.idle <= admittedAt) {
    throw new Error('OpenCode failure terminal predates or lacks the current admission timestamp');
  }
  assertNoOtherSessionOwner(task);
  const stable = { taskId: task.id, round: task.round, sessionId: evidence.info.id,
    directory: path.resolve(evidence.info.location.directory).toLowerCase(), admissionId: evidence.admission.id,
    outcome: evidence.info.outcome, idleAt: evidence.info.time.idle };
  return `oc-failed-v1-${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

function retryFile(task, attemptNumber) {
  return path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-opencode-retry-${String(attemptNumber).padStart(3, '0')}.json`);
}

function retryAdmissionId(task, attemptNumber) {
  return 'msg_bridge' + crypto.createHash('sha256')
    .update(`${task.stateDir}\n${task.id}\n${task.round}\nfailed-retry:${attemptNumber}`).digest('hex').slice(0, 32);
}

function authorizeFailedRoundRetry(task, { attemptNumber, expectedFingerprint, request = call } = {}) {
  const fingerprint = failedRetryFingerprint(task, request);
  const existing = admissionFiles(task).filter(record => record.attemptNumber > 0);
  if (existing.some(record => record.status === 'prepared')) {
    throw new Error('OpenCode retry attempt is already prepared; submit or reconcile its persisted ID first');
  }
  const nextAttemptNumber = existing.length + 1;
  const selectedAttempt = attemptNumber ?? nextAttemptNumber;
  if (selectedAttempt !== nextAttemptNumber || selectedAttempt > MAX_FAILED_ROUND_RETRIES) {
    throw new Error(`OpenCode failed-round retry must use the next persisted attempt (maximum ${MAX_FAILED_ROUND_RETRIES})`);
  }
  if (expectedFingerprint && expectedFingerprint !== fingerprint) throw new Error('OpenCode failed round changed before retry authorization');
  return { turnFingerprint: fingerprint, attemptNumber: selectedAttempt,
    admissionId: retryAdmissionId(task, selectedAttempt), maxAttempts: MAX_FAILED_ROUND_RETRIES };
}

function prepareFailedRoundRetry(task, { attemptNumber, expectedFingerprint, request = call } = {}) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > MAX_FAILED_ROUND_RETRIES) {
    throw new Error(`OpenCode failed-round retry limit is ${MAX_FAILED_ROUND_RETRIES}`);
  }
  const fingerprint = failedRetryFingerprint(task, request);
  const file = retryFile(task, attemptNumber);
  if (fs.existsSync(file)) {
    const existing = readJson(file, null);
    if (existing?.status === 'prepared' && existing.id === retryAdmissionId(task, attemptNumber)
        && existing.turnFingerprint === fingerprint
        && (!expectedFingerprint || expectedFingerprint === fingerprint)) return { id: existing.id, attemptNumber, file, turnFingerprint: fingerprint };
    throw new Error('OpenCode retry attempt already exists; reconcile its persisted admission before retrying');
  }
  const authorized = authorizeFailedRoundRetry(task, { attemptNumber, expectedFingerprint, request });
  attemptNumber = authorized.attemptNumber;
  const previous = admissionFiles(task).filter(record => record.attemptNumber > 0);
  if (attemptNumber !== previous.length + 1) throw new Error('OpenCode retry attempt number is not the next persisted attempt');
  const record = { id: retryAdmissionId(task, attemptNumber), sessionId: task.workerSessionId,
    round: task.round, attemptNumber, status: 'prepared', turnFingerprint: fingerprint, preparedAt: now(), timestamp: now() };
  writeJsonAtomic(file, record);
  return { id: record.id, attemptNumber, file, turnFingerprint: fingerprint };
}

function submitFailedRoundRetry(task, text, { attemptNumber, expectedFingerprint, request = call, report = publish } = {}) {
  const fingerprint = failedRetryFingerprint(task, request);
  if (expectedFingerprint && expectedFingerprint !== fingerprint) throw new Error('OpenCode failed round changed before retry submission');
  const file = retryFile(task, attemptNumber);
  const record = readJson(file, null);
  if (!record || record.id !== retryAdmissionId(task, attemptNumber) || record.status !== 'prepared'
      || record.turnFingerprint !== fingerprint || record.sessionId !== task.workerSessionId) {
    throw new Error('OpenCode retry attempt is not safely prepared for this failed turn');
  }
  record.status = 'sending'; record.requestStartedAt = now(); record.timestamp = record.requestStartedAt;
  writeJsonAtomic(file, record);
  const admission = request('session.prompt', { sessionID: task.workerSessionId }, { id: record.id, text }, task.cwd);
  if (admission?.id !== record.id) throw new Error('OpenCode retry admission ID mismatch');
  record.status = 'confirmed'; record.timestamp = now(); writeJsonAtomic(file, record);
  report(task, { state: 'working', reason: 'failed_round_retry_admitted', admissionId: record.id, attemptNumber });
  return { id: record.id, attemptNumber, turnFingerprint: fingerprint };
}

function unsubmittedInitial(task) {
  if (task.round !== 0 || task.status === 'submission_unknown' || task.submission != null || task.opencodeSubmissionBaseline
      || task.history?.some(item => item.status === 'submitted')) return false;
  const dir = taskDir(task.id);
  return !fs.existsSync(dir) || !fs.readdirSync(dir).some(name => /^round-\d+-opencode-admission\.json$/.test(name));
}

function submissionBinding(task) {
  return { taskId: task.id, round: task.round, sessionId: task.workerSessionId, cwd: task.cwd,
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId };
}

function baselineMatches(task, baseline, expected = submissionBinding(task)) {
  const restored = task.restoredContextSessionId === task.workerSessionId
    && ['ready', 'adopted'].includes(task.workerLifecycle?.phase)
    && task.workerLifecycle?.previous?.workerSessionId === task.workerSessionId;
  return Object.entries(expected).every(([key, value]) => baseline[key] === value
    || restored && ['paneId', 'terminalId'].includes(key) && baseline[key] === task.workerLifecycle.previous[key]);
}

function unchangedPreviousFailure(task, info) {
  const baseline = task.opencodeSubmissionBaseline;
  return ['running', 'submission_unknown'].includes(task.status) && task.submission != null
    && baseline?.outcome === 'failed' && Number.isFinite(baseline.idleAt) && baseline.idleAt > 0
    && baseline.idleAt === info.time?.idle
    && baselineMatches(task, baseline)
    && task.history?.some(item => item.round === task.round && item.status === 'submitted');
}

function configure(task, request = call) {
  const params = { sessionID: task.workerSessionId };
  const { info, active, needsInput } = nativeState(task, request);
  if (active) throw new Error('OpenCode session is already running; no task resubmitted');
  if (needsInput) throw new Error('OpenCode session requires user input; no configuration changed or task submitted');
  const defaultModel = task.effort && !task.model && !info.model
    ? request('model.default', { 'location[directory]': task.cwd }, undefined, task.cwd) : null;
  const chosen = modelRef(task, info.model || (defaultModel ? { id: defaultModel.id, providerID: defaultModel.providerID } : null));
  if (chosen) {
    const model = request('model.list', { 'location[directory]': task.cwd }, undefined, task.cwd)
      .find(item => item.providerID === chosen.providerID && item.id === chosen.id);
    if (!model || (chosen.variant && !model.variants?.some(item => item.id === chosen.variant))) {
      throw new Error('OpenCode model or variant is not in the installed model catalog');
    }
    request('session.switchModel', params, { model: chosen }, task.cwd);
  }
  // Session-only approval rules leave project/global configuration untouched. / 仅设置会话审批规则，不改项目或全局配置。
  if (!task.skipPermissions && !['acceptEdits', 'native', 'ask'].includes(task.permissionMode || 'native')) {
    throw new Error('OpenCode permission-mode must be native or ask (acceptEdits is a legacy native-policy alias)');
  }
  const permissions = task.skipPermissions ? [{ action: '*', resource: '*', effect: 'allow' }]
    : task.permissionMode === 'ask' ? [{ action: '*', resource: '*', effect: 'ask' }] : [];
  request('session.update', params, { permissions }, task.cwd);
  const entries = request('experimental.session.instructions.entry.list', params, undefined, task.cwd);
  const value = fs.readFileSync(task.workerPolicyPath, 'utf8');
  if (!entries.some(entry => entry.key === 'codex-agent-bridge' && entry.value === value)) {
    request('experimental.session.instructions.entry.put', { ...params, key: 'codex-agent-bridge' }, { value }, task.cwd);
  }
  return info;
}

function prepareSubmission(task, request = call) {
  configure(task, request);
  const { info, active, needsInput } = nativeState(task, request);
  if (active || needsInput) throw new Error('OpenCode session changed before admission; no task submitted');
  // Bind the prior terminal outcome to this admission; identical old failures cannot settle the new round. / 将历史终态绑定到本轮准入，相同旧失败不得收口新轮次。
  task.opencodeSubmissionBaseline = { ...submissionBinding(task), outcome: info.outcome || null,
    idleAt: info.time?.idle || 0, capturedAt: now() };
}

function prepareWorker(task, resumeId, request = call) {
  if (resumeId) {
    task.workerSessionId = resumeId;
  } else {
    // Creation is metadata-only and deliberately happens before any model prompt. / 创建仅涉及元数据，在任何模型任务之前完成。
    const info = request('session.create', {}, { title: 'opencode', location: { directory: task.cwd } }, task.cwd);
    task.workerSessionId = info.id;
  }
  const info = request('session.get', { sessionID: task.workerSessionId }, undefined, task.cwd);
  verifySession(task, info);
  // Reattaching an active session observes existing work without mutating or replaying it. / 重连活跃会话仅观察既有执行，不修改或重放任务。
  if (!resumeId || !request('session.active', {}, undefined, task.cwd)[info.id]) configure(task, request);
  verifySession(task, info);
  fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify({
    timestamp: now(), taskId: task.id, herdrSession: task.herdrSession, paneId: task.paneId,
    sessionId: info.id, name: 'SessionStart', source: 'opencode-api',
  }) + '\n');
}

function snapshot(task, request = call) {
  let native = nativeState(task, request);
  if (native.needsInput) return { state: 'blocked', reason: 'user_input_required', originalExecutionMayContinue: true };
  if (native.active) return { state: 'working' };
  // Completion may race the earlier get; refresh outcome before publishing idle. / 完成可能与前次get并发，发布空闲前刷新结果。
  native = nativeState(task, request);
  if (native.needsInput) return { state: 'blocked', reason: 'user_input_required', originalExecutionMayContinue: true };
  if (native.active) return { state: 'working' };
  const { info } = native;
  if (info.outcome === 'failed') {
    if (task.opencodeRetry?.round === task.round && ['sending', 'confirmed', 'uncertain'].includes(task.opencodeRetry.status)) {
      const admission = currentAdmission(task);
      const startedAt = Number.isFinite(admission.requestStartedAt) ? admission.requestStartedAt
        : Date.parse(admission.requestStartedAt || admission.timestamp || '');
      if (!Number.isFinite(startedAt) || !Number.isFinite(info.time?.idle) || info.time.idle <= startedAt) {
        // An admitted retry may precede the server's next active snapshot; the previous failure is not its result. / 重试准入可能早于新活动快照，旧失败不得作为重试结果。
        return Number.isFinite(startedAt) && Date.now() - startedAt < 60000
          ? { state: 'working', reason: 'awaiting_retry_execution' }
          : { state: 'blocked', reason: 'retry_execution_unconfirmed', originalExecutionMayContinue: true };
      }
    }
    if (unsubmittedInitial(task) || unchangedPreviousFailure(task, info)) {
      return { state: 'idle', reason: 'previous_execution_failed', outcome: 'failed', idleAt: info.time?.idle || 0 };
    }
    return { state: 'blocked', reason: 'execution_failed', originalExecutionMayContinue: false };
  }
  return { state: 'idle', outcome: info.outcome || null, idleAt: info.time?.idle || 0 };
}

function refreshWorker(task, { forSubmission = false } = {}, request = call, report = publish) {
  if (forSubmission) {
    if ((task.round === 0 && !unsubmittedInitial(task)) || task.status === 'submission_unknown'
        || ['preparing', 'sending', 'uncertain'].includes(task.submission?.status)) {
      throw new Error('OpenCode submission evidence is uncertain; reconcile before any new admission');
    }
    const { leaseForEvent } = require('./worker-lease');
    const lease = leaseForEvent(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
    if (!lease || lease.taskId !== task.id || lease.terminalId !== task.terminalId || lease.workerSessionId !== task.workerSessionId) {
      throw new Error('OpenCode submission Pane lease mismatch');
    }
    const other = require('./worker-scheduling').taskList(task.stateDir).find(item => item.id !== task.id
      && !['accepted', 'cancelled'].includes(item.status) && item.workerSessionId === task.workerSessionId
      && require('./agents').getAgent(item.agent).id === 'opencode');
    if (other) throw new Error('OpenCode native session has another unresolved task; no task submitted');
  }
  const state = snapshot(task, request);
  if (idleBelongsToRound(task, state)) report(task, state);
  return state;
}

function cancellationState(task, request = call) {
  if (!task.workerSessionId) throw new Error('OpenCode cancellation requires the saved native session ID');
  const params = { sessionID: task.workerSessionId };
  const observe = () => {
    const native = nativeState(task, request);
    const inbox = asArray(request('session.inbox.list', params, undefined, task.cwd), 'session.inbox.list');
    const pending = inbox.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || item.sessionID !== task.workerSessionId) {
        const error = new Error('OpenCode cancellation inbox is malformed or belongs to another session');
        error.code = 'OPENCODE_API_MALFORMED'; error.operation = 'session.inbox.list'; throw error;
      }
      return { id: item.id, type: item.type };
    });
    const inputPending = native.needsInput || pending.length > 0;
    return { confirmed: !native.active && !inputPending,
      reason: native.permissions.length || native.forms.length ? 'native_input_pending'
        : pending.length ? 'native_input_queued' : native.active ? 'native_active' : 'native_idle',
      pendingInputIds: [...native.permissions.map(item => item?.id || item?.requestID), ...native.forms.map(item => item?.id || item?.formID), ...pending.map(item => item.id)].filter(Boolean),
      outcome: ['failed', 'interrupted', 'success', 'completed'].includes(native.info.outcome) ? native.info.outcome : null };
  };
  const first = observe();
  // Two native idle observations confirm stopping even after failure; Pane closure alone proves nothing. / 即使执行失败也须两次原生空闲观测确认停止，关闭Pane本身不构成证明。
  return first.confirmed ? observe() : first;
}

function interrupt(task, requestOrOptions = call, expectedFingerprint) {
  const options = typeof requestOrOptions === 'function' ? { request: requestOrOptions, expectedFingerprint }
    : { ...(requestOrOptions || {}), expectedFingerprint: requestOrOptions?.expectedFingerprint || expectedFingerprint };
  const request = options.request || call;
  const before = cancellationState(task, request);
  if (before.confirmed) return before;
  if (before.reason === 'native_input_pending') {
    throw new Error(`OpenCode cancellation is waiting for explicit native input resolution: ${(before.pendingInputIds || []).join(', ') || before.reason}`);
  }
  if (before.reason === 'native_input_queued') {
    const evidence = nativeTurnEvidence(task, request);
    const ownPending = evidence.inbox.filter(item => item.id === evidence.admission.id);
    if (evidence.needsInput || evidence.inbox.length !== 1 || ownPending.length !== 1 || evidence.admission.status === 'prepared') {
      throw new Error(`OpenCode cancellation will not remove external or ambiguous queued input: ${before.pendingInputIds.join(', ')}`);
    }
    request('session.inbox.cancel', { sessionID: task.workerSessionId, inboxID: evidence.admission.id }, undefined, task.cwd);
    const state = cancellationState(task, request);
    if (!state.confirmed) throw new Error('OpenCode queued bridge input was removed, but the native session remains active or has pending input');
    return state;
  }
  const evidence = nativeTurnEvidence(task, request);
  const fingerprint = turnFingerprintFromEvidence(task, evidence);
  if (options.expectedFingerprint && fingerprint !== options.expectedFingerprint) {
    throw new Error('OpenCode native turn changed; cancellation was not retried');
  }
  request('session.interrupt', { sessionID: task.workerSessionId, resume: 'false' }, undefined, task.cwd);
  const state = cancellationState(task, request);
  if (!state.confirmed) throw new Error('OpenCode interruption not confirmed; current native turn remains active or has pending input');
  return state;
}

function submitWorker(task, text, request = call, report = publish) {
  // Stable admission IDs make ambiguous delivery inspectable without automatic retries. / 稳定准入ID便于核对不确定提交，不自动重试。
  const id = 'msg_bridge' + crypto.createHash('sha256').update(`${task.stateDir}\n${task.id}\n${task.round}`).digest('hex').slice(0, 32);
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-opencode-admission.json`);
  const requestStartedAt = now();
  writeJsonAtomic(file, { id, sessionId: task.workerSessionId, round: task.round, status: 'sending', requestStartedAt, timestamp: requestStartedAt });
  const admission = request('session.prompt', { sessionID: task.workerSessionId }, { id, text }, task.cwd);
  if (admission?.id !== id) throw new Error('OpenCode prompt admission ID mismatch');
  writeJsonAtomic(file, { id, sessionId: task.workerSessionId, round: task.round, status: 'confirmed', requestStartedAt, timestamp: now() });
  // Admission is real activity even if a short turn finishes between snapshots. / 准入即真实活动，短任务在快照间完成也不能丢失活动证据。
  report(task, { state: 'working', reason: 'admitted' });
}

function idleBelongsToRound(task, state) {
  if (state.state !== 'idle' || !['running', 'submission_unknown'].includes(task.status)) return true;
  if (state.reason === 'previous_execution_failed') return unsubmittedInitial(task);
  const submitted = task.history?.findLast(item => item.round === task.round && item.status === 'submitted');
  return state.idleAt >= Date.parse(submitted?.timestamp || task.createdAt);
}

function publish(task, state, report = require('./herdr').api) {
  const receipt = { timestamp: now(), taskId: task.id, herdrSession: task.herdrSession, paneId: task.paneId,
    terminalId: task.terminalId, sessionId: task.workerSessionId, round: task.round, name: state.state === 'working' ? 'UserPromptSubmit' : 'Stop', source: 'opencode-api', ...state };
  const file = path.join(taskDir(task.id), 'opencode-state.json');
  const previous = readJson(file, null);
  const fields = ['taskId', 'round', 'herdrSession', 'paneId', 'terminalId', 'sessionId', 'state', 'reason', 'outcome', 'idleAt', 'originalExecutionMayContinue'];
  if (previous?.reported && fields.every(key => previous[key] === receipt[key])) return;
  fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify(receipt) + '\n');
  writeJsonAtomic(file, { ...receipt, reported: false });
  report(task.herdrSession, ['pane', 'report-agent', task.paneId, '--source', 'custom:agent-bridge-opencode',
    '--agent', 'opencode', '--state', state.state, '--seq', String(Date.now()), '--agent-session-id', task.workerSessionId]);
  writeJsonAtomic(file, { ...receipt, reported: true });
}

module.exports = { call, prepareWorker, configure, prepareSubmission, refreshWorker, snapshot, interrupt, cancellationState,
  submitWorker, verifySession, modelRef, idleBelongsToRound, publish, authorizePaneLessInterrupt, turnFingerprint,
  reconcileSubmission, confirmReconciledSubmission, confirmCompletion, authorizeFailedRoundRetry, prepareFailedRoundRetry,
  submitFailedRoundRetry, MAX_FAILED_ROUND_RETRIES };
