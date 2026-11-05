'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./protocol-v2');
const { readJson, writeJsonAtomic, taskDir, now, saveTask, event, sleep, withLock } = require('./util');
const { renderSubmissionPointer } = require('./worker-policy');
function check(ok, message) { if (!ok) throw Object.assign(new Error(message), { code: 'CBC_PROTOCOL_UNCONFIRMED' }); }
const equalPath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

function prepareWorker(task) {
  if (task.taskProtocol !== 2) return;
  const file = path.join(taskDir(task.id), 'cbc-layered-settings.json');
  const hookPath = path.resolve(__dirname, '../hooks/cbc-task-events.js');
  const command = `"${task.nodeExecutable || process.execPath}" "${hookPath}"`;
  const provider = path.join(require('./util').homePath('.codebuddy', 'hooks'), 'herdr-codebuddy-hook.js');
  const providerBytes = p.readRegular(provider, 1024 * 1024);
  check(providerBytes.toString('utf8').includes('custom:codebuddy'), 'The installed Herdr CodeBuddy status provider is unavailable');
  const installed = readJson(require('./util').homePath('.codebuddy', 'settings.json'), {}).hooks || {};
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']) {
    check(Array.isArray(installed[name]) && installed[name].some(entry => Array.isArray(entry.hooks)
      && entry.hooks.some(h => h.type === 'command' && typeof h.command === 'string'
        && h.command.includes('herdr-codebuddy-hook.js'))), `Installed status provider is not configured for ${name}; no worker started`);
  }
  const hooks = {};
  for (const name of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification']) {
    hooks[name] = [{ hooks: [{ type: 'command', command }] }];
  }
  writeJsonAtomic(file, { contextWindow: 1000000, hooks });
  task.cbcSettingsPath = file;
  task.layeredHookRuntime = hookPath;
  task.herdrStatusProvider = { source: 'custom:codebuddy', sha256: p.sha(providerBytes), path: provider };
}

function request(task) {
  check(task.taskProtocol === 2 && task.agent === 'cbc', 'Task is not enrolled in layered CBC');
  const id = task.submission?.attemptId || task.layeredRequestId;
  check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id), 'Request ID is unavailable');
  const file = path.join(task.stateDir, 'tasks', task.id, `round-${String(task.round).padStart(3, '0')}-request-${id}`, 'request.json');
  check(equalPath(file, task.layeredRequestFile), 'Request file is not round-bound');
  const r = JSON.parse(p.readRegular(file)); p.validateRequest(r);
  check(r.taskId === task.id && r.round === task.round && r.requestId === id && equalPath(r.stateDir, task.stateDir)
    && equalPath(r.cwd, task.cwd) && r.binding.sessionId === task.workerSessionId, 'Task/request identity mismatch');
  return r;
}

async function prepare(task, attempt, { previous } = {}) {
  const predecessor = previous?.taskProtocol === 2 && previous.layeredRequestFile ? request(previous) : null;
  task.layeredRequestId = attempt.attemptId;
  task.layeredRequestFile = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-request-${attempt.attemptId}`, 'request.json');
  const resultCommand = [JSON.stringify(task.nodeExecutable || process.execPath),
    JSON.stringify(path.resolve(__dirname, '../bin/bridge-result.js')), '--request-file', JSON.stringify(task.layeredRequestFile)];
  fs.appendFileSync(task.promptPath, '\n## 机器可确认的本轮交付\n\n'
    + '先写指定交付报告，再执行以下命令冻结本轮结果；成功后结束本轮。不得省略、改request-file或自行accept。\n'
    + '默认delivered仅表示已交付待审；无法完成使用--outcome failed --reason "原因"，仍须报告证据。\n'
    + '任务规格deliverables必须是实际文件路径，程序自动冻结；附加证据可用重复--artifact "相对项目路径"加入，文件须在允许范围。\n'
    + '```powershell\n& ' + resultCommand.join(' ') + ' --outcome delivered\n```\n');
  const original = readJson(attempt.file);
  original.promptSha256 = p.sha(fs.readFileSync(task.promptPath)); writeJsonAtomic(attempt.file, original);
  const r = { schema: p.SCHEMA, taskId: task.id, round: task.round, requestId: attempt.attemptId,
    specSha256: p.digest(task.taskSpec), promptSha256: original.promptSha256,
    pointerSha256: p.sha(Buffer.from(renderSubmissionPointer(task))), createdAt: original.createdAt,
    cwd: fs.realpathSync.native(task.cwd), stateDir: fs.realpathSync.native(task.stateDir), reportPath: task.deliveryPath,
    allowedArtifacts: task.allowedWritePaths || task.taskSpec.allowedChanges,
    requiredArtifacts: task.taskSpec.deliverables.filter(file => !equalPath(path.resolve(task.cwd, file), task.deliveryPath)),
    binding: { agent: 'cbc', sessionId: task.workerSessionId, herdrSession: task.herdrSession,
      paneId: task.paneId, terminalId: task.terminalId, workerStartedAt: task.workerStartedAt } };
  if (predecessor) r.predecessor = { taskId: predecessor.taskId, round: predecessor.round,
    requestId: predecessor.requestId, requestSha256: p.digest(predecessor),
    resultSha256: p.inspect(predecessor).resultSha256 };
  await p.create(r); return r;
}

function nativeRows(task, input) {
  const file = require('./cbc-turn').nativeTranscriptPath(input, task);
  check(file, 'Native transcript identity is unavailable');
  const bytes = p.readRegular(file, 128 * 1024 * 1024), end = bytes.lastIndexOf(10);
  check(end >= 0, 'Native transcript has no complete records');
  const rows = bytes.subarray(0, end + 1).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const user = rows.filter(x => x.type === 'message' && x.role === 'user' && x.providerData?.skipRun !== true);
  const latest = user.at(-1);
  check(latest && latest.sessionId === task.workerSessionId && equalPath(latest.cwd, task.cwd)
    && typeof latest.id === 'string', 'No exact native input record');
  const text = typeof latest.content === 'string' ? latest.content : Array.isArray(latest.content)
    ? latest.content.filter(x => x.type === 'input_text' || x.type === 'text').map(x => x.text).join('') : '';
  return { file, latest, text, users: user, evidenceSha256: p.sha(bytes.subarray(0, end + 1)), userId: latest.id };
}

// Persist boundary observations before interpretation; transcript writes may lag the Hook. / 先持久保存边界观察再解释，原生记录落盘可能晚于Hook。
async function capture(task, raw, turnCapture) {
  if (task?.taskProtocol !== 2 || !task.layeredRequestFile) return;
  const r = request(task), name = raw.hook_event_name || raw.event;
  if (!['UserPromptSubmit', 'Stop', 'Notification', 'PreToolUse', 'PostToolUse'].includes(name)) return;
  check(raw.session_id === r.binding.sessionId && task.terminalId === r.binding.terminalId
    && task.paneId === r.binding.paneId, 'Hook execution binding changed');
  const current = p.inspect(r);
  if (current.execution === 'ended' || ['closed', 'abandoned'].includes(current.control)) return;
  if (['PreToolUse', 'PostToolUse'].includes(name) && current.execution !== 'blocked') {
    if (current.transport !== 'admitted') await reconcileEvidence(task);
    return;
  }
  const payload = { sessionId: r.binding.sessionId, paneId: r.binding.paneId, terminalId: r.binding.terminalId,
    name, at: now(), ...(typeof raw.transcript_path === 'string' ? { nativeTranscript: raw.transcript_path } : {}),
    ...(name === 'UserPromptSubmit' ? { promptSha256: turnCapture?.promptSha256 || p.sha(Buffer.from(raw.prompt || '')) } : {}),
    ...(name === 'Notification' ? { reason: raw.notification_type } : {}) };
  // Identical boundary retransmissions share evidence; distinct native rows remain independently checked. / 相同边界重投复用证据，不同原生输入行仍独立核对。
  if (name === 'UserPromptSubmit' && p.load(r).events.some(e => e.kind === 'evidence.hook'
    && e.payload.name === name && e.payload.promptSha256 === payload.promptSha256
    && e.payload.nativeTranscript === payload.nativeTranscript)) return reconcileEvidence(task);
  await p.append(r, p.event(r, 'evidence.hook', payload));
  await reconcileEvidence(task);
}

async function reconcileEvidence(task) {
  const r = request(task), data = p.load(r), state = p.reduce(r, data.events);
  if (state.execution === 'ended' || ['closed', 'abandoned'].includes(state.control)) return state;
  const raw = data.events.filter(e => e.kind === 'evidence.hook').sort((a, b) => Date.parse(a.payload.at) - Date.parse(b.payload.at));
  const admittedHook = raw.find(e => e.payload.name === 'UserPromptSubmit');
  if (!admittedHook) return state;
  const hook = admittedHook.payload;
  let native;
  try { native = nativeRows(task, hook.nativeTranscript); }
  catch (error) {
    // Persist a bounded category, never raw transcript parse errors. / 仅保存有界错误类别，不泄漏原生记录解析内容。
    const reason = error instanceof SyntaxError ? 'native-json-invalid' : error.code === 'ENOENT'
      ? 'native-record-pending' : 'native-evidence-unavailable';
    return p.append(r, p.event(r, 'observer.unavailable', { reason }, reason));
  }
  if (state.observation === 'unavailable') {
    const unavailable = data.events.filter(e => e.kind === 'observer.unavailable').at(-1);
    await p.append(r, p.event(r, 'observer.healthy', { reason: 'native-evidence-readable' }, 'recovered-' + p.sha(unavailable.eventId).slice(0, 24)));
  }
  const body = row => typeof row.content === 'string' ? row.content : (row.content || [])
    .filter(x => x.type === 'input_text' || x.type === 'text').map(x => x.text).join('');
  const matched = native.users.filter(row => Date.parse(new Date(row.timestamp).toISOString()) >= Date.parse(r.createdAt)
    && row.sessionId === r.binding.sessionId && equalPath(row.cwd, r.cwd)
    && p.sha(Buffer.from(body(row))) === r.pointerSha256);
  if (matched.length === 0) return state;
  check(matched.length === 1, 'More than one native input matches the request; no automatic replay or settlement');
  const input = matched[0], base = { sessionId: r.binding.sessionId, paneId: r.binding.paneId, terminalId: r.binding.terminalId };
  const currentInputs = native.users.filter(row => new Date(row.timestamp).getTime() >= Date.parse(r.createdAt));
  check(currentInputs[0]?.id === input.id && Date.parse(hook.at) >= new Date(input.timestamp).getTime(),
    'Native exact input and first ordered Hook boundary do not agree');
  const prior = data.events.find(e => e.kind === 'native.admitted');
  if (prior) check(prior.payload.nativeMessageId === input.id, 'Native request input changed');
  else await p.append(r, p.event(r, 'native.admitted', { ...base, at: new Date(input.timestamp).toISOString(),
    nativeMessageId: input.id, pointerSha256: r.pointerSha256, evidenceSha256: p.digest(input), nativeTranscript: native.file,
    hookPromptSha256: hook.promptSha256, hookEventId: admittedHook.eventId }, 'native-admission'));
  const following = raw.slice(raw.indexOf(admittedHook) + 1);
  const stop = following.find(e => e.payload.name === 'Stop');
  const foreign = following.find(e => e.payload.name === 'UserPromptSubmit' && e.payload.promptSha256 !== hook.promptSha256);
  if (foreign && (!stop || raw.indexOf(foreign) < raw.indexOf(stop))) {
    await p.append(r, p.event(r, 'native.foreign_input', { ...base, at: foreign.payload.at,
      evidenceSha256: p.digest(foreign) }, 'foreign-' + foreign.eventId));
    return p.inspect(r);
  }
  // Native input rows are an independent cross-check against a missed foreign-input Hook. / 原生输入行独立交叉检查遗漏的外来输入Hook。
  const after = native.users.slice(native.users.indexOf(input) + 1);
  const conflicting = after.find(row => !stop || new Date(row.timestamp).getTime() <= Date.parse(stop.payload.at));
  if (conflicting) {
    await p.append(r, p.event(r, 'native.foreign_input', { ...base, at: new Date(conflicting.timestamp).toISOString(),
      nativeMessageId: conflicting.id }, 'foreign-native-' + p.sha(conflicting.id).slice(0, 32)));
    return p.inspect(r);
  }
  if (stop) {
    await p.append(r, p.event(r, 'native.stopped', { ...base, at: stop.payload.at, nativeMessageId: input.id,
      evidenceSha256: p.digest({ hook: stop, inputSha256: p.digest(input) }) }, 'native-stop'));
  } else {
    const activity = following.filter(e => ['Notification', 'PreToolUse', 'PostToolUse'].includes(e.payload.name)).at(-1);
    if (activity && (activity.payload.name !== 'Notification' || activity.payload.reason === 'permission_prompt')) {
      const kind = activity.payload.name === 'Notification' ? 'native.blocked' : 'native.progress';
      await p.append(r, p.event(r, kind, { ...base, at: activity.payload.at, nativeMessageId: input.id,
        reason: kind === 'native.blocked' ? 'permission' : 'tool-activity' }, 'activity-' + activity.eventId));
    }
  }
  return p.inspect(r);
}

function readTurn(task) {
  try {
    const r = request(task), state = p.inspect(r), events = p.load(r).events;
    const admitted = events.find(e => e.kind === 'native.admitted'), stopped = events.find(e => e.kind === 'native.stopped');
    return { state: state.conflicts.length ? 'unconfirmed' : state.execution === 'ended' ? 'stopped'
      : state.execution === 'running' ? 'active' : state.execution === 'blocked' ? 'blocked' : 'unconfirmed',
    attemptId: r.requestId, submittedAt: admitted?.payload.at || null, stopAt: stopped?.payload.at || null,
    laterInputAt: null, reason: state.conflicts.join(', ') || state.waitingFor.join(', '), layers: state };
  } catch (error) { return { state: 'unconfirmed', reason: error.message, code: error.code }; }
}

async function transition(task, kind, payload, id) {
  const r = request(task); return p.append(r, p.event(r, kind, payload, id));
}

function sync(task) {
  const r = request(task), layers = p.inspect(r); task.layers = layers;
  if (layers.transport === 'admitted' && task.submission.status !== 'observed') {
    task.submission = { ...task.submission, status: 'observed', reconciledFrom: task.submission.status,
      requestProof: { requestId: r.requestId, requestSha256: p.digest(r) } };
  }
  if (layers.control === 'abandoned') {
    task.status = 'abandoned'; task.originalExecutionMayContinue = true;
    task.abandonment ||= {};
    task.abandonment.resourceFence = { ...task.abandonment.resourceFence, active: true, wholeProject: true };
  }
  else if (layers.control === 'closed') task.status = 'cancelled';
  else if (layers.control === 'cancel_requested') task.status = 'cancel_pending';
  else if (layers.review === 'accepted') task.status = 'accepted';
  else if (layers.review === 'pending' || layers.review === 'changes_requested') {
    task.frozenResult = require('./protocol-artifacts').verifyResult(r);
    task.status = 'review_pending'; task.error = null;
  } else if (layers.conflicts.length) {
    task.status = 'blocked'; task.error = `Protocol conflict: ${layers.conflicts.join(', ')}`;
  } else if (layers.execution === 'ended') { task.status = 'delivery_missing'; task.error = 'Native execution ended without a frozen structured result'; }
  else if (layers.execution === 'blocked') { task.status = 'blocked'; task.error = 'Native execution requires approval; no automatic permission granted'; }
  else if (layers.transport === 'admitted') { task.status = 'running'; task.error = null; }
  else if (['unknown', 'sending', 'written'].includes(layers.transport)) task.status = 'submission_unknown';
  task.cbcTurnReceipt = readTurn(task); return task;
}

async function accept(task) {
  const r = request(task), state = p.inspect(r);
  check(state.review === 'pending' && state.control === 'open', 'This request has no verified frozen result awaiting review');
  const artifacts = require('./protocol-artifacts').verifyResult(r);
  task.frozenResult = artifacts;
  // Review the frozen version; current resource readiness belongs to the next dispatch. / 验收冻结版本，当前资源是否可派工由下一次准入检查。
  await transition(task, 'review.accepted', { resultSha256: state.resultSha256, manifestSha256: artifacts.manifestSha256 }, 'review-accepted');
  sync(task); task.history.push({ round: task.round, status: 'accepted', timestamp: now(), requestId: r.requestId });
  saveTask(task); require('./worker-context').recordContext(task);
  event(task, 'accepted', { requestId: r.requestId, snapshot: true }); return task;
}

async function watchLoop(taskId, generation, { maxMs = 1800000, pause = sleep, requestId } = {}) {
  check(typeof requestId === 'string', 'Observer requires an exact request ID');
  const started = Date.now();
  for (;;) {
    let done = false, notify = null;
    await withLock(taskId, async () => {
      const task = require('./util').loadTask(taskId);
      if (task.taskProtocol !== 2 || task.layeredRequestId !== requestId || (task.observerGeneration || 0) !== generation
        || ['accepted', 'cancelled', 'abandoned'].includes(task.status)) { done = true; return; }
      const previous = task.status;
      await reconcileEvidence(task);
      sync(task);
      if (['review_pending', 'delivery_missing', 'blocked', 'cancel_pending', 'cancelled'].includes(task.status)) {
        if (task.status === 'cancel_pending' && task.layers.execution === 'ended') {
          // Final closure runs outside this synchronous projection block on the next recover. / 最终收口由正式recover执行，当前不发送任何停止命令。
          task.error = 'Original request ended; recover can confirm local cancellation without stopping the session';
        }
        done = task.status !== 'blocked' || task.layers.conflicts.length > 0;
        if (done) task.watcherPid = null;
        if (previous !== task.status) {
          task.settlementSeq = (task.settlementSeq || 0) + 1;
          task.history.push({ round: task.round, status: task.status, timestamp: now(), requestId: task.layeredRequestId });
          notify = task;
        }
      }
      if (done || previous !== task.status || JSON.stringify(task.layers) !== JSON.stringify(require('./util').loadTask(taskId).layers)) {
        saveTask(task);
        if (task.status === 'review_pending') require('./worker-context').recordContext(task);
      }
    });
    if (notify) try { await require('./notify').notifyTask(notify); }
    catch (error) { event(notify, 'notification_reconciliation_failed', { code: error.code || 'NOTIFY_FAILED', message: error.message }); }
    if (done) return;
    if (maxMs > 0 && Date.now() - started > maxMs) {
      await withLock(taskId, async () => {
        const task = require('./util').loadTask(taskId);
        if (task.layeredRequestId !== requestId || (task.observerGeneration || 0) !== generation) return;
        await transition(task, 'observer.unavailable', { reason: 'observation-deadline; execution may continue' }, `observer-timeout-${generation}`);
        task.layers = p.inspect(request(task)); task.watcherPid = null;
        task.settlementSeq = (task.settlementSeq || 0) + 1; saveTask(task); notify = task;
      });
      if (notify) try { await require('./notify').notifyTask(notify); }
      catch (error) { event(notify, 'notification_reconciliation_failed', { code: error.code || 'NOTIFY_FAILED', message: error.message }); }
      return;
    }
    await pause(750);
  }
}

async function watch(taskId, generation, options = {}) {
  try { return await watchLoop(taskId, generation, options); }
  catch (error) {
    await withLock(taskId, async () => {
      const task = require('./util').loadTask(taskId);
      if (task.layeredRequestId !== options.requestId || (task.observerGeneration || 0) !== generation) return;
      task.watcherPid = null;
      task.observationDiagnostic = { at: now(), code: error.code || 'OBSERVER_FAILED', message: String(error.message).slice(0, 1024) };
      try { await transition(task, 'observer.unavailable', { reason: task.observationDiagnostic.code }, `observer-failed-${generation}`); task.layers = p.inspect(request(task)); } catch {}
      saveTask(task);
    });
    throw error;
  }
}

async function recover(task, options = {}) {
  if (options['wait-timeout-ms'] !== undefined) {
    const value = Number(options['wait-timeout-ms']);
    check(Number.isSafeInteger(value) && value >= 0 && value <= 86400000, 'Invalid observation deadline');
    task.waitTimeoutMs = value;
  }
  await reconcileEvidence(task);
  if (p.inspect(request(task)).control === 'cancel_requested') return cancel(task, { requested: false });
  sync(task); saveTask(task);
  if (['accepted', 'cancelled', 'abandoned', 'review_pending', 'delivery_missing'].includes(task.status) || task.layers.conflicts.length) {
    return { taskId: task.id, layers: task.layers, status: task.status, actions: ['reconciled-local-request; no input sent'] };
  }
  // Replace observation generation only; stale observers retire without killing an arbitrary PID. / 仅更换观察代次，旧观察器自行退出，不按任意PID杀进程。
  task.observerGeneration = (task.observerGeneration || 0) + 1;
  await transition(task, 'observer.healthy', { reason: 'local-observer-restored' }, `observer-restored-${task.observerGeneration}`);
  saveTask(task);
  task.watcherPid = require('./herdr').startWatcher(task.id); saveTask(task);
  return { taskId: task.id, layers: task.layers, status: task.status, actions: ['local-observer-started; no input sent'] };
}

async function cancel(task, { requested = true, proveAbsent = value => require('./pane-cancellation').cancellationState(value) } = {}) {
  const r = request(task); let state = p.inspect(r);
  if (['closed', 'abandoned'].includes(state.control) || state.review === 'accepted') return task;
  const actor = task.codexThread || 'local-controller-cli';
  if (requested && state.control === 'open') {
    await transition(task, 'control.cancel_requested', { actor, reason: 'explicit-cancel; no native stop sent' }, 'cancel-requested');
  }
  const data = p.load(r), stop = data.events.find(e => e.kind === 'native.stopped');
  const rejected = data.events.find(e => e.kind === 'transport.rejected');
  let proof;
  if (state.execution === 'ended' && !state.conflicts.length) proof = { proofType: 'request-ended', evidenceSha256: stop.payload.evidenceSha256 };
  else if (state.transport === 'rejected' || state.transport === 'prepared') proof = {
    proofType: 'not-sent', evidenceSha256: p.digest(rejected?.payload || { prepared: r.requestId }) };
  else {
    try {
      const absence = await proveAbsent(task);
      if (absence.confirmed === true) {
        proof = { proofType: 'bound-worker-absent', evidenceSha256: p.digest(absence) };
        await transition(task, 'resource.released', { ...proof, at: now(), sessionId: r.binding.sessionId }, 'resource-closed-worker');
      }
    } catch (error) { task.protocolDiagnostic = { code: error.code || 'ABSENCE_UNCONFIRMED', message: error.message }; }
  }
  if (proof) {
    await transition(task, 'control.closed', { ...proof, actor, reason: 'confirmed local coordination closure; technical result not accepted' }, 'coordination-closed');
    task.cancellation = { status: 'confirmed', ...proof, interruptAttempts: [], originalExecutionMayContinue: proof.proofType === 'bound-worker-absent' };
    task.originalExecutionMayContinue = proof.proofType === 'bound-worker-absent';
    task.observerGeneration = (task.observerGeneration || 0) + 1; task.watcherPid = null;
  }
  sync(task);
  if (task.status === 'cancel_pending') task.error = 'Cancellation awaits exact terminal or closed-worker evidence; no global stop or prompt sent';
  saveTask(task); return task;
}

function report(task) {
  const r = request(task), state = p.inspect(r);
  const manifest = require('./protocol-artifacts').readManifest(r);
  require('./protocol-artifacts').verifyResult(r);
  const entry = manifest.files.find(x => x.role === 'report');
  return { taskId: task.id, round: task.round, requestId: r.requestId, layers: state,
    frozen: true, text: p.readRegular(path.join(p.requestDirectory(r), 'artifacts', entry.stored)).toString('utf8') };
}

module.exports = { request, prepare, prepareWorker, capture, reconcileEvidence, readTurn, transition, sync, accept, watch, recover, cancel, report, nativeRows };
