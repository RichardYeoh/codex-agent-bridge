'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTask, taskDir, config, processAlive, saveTask, writeJsonAtomic, now, event } = require('./util');
const { leasePath } = require('./worker-lease');
const { taskList } = require('./worker-scheduling');
const { agentInfo, paneInfo, api, resultPayload } = require('./herdr');
const { assertWorker } = require('./worker');
const readiness = require('./zcode-readiness');
const { queryAdmission, resolveTurn } = require('./zcode-observation');
const { ZCodeRemote, Conversation, readBinding } = require('./zcode-remote');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function requireProof(value, message) { if (!value) throw new Error('ZCode reconciliation refused: ' + message); }

// Read exact current-round evidence; never rewrite the uncertain transport journal. / 读取精确本轮证据，绝不重写不确定传输日志。
function inspectLocal(task) {
  requireProof(task.agent === 'zcode' && task.status === 'submission_unknown' && task.round > 0
    && task.submission?.status === 'uncertain' && /^[a-zA-Z0-9-]+$/.test(task.submission.attemptId || ''), 'task is not an uncertain ZCode round');
  const root = taskDir(task.id), prefix = `round-${String(task.round).padStart(3, '0')}`;
  const files = { task: path.join(root, 'task.json'), prompt: path.join(root, `${prefix}-prompt.md`),
    attempt: path.join(root, `${prefix}-submission-${task.submission.attemptId}.json`),
    command: path.join(root, `${prefix}-zcode-command.json`), observation: path.join(root, `${prefix}-zcode-observation.json`),
    state: path.join(root, 'zcode-state.json'), delivery: path.join(root, 'deliveries', `${prefix}.md`),
    lease: leasePath(task.stateDir, task.herdrSession, task.paneId) };
  requireProof(path.resolve(task.stateDir) === path.resolve(config().stateDir)
    && path.resolve(task.promptPath || '') === files.prompt && path.resolve(task.deliveryPath || '') === files.delivery
    && path.resolve(task.submission.file || '') === files.attempt, 'canonical evidence paths changed');
  const bytes = {}, hashes = {};
  for (const [key, file] of Object.entries(files)) {
    const stat = fs.lstatSync(file);
    requireProof(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024, 'invalid ' + key + ' evidence file');
    bytes[key] = fs.readFileSync(file); hashes[key] = hash(bytes[key]);
  }
  requireProof(JSON.stringify(JSON.parse(bytes.task)) === JSON.stringify(task), 'task changed before reconciliation');
  const parse = key => JSON.parse(bytes[key]);
  const attempt = parse('attempt'), command = parse('command'), observation = parse('observation'), state = parse('state'), lease = parse('lease');
  const expected = readiness.binding(task, command), keys = ['taskId', 'round', 'sessionId', 'commandId', 'paneId', 'terminalId'];
  const bound = value => value && keys.every(key => value[key] === expected[key]);
  requireProof(['uncertain', 'sending'].includes(attempt.status) && attempt.attemptId === task.submission.attemptId
    && attempt.taskId === task.id && attempt.round === task.round && attempt.agent === 'zcode'
    && attempt.herdrSession === task.herdrSession && attempt.paneId === task.paneId && attempt.terminalId === task.terminalId
    && attempt.workerSessionId === task.workerSessionId && attempt.promptSha256 === hashes.prompt
    && typeof command.envelope.payload?.text === 'string' && hash(command.envelope.payload.text) === hashes.prompt, 'attempt or exact payload hash mismatch');
  const ack = command.ack, result = observation.result, header = result?.header;
  requireProof(command.status === 'terminal' && command.turnState === 'completedSuccess'
    && ack?.commandId === expected.commandId && ['accepted', 'duplicate'].includes(ack.status)
    && ack.result?.type === 'inputAccepted' && ack.result.inputId === expected.commandId, 'current command admission/terminal is unconfirmed');
  requireProof(bound(observation) && bound(state) && state.herdrSession === task.herdrSession && state.cwd === task.cwd
    && state.state === 'idle' && state.turnState === 'completedSuccess' && state.source === 'zcode-v4'
    && state.commandSha256 === expected.commandSha256 && state.readinessProtocol === readiness.protocol
    && state.observerGeneration === (task.observerGeneration || 0) && observation.observerGeneration === (task.observerGeneration || 0)
    && Number.isSafeInteger(state.workerPid) && state.workerPid > 0 && Number.isFinite(Date.parse(state.workerProcessStartedAt)), 'worker or observation identity mismatch');
  requireProof(result?.seen === true && result.terminal === true && result.state === 'completedSuccess'
    && observation.phase === 'completedSuccess' && ['snapshot', 'conversationRowsRangeV4'].includes(result.evidence)
    && header?.kind === 'turnHeader' && header.sourceCommandId === expected.commandId && header.state === 'completedSuccess'
    && Number.isSafeInteger(header.rowId) && header.rowId >= 0 && result.headerRowId === header.rowId
    && Number.isSafeInteger(header.endedAt) && Number.isSafeInteger(result.seq) && result.seq >= 0
    && typeof result.logEpoch === 'string' && result.logEpoch.length > 0, 'authoritative terminal header is missing');
  const times = [Date.parse(attempt.createdAt), command.envelope.issuedAt, header.endedAt,
    Date.parse(observation.timestamp), Date.parse(command.timestamp), Date.parse(state.timestamp)];
  requireProof(times.every(Number.isFinite) && times.every((t, i) => i === 0 || t >= times[i - 1]), 'evidence chronology changed');
  const deliveryTime = fs.statSync(files.delivery).mtimeMs;
  requireProof(deliveryTime >= command.envelope.issuedAt && deliveryTime <= Date.parse(state.timestamp) + 5000,
    'delivery does not belong to the completed input interval');
  requireProof(lease.taskId === task.id && lease.herdrSession === task.herdrSession && lease.paneId === task.paneId
    && lease.terminalId === task.terminalId && lease.workerSessionId === task.workerSessionId, 'lease mismatch');
  return { files, hashes, expected, command, observation, state };
}

function terminalComparison(proof, turn) {
  const prior = proof.observation.result;
  const checks = {};
  const compare = (name, actual, expected, pass = actual === expected) => {
    checks[name] = { expected, actual: actual ?? null, actualType: typeof actual, pass: Boolean(pass) };
  };
  compare('seen', turn?.seen, true); compare('terminal', turn?.terminal, true);
  compare('state', turn?.state, 'completedSuccess');
  compare('headerKind', turn?.header?.kind, 'turnHeader');
  compare('sourceCommandId', turn?.header?.sourceCommandId, proof.expected.commandId);
  compare('headerRowId', turn?.header?.rowId, prior.headerRowId);
  compare('endedAt', turn?.header?.endedAt, prior.header.endedAt);
  compare('logEpoch', turn?.logEpoch, prior.logEpoch);
  compare('seq', turn?.seq, { minimum: prior.seq }, Number.isSafeInteger(turn?.seq) && turn.seq >= prior.seq);
  return { checks, failedChecks: Object.keys(checks).filter(key => !checks[key].pass) };
}

function snapshotEvidence(snapshot) {
  // Keep relevant raw state and headers, not conversation text or model configuration. / 保存相关原始状态与轮次头，不保存对话正文或模型配置。
  return { sessionId: snapshot?.sessionId, logEpoch: snapshot?.logEpoch, seq: snapshot?.seq,
    control: snapshot?.control && { phase: snapshot.control.phase, canStop: snapshot.control.canStop,
      stopState: snapshot.control.stopState, apiRetryPresent: Boolean(snapshot.control.apiRetry),
      activeWorks: snapshot.control.activeWorks?.map(work => ({ sourceCommandId: work.sourceCommandId, kind: work.kind })) },
    queue: { count: snapshot?.queue?.items?.length }, pendingInteractionCount: snapshot?.pendingInteractions?.length,
    workspaceHookAdmissionPresent: Boolean(snapshot?.workspaceHookAdmission), inputRouting: { mode: snapshot?.inputRouting?.mode },
    headers: snapshot?.rows?.window?.filter(row => row.kind === 'turnHeader') };
}

function rebuiltTerminalComparison(proof, turn, snapshot) {
  // Epoch-local offsets/times are not durable identity; prove the same input from current history. / 代内水位和展示时间不是持久身份，须由当前历史证明同一输入。
  const old = proof.observation.result.header, header = turn?.header, checks = {};
  const check = (name, actual, expected, pass = actual === expected) => {
    checks[name] = { expected, actual: actual ?? null, actualType: typeof actual, pass: Boolean(pass) };
  };
  check('seen', turn?.seen, true); check('terminal', turn?.terminal, true);
  check('state', turn?.state, 'completedSuccess'); check('headerState', header?.state, 'completedSuccess');
  check('headerKind', header?.kind, 'turnHeader');
  check('sourceCommandId', header?.sourceCommandId, proof.expected.commandId);
  for (const key of ['turnId', 'entityId', 'productTurnId', 'origin', 'executionKind']) {
    check(key, header?.[key], old[key] ?? null, typeof old[key] === 'string' && old[key].length > 0 && header?.[key] === old[key]);
  }
  check('headerRowId', header?.rowId, old.rowId);
  check('evidence', turn?.evidence, 'conversationRowsRangeV4');
  check('currentLogEpoch', turn?.logEpoch, snapshot.logEpoch);
  check('currentSeq', turn?.seq, { minimum: snapshot.seq }, Number.isSafeInteger(turn?.seq) && turn.seq >= snapshot.seq);
  const issuedAt = proof.command.envelope.issuedAt, observedAt = Date.parse(proof.observation.timestamp);
  const withinTurn = value => Number.isSafeInteger(value) && value >= issuedAt && value <= observedAt;
  const interval = { minimum: issuedAt, maximum: observedAt };
  for (const key of ['createdAt', 'startedAt', 'endedAt']) check(key, header?.[key], interval, withinTurn(header?.[key]));
  check('timeOrder', { startedAt: header?.startedAt, endedAt: header?.endedAt }, 'createdAt <= startedAt <= endedAt',
    header?.createdAt <= header?.startedAt && header?.startedAt <= header?.endedAt);
  return { checks, failedChecks: Object.keys(checks).filter(key => !checks[key].pass) };
}

async function verifyNative(task, proof, { createRemote = t => new ZCodeRemote(readBinding(t.zcodeConfig)),
  createConversation = (remote, session) => new Conversation(remote, session) } = {}) {
  const diagnosticFile = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-native-verification-${crypto.randomUUID()}.json`);
  const record = { protocol: 1, ...proof.expected, attemptId: task.submission.attemptId, sourceHashes: proof.hashes,
    expectedTurn: proof.observation.result, createdAt: now(), stage: 'prepared', status: 'prepared', historyPages: [] };
  const persist = () => {
    requireProof(Buffer.byteLength(JSON.stringify(record)) <= 2 * 1024 * 1024, 'native diagnostic exceeds bounded size');
    writeJsonAtomic(diagnosticFile, record);
  };
  persist();
  let remote, conversation, native, failure;
  try {
    record.stage = 'connect'; persist();
    remote = createRemote(task); remote.on('fault', () => {});
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    record.stage = 'inbox'; persist();
    const ack = await queryAdmission(remote, proof.command.envelope, { attempts: 1 });
    record.queryAck = ack; persist();
    // Query ACKs may omit the optional result; retain the original rich ACK and require fresh terminal proof below. / 查询ACK可省略可选result，保留原始完整ACK且仍须通过下方新鲜终态证明。
    const detailed = Object.hasOwn(ack, 'result');
    requireProof(ack.commandId === proof.expected.commandId && ['accepted', 'duplicate'].includes(ack.status)
      && Number.isSafeInteger(ack.revisionAtDecision) && ack.revisionAtDecision >= 0
      && ack.revisionAtDecision === proof.command.ack.revisionAtDecision
      && (!detailed || ack.result?.type === 'inputAccepted' && ack.result.inputId === proof.expected.commandId
        && ack.result.delivery === proof.command.ack.result.delivery), 'native inbox did not confirm this input');
    record.stage = 'subscribe'; persist();
    conversation = createConversation(remote, task.workerSessionId); await conversation.subscribe();
    const snapshot = structuredClone(conversation.snapshot);
    record.snapshotBefore = snapshotEvidence(snapshot); record.stage = 'quiescent-before'; persist();
    readiness.assertQuiescent(task, snapshot);
    record.stage = 'resolve-turn'; persist();
    const readOnlyHistory = { target: remote.target, call: async (channel, method, params) => {
      const response = await remote.call(channel, method, params);
      record.historyPages.push({ atSeq: response.atSeq, atLogEpoch: response.atLogEpoch, hasMore: response.hasMore,
        beforeRowId: params.beforeRowId, rowCount: response.rows?.length,
        headers: response.rows?.filter(row => row.kind === 'turnHeader') });
      persist(); return response;
    } };
    const rebuilt = snapshot.logEpoch !== proof.observation.result.logEpoch;
    record.proofMode = rebuilt ? 'rebuilt-history' : 'same-epoch';
    // A new generation must read authoritative history even if its tail already contains the header. / 新代际即使尾窗已有轮次头，也必须读取权威历史。
    const historySnapshot = rebuilt ? { ...snapshot, rows: { ...snapshot.rows, window: [] } } : snapshot;
    const turn = await resolveTurn(readOnlyHistory, historySnapshot, proof.expected.commandId, { headerRowId: proof.observation.result.headerRowId });
    record.turn = turn; record.turnSha256 = hash(JSON.stringify(turn));
    record.historicalComparison = terminalComparison(proof, turn);
    Object.assign(record, rebuilt ? rebuiltTerminalComparison(proof, turn, snapshot) : record.historicalComparison);
    record.stage = 'terminal-comparison'; persist();
    requireProof(record.failedChecks.length === 0,
      'fresh native terminal does not match persisted evidence: ' + record.failedChecks.join(', '));
    if (rebuilt) {
      record.stage = 'confirm-rebuilt-history'; persist();
      const confirmed = await resolveTurn(readOnlyHistory, historySnapshot, proof.expected.commandId, { headerRowId: turn.header.rowId });
      record.confirmedTurn = confirmed; persist();
      requireProof(confirmed.seen && confirmed.terminal && confirmed.state === 'completedSuccess'
        && confirmed.logEpoch === turn.logEpoch && Number.isSafeInteger(confirmed.seq) && confirmed.seq >= turn.seq
        && hash(JSON.stringify(confirmed.header)) === hash(JSON.stringify(turn.header)), 'rebuilt terminal changed during verification');
    }
    record.snapshotAfter = snapshotEvidence(conversation.snapshot); record.stage = 'quiescent-after'; persist();
    readiness.assertQuiescent(task, conversation.snapshot);
    requireProof(conversation.snapshot.logEpoch === snapshot.logEpoch && conversation.snapshot.seq >= snapshot.seq, 'native snapshot regressed');
    native = { ack, queryAckKind: detailed ? 'detailed' : 'summary', turn, proofMode: record.proofMode, checkedAt: now(), diagnosticFile };
  } catch (error) { failure = error; }
  finally {
    if (conversation?.snapshot) record.snapshotAtDetach = snapshotEvidence(conversation.snapshot);
    try { await conversation?.dispose(); } catch (error) { failure ||= error; record.disposeUnconfirmed = true; }
    try { await remote?.close(); } catch (error) { failure ||= error; record.closeUnconfirmed = true; }
    record.finishedAt = now(); record.status = failure ? 'rejected-or-unconfirmed' : 'verified';
    // Persist only fixed categories for remote exceptions; raw terminal evidence stays in the private record. / 远端异常只保存固定分类，原始终态证据保留在私有记录。
    if (failure) record.error = { category: failure.message?.startsWith('ZCode reconciliation refused:') ? failure.message : 'native-verification-unavailable' };
    persist();
  }
  if (failure) { failure.diagnosticFile = diagnosticFile; failure.failedChecks = record.failedChecks || []; throw failure; }
  return native;
}

async function checkLocal(task, proof, { inspect = agentInfo, inspectPane = paneInfo, call = api, alive = processAlive,
  prove = require('./windows-worker-process').proveWorkerProcess } = {}) {
  requireProof(!task.watcherPid || !alive(task.watcherPid), 'another observer is active');
  requireProof(!taskList(task.stateDir).some(t => t.id !== task.id && t.agent === 'zcode'
    && t.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(t.status)), 'native session has another unresolved owner');
  const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
  const pane = inspectPane(task.herdrSession, task.paneId);
  requireProof(agent.pane_id === task.paneId && pane?.pane_id === task.paneId && pane.terminal_id === task.terminalId
    && ['idle', 'done'].includes(agent.agent_status) && Number.isSafeInteger(agent.state_change_seq)
    && agent.state_change_seq >= 0, 'current Pane is not the idle bound wrapper');
  const processInfo = resultPayload(call(task.herdrSession, ['pane', 'process-info', '--pane', task.paneId]))?.process_info;
  const processProof = await prove({ kind: 'zcode-wrapper', processInfo, expectedPid: proof.state.workerPid,
    executablePath: process.execPath, scriptPath: path.join(config().root, 'bin', 'zcode-worker.js') });
  requireProof(processProof.pid === proof.state.workerPid && Number.isFinite(Date.parse(processProof.processStartedAt))
    && Math.abs(Date.parse(processProof.processStartedAt) - Date.parse(proof.state.workerProcessStartedAt)) <= 5000, 'wrapper process changed');
  const fresh = inspectLocal(loadTask(task.id));
  requireProof(JSON.stringify(fresh.hashes) === JSON.stringify(proof.hashes), 'local evidence changed during reconciliation');
  return { processProof, stateChangeSeq: agent.state_change_seq };
}

async function recover(task, dependencies = {}) {
  const { verify = verifyNative } = dependencies;
  const proof = inspectLocal(task);
  const before = await checkLocal(task, proof, dependencies), native = await verify(task, proof), after = await checkLocal(task, proof, dependencies);
  requireProof(before.processProof.pid === after.processProof.pid && before.processProof.processStartedAt === after.processProof.processStartedAt
    && before.stateChangeSeq === after.stateChangeSeq, 'worker changed during reconciliation');
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-reconciliation-${crypto.randomUUID()}.json`);
  writeJsonAtomic(file, { protocol: 1, ...proof.expected, attemptId: task.submission.attemptId,
    sourceHashes: proof.hashes, processProof: after.processProof, native, at: now(), transportOutcome: 'unchanged-uncertain' });
  task.submission = { ...task.submission, status: 'observed', reconciledFrom: 'uncertain', reconciliationFile: file,
    nativeReceipt: { commandId: proof.expected.commandId, status: native.ack.status, source: 'native-inbox-and-terminal' } };
  task.status = 'review_pending'; task.error = null; delete task.blocker; task.watcherPid = null;
  task.settlementSeq = (task.settlementSeq || 0) + 1;
  task.history.push({ round: task.round, status: 'review_pending', timestamp: now(), source: 'zcode-native-reconciliation' });
  saveTask(task); require('./worker-context').recordContext(task); event(task, 'zcode_submission_reconciled', { commandId: proof.expected.commandId });
  return task;
}

// Diagnostics preserve the exact RPC response privately, never headers, bindings or credentials. / 诊断仅私有保存精确RPC响应，不采集头部、绑定配置或凭据。
async function diagnose(task, dependencies = {}) {
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-admission-diagnostic.json`);
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireProof(previous.taskId === task.id && previous.round === task.round && previous.sessionId === task.workerSessionId
      && previous.attemptId === task.submission?.attemptId, 'existing diagnostic belongs to another input');
    return { taskId: task.id, file, status: previous.status, reused: true, connected: false };
  }
  const proof = inspectLocal(task), before = await checkLocal(task, proof, dependencies);
  const record = { protocol: 1, ...proof.expected, attemptId: task.submission.attemptId, sourceHashes: proof.hashes,
    before, status: 'prepared', createdAt: now(), response: null, taskMutated: false };
  // Reserve once before connecting. A crash/unknown result must not trigger another query. / 连接前一次性占位，崩溃或未知结果不得触发再次查询。
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  let remote;
  try {
    remote = (dependencies.createRemote || (t => new ZCodeRemote(readBinding(t.zcodeConfig))))(task);
    remote.on('fault', () => {});
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    const response = await remote.query(proof.command.envelope);
    const raw = JSON.stringify(response);
    requireProof(typeof raw === 'string' && Buffer.byteLength(raw) <= 1024 * 1024, 'diagnostic response invalid or too large');
    record.response = response; record.responseSha256 = hash(raw); record.receivedAt = now(); record.status = 'captured';
    writeJsonAtomic(file, record);
  } catch (error) {
    record.status = 'query_failed_or_unconfirmed';
    // Raw exception messages may contain remote text; retain only safe diagnostic categories. / 原始异常可能含远端文本，仅保存安全诊断分类。
    record.error = { code: ['ZCODE_RELAY_LOCAL_BUSY', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code) ? error.code : 'QUERY_UNCONFIRMED' };
  } finally {
    try { await remote?.close(); } catch { record.closeUnconfirmed = true; }
    try {
      record.after = await checkLocal(task, proof, dependencies);
      record.localEvidenceStable = before.processProof.pid === record.after.processProof.pid
        && before.processProof.processStartedAt === record.after.processProof.processStartedAt
        && before.stateChangeSeq === record.after.stateChangeSeq;
    } catch { record.localEvidenceStable = false; }
    record.finishedAt = now(); writeJsonAtomic(file, record);
  }
  return { taskId: task.id, file, status: record.status, responseSha256: record.responseSha256,
    localEvidenceStable: record.localEvidenceStable, taskMutated: false };
}

// This one-shot terminal diagnostic never invokes recovery or changes task state. / 单次终态诊断不调用恢复、不改变任务状态。
async function diagnoseTerminal(task, dependencies = {}) {
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-terminal-diagnostic.json`);
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireProof(previous.taskId === task.id && previous.round === task.round && previous.sessionId === task.workerSessionId
      && previous.attemptId === task.submission?.attemptId, 'existing terminal diagnostic belongs to another input');
    return { taskId: task.id, file, status: previous.status, nativeDiagnosticFile: previous.nativeDiagnosticFile,
      failedChecks: previous.failedChecks, nativeChecksPassed: previous.nativeChecksPassed, reused: true, connected: false };
  }
  const proof = inspectLocal(task), before = await checkLocal(task, proof, dependencies);
  const record = { protocol: 1, ...proof.expected, attemptId: task.submission.attemptId, sourceHashes: proof.hashes,
    before, status: 'prepared', createdAt: now(), taskMutated: false };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  try {
    const native = await (dependencies.verify || verifyNative)(task, proof);
    record.nativeDiagnosticFile = native.diagnosticFile; record.nativeChecksPassed = true; record.failedChecks = [];
  } catch (error) {
    record.nativeDiagnosticFile = error.diagnosticFile; record.nativeChecksPassed = false; record.failedChecks = error.failedChecks || [];
  } finally {
    record.status = record.nativeDiagnosticFile ? 'captured' : 'unconfirmed';
    if (record.nativeDiagnosticFile) {
      const bytes = fs.readFileSync(record.nativeDiagnosticFile), native = JSON.parse(bytes);
      record.nativeDiagnosticSha256 = hash(bytes); record.stage = native.stage; record.terminalCaptured = Boolean(native.turn);
    }
    try {
      record.after = await checkLocal(task, proof, dependencies);
      record.localEvidenceStable = before.processProof.pid === record.after.processProof.pid
        && before.processProof.processStartedAt === record.after.processProof.processStartedAt
        && before.stateChangeSeq === record.after.stateChangeSeq;
    } catch { record.localEvidenceStable = false; }
    record.finishedAt = now(); writeJsonAtomic(file, record);
  }
  return { taskId: task.id, file, status: record.status, nativeDiagnosticFile: record.nativeDiagnosticFile,
    nativeDiagnosticSha256: record.nativeDiagnosticSha256, stage: record.stage, terminalCaptured: record.terminalCaptured,
    nativeChecksPassed: record.nativeChecksPassed, failedChecks: record.failedChecks,
    localEvidenceStable: record.localEvidenceStable, taskMutated: false };
}

module.exports = { inspectLocal, verifyNative, recover, diagnose, diagnoseTerminal, terminalComparison };
