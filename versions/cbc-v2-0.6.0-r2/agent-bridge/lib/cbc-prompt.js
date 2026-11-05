'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { api, resultPayload } = require('./herdr');
const { config, readJson, sleep } = require('./util');
const { leaseForEvent } = require('./worker-lease');
const { proveWorkerProcess } = require('./windows-worker-process');

const NATIVE_BOUNDARY_HOOKS = new Set(['SessionStart', 'Stop']);
const SAFE_GUARD_STAGES = new Set(['preflight', 'task-binding', 'native-lease', 'pane-agent-read',
  'pane-inventory', 'pane-process-info', 'visible-pane-read', 'native-metadata', 'pane-ownership', 'native-hook-read',
  'executable-resolution', 'process-query', 'target-process-query', 'process-proof',
  'preflight-stability', 'pane-run']);
const SAFE_PROCESS_PROOF_CODES = new Set(['query-timeout', 'query-access-denied', 'query-unavailable',
  'query-failed', 'query-unreadable', 'process-missing-or-unreadable', 'process-identity-changed', 'identity-unconfirmed']);
const DIALOG_PATTERN = /permission required|needs? (?:your )?approval|approve (?:this|the)|allow once|always allow|trust (?:this|the) folder|do you trust|do you want to (?:allow|approve)|select (?:a |an )?(?:model|option)|choose (?:an? )?option|\[y\s*\/\s*n\]|press (?:enter|y) to (?:confirm|continue)/i;

function reject(reason, { guardStage = 'preflight', processProofCode } = {}) {
  const error = new Error(`CBC guarded prompt preflight refused (${reason}); no input was sent`);
  error.code = 'CBC_PROMPT_GUARD_REJECTED';
  error.origin = 'bridge-preflight';
  error.requestSent = false;
  error.guardStage = SAFE_GUARD_STAGES.has(guardStage) ? guardStage : 'preflight';
  if (SAFE_PROCESS_PROOF_CODES.has(processProofCode)) error.processProofCode = processProofCode;
  return error;
}

function guardDiagnostics(error) {
  if (error?.code !== 'CBC_PROMPT_GUARD_REJECTED') return {};
  return { ...(SAFE_GUARD_STAGES.has(error.guardStage) ? { guardStage: error.guardStage } : {}),
    ...(SAFE_PROCESS_PROOF_CODES.has(error.processProofCode) ? { processProofCode: error.processProofCode } : {}),
    ...([1, 2].includes(error.preflightReadAttempts) ? { preflightReadAttempts: error.preflightReadAttempts } : {}) };
}

function unknownOutcome(kind, cause) {
  const error = new Error('CBC pane.run receipt was lost or inconclusive; inspect the native Pane and do not resend');
  error.code = 'CBC_PROMPT_OUTCOME_UNKNOWN';
  error.origin = 'guarded-pane-run';
  error.requestSent = true;
  error.guardStage = 'pane-run';
  // Preserve only bounded diagnostic fields, never raw stderr or prompt text. / 仅保留有界诊断字段，不保存原始stderr或提示正文。
  error.transportDiagnostic = { phase: 'pane-run', outcome: kind,
    code: /^[A-Z][A-Z0-9_]{1,50}$/.test(cause?.code || '') ? cause.code : null,
    herdrCode: /^[a-z][a-z0-9_]{1,50}$/.test(cause?.herdrCode || '') ? cause.herdrCode : null,
    exitCode: Number.isSafeInteger(cause?.status) ? cause.status : null };
  return error;
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveCbcExecutable(binary, { exists = fs.existsSync, realpath = fs.realpathSync,
  isFile = file => fs.statSync(file).isFile(), readShim = file => fs.readFileSync(file, 'utf8'),
  nodeExecutable } = {}) {
  if (typeof binary !== 'string' || !binary.trim()) throw new Error('CBC executable is not configured');
  const configured = path.resolve(binary);
  if (!exists(configured) || !isFile(configured)) throw new Error('CBC executable is unavailable');
  if (!/\.(?:cmd|bat)$/i.test(configured)) {
    return { executablePath: realpath(configured), scriptPath: null };
  }
  let cursor = path.dirname(configured), nodeModules = null;
  for (;;) {
    if (path.basename(cursor).toLowerCase() === 'node_modules') { nodeModules = cursor; break; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (typeof nodeExecutable !== 'string' || !nodeExecutable.trim()) {
    throw new Error('CBC npm shim Node executable is not pinned');
  }
  const packageRoots = [
    ...(nodeModules ? [nodeModules] : []),
    path.join(path.dirname(configured), 'node_modules'),
  ];
  let shim;
  try { shim = readShim(configured).replace(/\//g, '\\').toLowerCase(); }
  catch { throw new Error('CBC npm shim could not be inspected'); }
  for (const packageRoot of [...new Set(packageRoots)]) {
    const script = path.join(packageRoot, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
    if (!exists(script) || !isFile(script)) continue;
    const relative = path.relative(path.dirname(configured), script).replace(/\//g, '\\').toLowerCase();
    if (!relative || !shim.includes(relative)) continue;
    return { executablePath: realpath(nodeExecutable), scriptPath: realpath(script) };
  }
  throw new Error('CBC npm shim target is not the known CodeBuddy package script');
}

function nativeCbcBinary(task, deps) {
  if (task.cbcNativeBinary) return task.cbcNativeBinary;
  if (deps.cbcNativeBinary) return deps.cbcNativeBinary;
  const launch = task.cbcBinary || deps.cbcBinary || config().cbc;
  if (typeof launch !== 'string' || !launch.trim()) throw new Error('CBC launch path is not configured');
  if (/\.(?:cmd|bat)$/i.test(launch)) return launch;
  if (/\.ps1$/i.test(launch)) {
    const appData = deps.appData || process.env.APPDATA;
    if (!appData) throw new Error('Known npm CBC shim path is unavailable');
    return path.join(appData, 'npm', 'cbc.cmd');
  }
  if (/\.exe$/i.test(launch)) return launch;
  throw new Error('CBC launch path is not a recognized native entry point');
}

function parseHookEvents(task, readEvents = null) {
  if (readEvents) return readEvents(task);
  if (task.taskProtocol === 2) return require('./cbc-executor-evidence').read(task);
  const file = path.join(task.stateDir, 'hook-events.ndjson');
  if (!fs.existsSync(file)) throw reject('native Hook evidence is missing');
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { throw reject('native Hook journal is malformed'); }
    if (item && typeof item === 'object') events.push(item);
  }
  return events;
}

function readStoredTask(task, taskId = task.id, readTask = null) {
  if (readTask) return readTask(task, taskId);
  const directory = path.join(task.stateDir, 'tasks', taskId);
  return readJson(path.join(directory, 'task.json'), null);
}

function hookBoundary(task, events, sourceTask) {
  const sessionEvents = events.filter(item => item?.herdrSession === task.herdrSession
    && item?.sessionId === task.workerSessionId
    && !(task.taskProtocol === 2 && item.name === 'Notification' && item.notificationType === 'idle_prompt'));
  const latest = sessionEvents.at(-1);
  if (!latest || latest.identityBound !== true || !NATIVE_BOUNDARY_HOOKS.has(latest.name)
      || latest.paneId !== task.paneId || latest.terminalId !== task.terminalId) {
    throw reject('latest native Hook is not an exact idle boundary');
  }
  const current = latest.taskId === task.id && latest.round === task.round - 1
    && validAfter(latest.timestamp, task.workerStartedAt);
  const reused = sourceTask && latest.taskId === sourceTask.id && latest.round === sourceTask.round
    && validAfter(latest.timestamp, sourceTask.workerStartedAt);
  if (!current && !reused) throw reject('native Hook belongs to another task round');
  return latest;
}

function validAfter(timestamp, startedAt) {
  const eventTime = Date.parse(timestamp), startTime = Date.parse(startedAt);
  return Number.isFinite(eventTime) && Number.isFinite(startTime) && eventTime >= startTime;
}

function agentSignature(agent) {
  return JSON.stringify({
    paneId: agent.pane_id,
    agent: agent.agent,
    name: agent.name || null,
    terminalId: agent.terminal_id,
    sessionId: agent.agent_session?.value || null,
    status: agent.agent_status,
    completionSeq: agent.completion_seq ?? null,
    stateChangeSeq: agent.state_change_seq ?? null,
  });
}

function optionalNativeReference(record) {
  if (record.agent_session == null) return null;
  if (typeof record.agent_session?.value !== 'string' || !record.agent_session.value) {
    throw reject('native session reference is malformed');
  }
  return record.agent_session.value;
}

function stableSequence(agent, task) {
  const completion = agent.completion_seq;
  const stateChange = agent.state_change_seq;
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (completion != null && (!valid(completion) || completion !== task.submission.baselineCompletion)) {
    throw reject('completion evidence changed before input');
  }
  if (stateChange != null && !valid(stateChange)) throw reject('state transition sequence is malformed');
  if (completion == null && (!valid(stateChange) || task.submission.baselineCompletion !== 0)) {
    throw reject('state stability evidence is unavailable');
  }
  if (task.submission.baselineStateChange != null && stateChange !== task.submission.baselineStateChange) {
    throw reject('state transition changed before input');
  }
  // A state transition is not a completed turn. / 状态变化序号不代表回合完成。
}

function hookSignature(hook) {
  return JSON.stringify({ name: hook.name, source: hook.source, taskId: hook.taskId, round: hook.round,
    sessionId: hook.sessionId, herdrSession: hook.herdrSession, paneId: hook.paneId,
    terminalId: hook.terminalId, timestamp: hook.timestamp, identityBound: hook.identityBound });
}

function payload(response) { return resultPayload(response) || {}; }

function readVisibleText(response) {
  const value = payload(response);
  if (typeof response === 'string') return response;
  return value?.read?.text ?? value?.text ?? value?.content ?? null;
}

function processInfoPayload(response) {
  const value = payload(response);
  return value?.process_info ?? value?.processInfo ?? value;
}

function checkDialog(text) {
  if (typeof text !== 'string' || !text.trim()) throw reject('visible Pane content is unavailable');
  if (DIALOG_PATTERN.test(text.split(/\r?\n/).slice(-40).join('\n'))) throw reject('visible approval or dialog is present');
}

function validateTask(task, saved) {
  if (!task || task.agent !== 'cbc' || typeof task.id !== 'string' || !/^[a-z][a-z0-9-]{2,47}$/.test(task.id)
      || !task.stateDir || !task.herdrSession || !task.paneId || !task.terminalId || !task.workerSessionId
      || !Number.isSafeInteger(task.round) || task.round < 1 || !task.workerStartedAt
      || task.status !== 'running' || task.submission?.status !== 'sending'
      || typeof task.submission.attemptId !== 'string' || !task.submission.attemptId
      || !Number.isSafeInteger(task.submission.baselineCompletion)) throw reject('task is not in its persisted sending round');
  if (!saved || saved.id !== task.id || saved.agent !== 'cbc' || !samePath(saved.stateDir, task.stateDir)
      || saved.herdrSession !== task.herdrSession || saved.paneId !== task.paneId
      || saved.terminalId !== task.terminalId || saved.workerSessionId !== task.workerSessionId
      || saved.cbcBinary !== task.cbcBinary || saved.cbcNativeBinary !== task.cbcNativeBinary
      || saved.nodeExecutable !== task.nodeExecutable
      || saved.workerStartedAt !== task.workerStartedAt || saved.workerPid !== task.workerPid
      || saved.agentName !== task.agentName || saved.reusedFromTaskId !== task.reusedFromTaskId
      || saved.round !== task.round || saved.status !== task.status
      || saved.submission?.status !== task.submission.status
      || saved.submission?.attemptId !== task.submission.attemptId
      || saved.submission?.baselineCompletion !== task.submission.baselineCompletion
      || saved.submission?.baselineStateChange !== task.submission.baselineStateChange) {
    throw reject('persisted task binding changed');
  }
}

function validateLease(task, lease) {
  if (!lease || lease.taskId !== task.id || lease.herdrSession !== task.herdrSession
      || lease.paneId !== task.paneId || lease.terminalId !== task.terminalId
      || lease.workerSessionId !== task.workerSessionId || lease.workerStartedAt !== task.workerStartedAt) {
    throw reject('Pane lease does not match the task and native session');
  }
}

function sourceTaskIfAllowed(task, readTask) {
  if (!task.reusedFromTaskId) return null;
  const source = readStoredTask(task, task.reusedFromTaskId, readTask);
  if (!source || source.id !== task.reusedFromTaskId || !['accepted', 'cancelled'].includes(source.status)
      || source.agent !== 'cbc' || source.herdrSession !== task.herdrSession || source.paneId !== task.paneId
      || source.terminalId !== task.terminalId || source.workerSessionId !== task.workerSessionId) {
    throw reject('reused native session source is not settled and exactly bound');
  }
  return source;
}

async function inspect(task, deps) {
  let stage = 'task-binding';
  try {
    const saved = readStoredTask(task, task.id, deps.readTask);
    validateTask(task, saved);
    stage = 'native-lease';
    const lease = (deps.readLease || leaseForEvent)(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
    validateLease(task, lease);

    const call = deps.call || api;
    stage = 'pane-agent-read';
    const pane = payload(await call(task.herdrSession, ['pane', 'get', task.paneId])).pane;
    const agent = payload(await call(task.herdrSession, ['agent', 'get', task.paneId])).agent;
    stage = 'pane-inventory';
    const paneInventory = payload(await call(task.herdrSession, ['pane', 'list'])).panes;
    const agentInventory = payload(await call(task.herdrSession, ['agent', 'list'])).agents;
    stage = 'pane-process-info';
    const processInfo = processInfoPayload(await call(task.herdrSession, ['pane', 'process-info', '--pane', task.paneId]));
    stage = 'visible-pane-read';
    const visible = readVisibleText(await call(task.herdrSession, ['pane', 'read', task.paneId, '--source', 'visible']));
    checkDialog(visible);
    stage = 'native-metadata';
    if (!pane || pane.pane_id !== task.paneId || pane.terminal_id !== task.terminalId
        || !agent || agent.pane_id !== task.paneId || agent.agent !== 'codebuddy'
        || agent.terminal_id !== task.terminalId
        || (task.agentName && agent.name !== task.agentName)
        || !['idle', 'done'].includes(agent.agent_status)
        || !Array.isArray(paneInventory) || !Array.isArray(agentInventory)) {
      throw reject('native Pane or agent state is not ready and exactly bound');
    }
    stableSequence(agent, task);
    stage = 'pane-ownership';
    const paneOwners = paneInventory.filter(item => item?.pane_id === task.paneId);
    const terminalOwners = paneInventory.filter(item => item?.terminal_id === task.terminalId);
    const agentAtPane = agentInventory.filter(item => item?.pane_id === task.paneId);
    if (paneOwners.length !== 1 || paneOwners[0].terminal_id !== task.terminalId
        || terminalOwners.length !== 1 || agentAtPane.length !== 1
        || agentSignature(agentAtPane[0]) !== agentSignature(agent)) {
      throw reject('native Pane ownership inventory is incomplete or ambiguous');
    }
    for (const record of [pane, agent, ...paneInventory, ...agentInventory]) {
      const native = optionalNativeReference(record);
      const sameTerminal = record.pane_id === task.paneId || record.terminal_id === task.terminalId;
      if (native && (sameTerminal && native !== task.workerSessionId
          || native === task.workerSessionId && (record.pane_id !== task.paneId || record.terminal_id !== task.terminalId))) {
        throw reject('native session reference conflicts with the bound worker');
      }
    }

    stage = 'native-hook-read';
    const events = parseHookEvents(task, deps.readEvents);
    const latestTerminalHook = events.filter(item => item?.herdrSession === task.herdrSession
      && item?.paneId === task.paneId && item?.terminalId === task.terminalId).at(-1);
    if (!latestTerminalHook || latestTerminalHook.sessionId !== task.workerSessionId) {
      throw reject('latest terminal Hook belongs to another native session');
    }
    const latestSessionHook = events.filter(item => item?.herdrSession === task.herdrSession
      && item?.sessionId === task.workerSessionId).at(-1);
    const currentBoundary = latestSessionHook?.identityBound === true
      && NATIVE_BOUNDARY_HOOKS.has(latestSessionHook.name) && latestSessionHook.taskId === task.id
      && latestSessionHook.round === task.round - 1 && latestSessionHook.paneId === task.paneId
      && latestSessionHook.terminalId === task.terminalId
      && validAfter(latestSessionHook.timestamp, task.workerStartedAt);
    const source = currentBoundary ? null : sourceTaskIfAllowed(task, deps.readTask);
    const hook = hookBoundary(task, events, source);
    stage = 'executable-resolution';
    const binary = nativeCbcBinary(task, deps);
    const resolveOptions = { ...(deps.resolveCbcOptions || {}),
      nodeExecutable: deps.resolveCbcOptions?.nodeExecutable || deps.nodeExecutable || task.nodeExecutable || process.execPath };
    const cbc = (deps.resolveCbcExecutable || resolveCbcExecutable)(binary, resolveOptions);
    stage = 'process-proof';
    const proof = await (deps.proveProcess || proveWorkerProcess)({
      kind: 'cbc', processInfo, executablePath: cbc.executablePath, scriptPath: cbc.scriptPath,
      expectedPid: task.workerPid,
    }, { platform: deps.platform, readDescendants: deps.readDescendants,
      readCommandLine: deps.readCommandLine, spawnSyncFn: deps.spawnSyncFn });
    if (!proof || proof.kind !== 'cbc' || !Number.isSafeInteger(proof.pid)
        || !Number.isSafeInteger(proof.shellPid) || !proof.processStartedAt) {
      throw reject('CBC foreground process proof is incomplete', { guardStage: stage });
    }
    if (!validAfter(hook.timestamp, proof.processStartedAt)) {
      throw reject('native Hook predates the current CBC process', { guardStage: stage });
    }
    return { hook, hookFingerprint: hookSignature(hook), agentFingerprint: agentSignature(agent),
      completionSeq: agent.completion_seq ?? null, proof, proofFingerprint: JSON.stringify(proof) };
  } catch (error) {
    if (error?.code === 'CBC_PROMPT_GUARD_REJECTED') {
      if (error.guardStage === 'preflight' || !SAFE_GUARD_STAGES.has(error.guardStage)) error.guardStage = stage;
      throw error;
    }
    throw reject('read-only identity verification failed', {
      guardStage: error?.guardStage || stage,
      processProofCode: error?.processProofCode,
    });
  }
}

async function submit(task, text, deps = {}) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 128 * 1024) {
    throw reject('prompt text is empty or exceeds the safe size limit');
  }
  let before, after, preflightReadAttempts = 0;
  for (;;) {
    try {
      preflightReadAttempts++;
      before = await inspect(task, deps);
      after = await inspect(task, deps);
      if (before.hookFingerprint !== after.hookFingerprint
          || before.agentFingerprint !== after.agentFingerprint
          || before.completionSeq !== after.completionSeq
          || before.proofFingerprint !== after.proofFingerprint) {
        throw reject('native Hook, agent, completion, or process identity changed during preflight', { guardStage: 'preflight-stability' });
      }
      break;
    } catch (error) {
      // Retry one timed-out read before any write, restarting both full checks. / 仅在写入前重试一次超时读取，重新进行两次完整校验。
      if (error?.code === 'CBC_PROMPT_GUARD_REJECTED' && error.processProofCode === 'query-timeout'
          && ['process-query', 'target-process-query'].includes(error.guardStage) && preflightReadAttempts === 1) {
        await (deps.pause || sleep)(250); continue;
      }
      const failure = error?.code === 'CBC_PROMPT_GUARD_REJECTED' ? error : reject('read-only identity verification failed');
      failure.preflightReadAttempts = preflightReadAttempts;
      throw failure;
    }
  }

  const call = deps.call || api;
  let receipt;
  if (task.cbcTurnProtocol === 1) {
    try { require('./submission-attempt').update(task.submission, 'sending', { processProof: after.proof }); }
    catch { throw reject('native process proof could not be persisted before input'); }
  }
  // Native reads and pane.run are separate RPCs; a dialog may appear between the final check and input. / 原生读取与pane.run属于不同RPC，最终核验后仍可能出现对话框。
  try { receipt = await (deps.paneRun || ((session, pane, prompt) => call(session, ['pane', 'run', pane, prompt],
    { includeTransportReceipt: true })))(
    task.herdrSession, task.paneId, text); }
  catch (error) { throw unknownOutcome('transport-error', error); }
  const cliReceipt = receipt?.transport === 'herdr-cli';
  const response = cliReceipt ? receipt.response : receipt;
  if (cliReceipt && (receipt.exitCode !== 0 || !Object.hasOwn(receipt, 'response')) || !cliReceipt && receipt == null
      || response?.error || response?.result?.error || response?.ok === false || response?.result?.ok === false) {
    throw unknownOutcome(receipt == null ? 'empty-response' : 'negative-response');
  }
  return {
    status: 'text_queued',
    transport: 'guarded-pane',
    inputAccepted: true,
    nativeAcceptanceConfirmed: false,
    requestSent: true,
    transportAcknowledgement: cliReceipt ? { transport: 'herdr-cli', exitCode: 0, emptyStdout: response == null } : null,
    processProof: after.proof,
    guard: { nativeSnapshotStableBeforeInput: true, checkSendAtomic: false, preflightReadAttempts },
  };
}

function readSubmissionActivity(task) {
  if (task.agent !== 'cbc' || !['sending', 'observed'].includes(task.submission?.status)) return null;
  const submitted = task.history?.findLast(item => item.round === task.round && item.status === 'submitted');
  const events = parseHookEvents(task);
  const latest = events.filter(item => item?.herdrSession === task.herdrSession
    && item?.paneId === task.paneId && item?.terminalId === task.terminalId).at(-1);
  if (!latest || latest.identityBound !== true || latest.sessionId !== task.workerSessionId
      || latest.taskId !== task.id || latest.round !== task.round
      || !['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(latest.name)
      || !validAfter(latest.timestamp, submitted?.timestamp)
      || !validAfter(latest.timestamp, task.workerStartedAt)) return null;
  // This proves current-round activity, not payload acceptance or technical completion. / 仅证明本轮原生活动，不证明特定正文接纳或技术完成。
  return { source: 'cbc-native-hook', name: latest.name, round: latest.round, timestamp: latest.timestamp };
}

module.exports = { submit, resolveCbcExecutable, nativeCbcBinary, hookBoundary, checkDialog, readSubmissionActivity, guardDiagnostics };
