#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  config, ensureDir, event, loadTask, makeTaskId, now, processAlive,
  readJson, saveTask, sleep, taskDir, withLock,
} = require('../lib/util');
const {
  agentInfo, api, ensureServer, paneInfo, resultPayload, startWatcher,
} = require('../lib/herdr');
const { getAgent, listAgents, chooseAgentName } = require('../lib/agents');
const { assertWorker, updateWorkerSession } = require('../lib/worker');
const { placementFor, createLocation } = require('../lib/location');
const { writeWorkerPolicy, normalizeTaskSpec, renderRoundInstructions, renderSubmissionPointer } = require('../lib/worker-policy');
const { recordContext, preparePromptContext, tryReuseContext, listContexts, observedContext } = require('../lib/worker-context');
const { writeLease } = require('../lib/worker-lease');
const { bindingKey } = require('../lib/worker-binding');
const { assertSingleActive } = require('../lib/worker-scheduling');

function missingWorker(error) {
  return ['agent_not_found', 'pane_not_found', 'agent_not_registered'].includes(error.herdrCode);
}

function parse(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['json', 'force', 'retry-failed', 'trust-folder', 'no-skip-permissions', 'resend-notification', 'new-workspace', 'new-session', 'full-context', 'parallel'].includes(key)) options[key] = true;
    else options[key] = argv[++i];
  }
  return options;
}

function required(value, name) {
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function promptFrom(options) {
  if (options['prompt-file']) return fs.readFileSync(path.resolve(options['prompt-file']), 'utf8').trim();
  if (options.prompt) return String(options.prompt).trim();
  throw new Error('Provide --prompt-file or --prompt');
}

function readText(session, args) {
  const response = api(session, args, { timeout: 20000 });
  if (typeof response === 'string') return response;
  const payload = resultPayload(response);
  return payload?.read?.text || payload?.text || JSON.stringify(response);
}

function paneText(session, paneId) {
  return readText(session, ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '160'])
    || readText(session, ['pane', 'read', paneId, '--source', 'visible', '--lines', '60']);
}

function agentText(session, paneId) {
  return readText(session, ['agent', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '240']);
}

function detectCodexThread(session) {
  if (process.env.CODEX_THREAD_ID) return process.env.CODEX_THREAD_ID;
  if (!process.env.HERDR_PANE_ID) return null;
  try {
    const pane = paneInfo(session, process.env.HERDR_PANE_ID);
    return pane.agent_session?.value || null;
  } catch {
    return null;
  }
}

async function waitForAgent(task, desired, timeoutMs, baselineCompletion) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (task.taskProtocol === 2 && baselineCompletion !== undefined) {
        // Reconcile delayed native writes before asking the UI for liveness. / UI活性检查前先对账延迟落盘的原生接纳。
        const layers = await require('../lib/cbc-protocol-v2').reconcileEvidence(task);
        if (layers.conflicts.length) throw Object.assign(new Error('CBC request evidence conflicts; no replay'), { code: 'CBC_TURN_SUPERSEDED' });
        if (layers.transport === 'admitted') return { source: 'request-evidence', layers };
      }
      const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      last = agent;
      if (baselineCompletion !== undefined && task.agent === 'cbc' && task.cbcTurnProtocol === 1) {
        const turn = require('../lib/cbc-turn').readTurn(task);
        if (turn.state === 'superseded') throw Object.assign(new Error('CBC received another native input; do not replay this round'), { code: 'CBC_TURN_SUPERSEDED' });
        if (['active', 'stopped', 'blocked'].includes(turn.state)) return agent;
        await sleep(300);
        continue;
      }
      if (desired.includes(agent.agent_status)) return agent;
      if (baselineCompletion !== undefined && agent.completion_seq > baselineCompletion) return agent;
      if (baselineCompletion !== undefined && ['idle', 'done'].includes(agent.agent_status)
          && getAgent(task.agent).readSubmissionActivity?.(task)) return agent;
      if (agent.agent_status === 'blocked' && !desired.includes('blocked')) {
        const error = new Error(`${task.agent} is blocked by a permission or question prompt; inspect the Herdr pane`);
        error.code = 'AGENT_BRIDGE_BLOCKED';
        throw error;
      }
    } catch (error) {
      if (['AGENT_BRIDGE_BLOCKED', 'WORKER_IDENTITY_MISMATCH', 'HERDR_IPC_ACCESS_DENIED', 'CBC_TURN_SUPERSEDED'].includes(error.code)) throw error;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${desired.join('/')}; last state: ${last?.agent_status || 'not registered'}`);
}

function launchCommand(task, resumeId) {
  return getAgent(task.agent).buildCommand(task, resumeId);
}

async function namedWorkerReady(task, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = assertWorker({ ...task, agentName: null }, agentInfo(task.herdrSession, task.paneId));
    if (agent.agent_status === 'blocked') throw Object.assign(new Error('Worker startup requires explicit input; no task sent'), { code: 'AGENT_BRIDGE_BLOCKED' });
    const nativeReady = task.agent !== 'agy' || !agent.launch_pending && agent.interactive_ready !== false;
    if ((!task.agentName || agent.name === task.agentName) && nativeReady) return agent;
    if (Date.now() >= deadline) throw Object.assign(new Error('Worker name or native interactive readiness is not confirmed; no task sent'), { code: 'AGENT_BRIDGE_BLOCKED' });
    await sleep(100);
  }
}

async function launchWorker(task, resumeId, { trustFolder = false } = {}) {
  if (resumeId) require('../lib/worker-identity').assertWorkerAbsent({ ...task, workerSessionId: resumeId });
  task.workerLifecycle = { phase: 'creating-location', priorStatus: task.status, attemptId: require('node:crypto').randomUUID(), at: now(),
    previous: { paneId: task.paneId, terminalId: task.terminalId, workerSessionId: task.workerSessionId } };
  if (task.startup) { task.startup.phase = 'creating-location'; task.startup.workerEffectsPossible = true; }
  saveTask(task);
  const created = createLocation(task, resumeId);
  task.workspaceId = created.workspaceId;
  task.tabId = created.tabId;
  task.paneId = created.pane.pane_id;
  task.terminalId = created.pane.terminal_id;
  task.mainPaneId = created.mainPaneId || task.mainPaneId;
  task.createdLocation = { mode: created.mode, ownsWorkspace: created.ownsWorkspace };
  delete task.recoveryPlacement;
  delete task.agentNameReleased;
  task.workerStartedAt = now();
  task.agentName = null;
  writeWorkerPolicy(task);
  writeLease(task);
  saveTask(task);
  await getAgent(task.agent).prepareWorker?.(task, resumeId);
  writeLease(task);
  saveTask(task);
  api(task.herdrSession, ['pane', 'run', task.paneId, launchCommand(task, resumeId)]);

  const deadline = Date.now() + 120000;
  let trustAnswered = false;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = paneText(task.herdrSession, task.paneId);
    } catch {}
    if (!trustAnswered && getAgent(task.agent).trustPrompt.test(text)) {
      if (!trustFolder) {
        const error = new Error(`Worker needs folder-trust confirmation for ${task.cwd}; answer in its pane, then resume ${task.id}`);
        error.code = 'AGENT_BRIDGE_BLOCKED';
        throw error;
      }
      api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
      trustAnswered = true;
      await sleep(200);
      continue;
    }
    try {
      const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      if (agent.agent_status === 'blocked') {
        const error = new Error(getAgent(task.agent).readBlocker?.(task)?.message || 'Worker requires input during startup');
        error.code = 'AGENT_BRIDGE_BLOCKED';
        throw error;
      }
      if (['idle', 'done', 'working'].includes(agent.agent_status)) {
        const nativeId = agent.agent_session?.value || observedContext(task)?.sessionId;
        if ((resumeId || task.workerSessionId) && nativeId !== (resumeId || task.workerSessionId)) {
          const error = new Error('Native worker session has not been independently attested; inspect this Pane before resume');
          error.code = 'AGENT_BRIDGE_BLOCKED'; throw error;
        }
        if (!task.workerSessionId && nativeId) task.workerSessionId = nativeId;
        const live = resultPayload(api(task.herdrSession, ['agent', 'list'])).agents;
        task.agentName = chooseAgentName(task.agent, live, task.paneId);
        api(task.herdrSession, ['agent', 'rename', task.paneId, task.agentName]);
        api(task.herdrSession, ['pane', 'rename', task.paneId, getAgent(task.agent).displayName || task.agent]);
        await namedWorkerReady(task);
        task.terminalId = agent.terminal_id;
        updateWorkerSession(task);
        if (resumeId) {
          if (nativeId !== resumeId) throw new Error('Restored worker session has not been attested');
          task.restoredContextSessionId = resumeId;
        }
        writeLease(task);
        task.workerLifecycle.phase = 'ready';
        if (task.round === 0 && task.status === 'created') task.status = 'ready';
        saveTask(task);
        return;
      }
    } catch (error) {
      if (error.code === 'AGENT_BRIDGE_BLOCKED' || /session changed|attest|identity mismatch/i.test(error.message)
          || error.code === 'HERDR_IPC_ACCESS_DENIED') throw error;
    }
    await sleep(400);
  }
  throw new Error(`Worker did not register within 120s (pane ${task.paneId})`);
}

function deliveryInstructions(task) {
  return renderRoundInstructions(task);
}

async function submit(task, promptBody, { activityTimeoutMs = 20000, startWatcherFn = startWatcher } = {}) {
  if (!promptBody) throw new Error('No pending task brief is available');
  if (task.agent === 'cbc' && task.cbcTurnProtocol === 1 && task.round > 0) {
    const previous = require('../lib/cbc-turn').readTurn(task);
    if (previous.state !== 'stopped') throw new Error(`Previous CBC native turn is ${previous.state}; reconcile it before a new round, no input sent`);
  }
  assertSingleActive(task);
  // Native refresh may distinguish historical failure from a current approval. / 原生刷新可区分历史失败与当前审批。
  let before = assertWorker({ ...task, agentName: null }, agentInfo(task.herdrSession, task.paneId));
  if (getAgent(task.agent).refreshWorker) {
    await getAgent(task.agent).refreshWorker(task, { forSubmission: true });
  }
  before = await namedWorkerReady(task);
  if (!['idle', 'done'].includes(before.agent_status)) {
    throw new Error(`Worker is not ready for a new round: ${before.agent_status}`);
  }
  const preparationBaseline = structuredClone(task);
  let attempt;
  try {
    const dir = ensureDir(taskDir(task.id));
    task.round += 1;
    // New CBC rounds require exact native input evidence, including rework of legacy tasks. / CBC新轮次含旧任务返工均要求精确原生输入证据。
    if (task.agent === 'cbc') task.cbcTurnProtocol = 1;
    const round = String(task.round).padStart(3, '0');
    task.promptPath = path.join(dir, `round-${round}-prompt.md`);
    task.deliveryPath = path.join(dir, 'deliveries', `round-${round}.md`);
    task.promptBody = promptBody;
    ensureDir(path.dirname(task.deliveryPath));
    writeWorkerPolicy(task);
    preparePromptContext(task, promptBody);
    fs.writeFileSync(task.promptPath, `${deliveryInstructions(task)}\n${promptBody}\n`);
    await getAgent(task.agent).prepareSubmission?.(task);
    attempt = require('../lib/submission-attempt').prepare(task);
    if (task.taskProtocol === 2) await require('../lib/cbc-protocol-v2').prepare(task, attempt, { previous: preparationBaseline });
  } catch (error) {
    // No prompt has been sent: preserve the previous round and pending brief on preflight failure. / 尚未发送任务：预检失败时保留原轮次和待提交任务书。
    for (const key of Object.keys(task)) if (!Object.hasOwn(preparationBaseline, key)) delete task[key];
    Object.assign(task, preparationBaseline);
    throw error;
  }
  task.status = 'running';
  task.submission = { status: 'preparing', baselineCompletion: before.completion_seq || 0, ...attempt };
  if (Number.isSafeInteger(before.state_change_seq) && before.state_change_seq >= 0) {
    task.submission.baselineStateChange = before.state_change_seq;
  }
  task.error = null;
  task.history.push({ round: task.round, status: 'submitted', timestamp: now() });
  saveTask(task);

  const pointer = renderSubmissionPointer(task);
  // Submission is never retried on an ambiguous timeout. / 提交超时结果不确定时禁止自动重发。
  task.submission.status = 'sending';
  require('../lib/submission-attempt').update(attempt, 'sending');
  saveTask(task);
  if (task.taskProtocol === 2) await require('../lib/cbc-protocol-v2').transition(task, 'transport.sending', {}, 'transport-sending');
  let inputAccepted = false;
  try {
    let inputReceipt;
    if (getAgent(task.agent).submitWorker) {
      inputReceipt = await getAgent(task.agent).submitWorker(task, pointer);
    } else {
      // The server checks readiness and submits bracketed paste atomically. / 服务端核对可输入状态并原子提交括号粘贴。
      if (getAgent(task.agent).promptMode === 'file-input') api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'ctrl+u']);
      api(task.herdrSession, ['agent', 'prompt', task.paneId,
        getAgent(task.agent).promptMode === 'file-input' ? task.promptPath : pointer]);
    }
    inputAccepted = true;
    if (task.taskProtocol === 2) await require('../lib/cbc-protocol-v2').transition(task, 'transport.written', {}, 'transport-written');
    task.submission.inputReceipt = inputReceipt || { transport: task.agent === 'opencode' ? 'native-api' : 'herdr-agent-prompt',
      inputAccepted: true, nativeAcceptanceConfirmed: task.agent === 'opencode' };
    saveTask(task);
    await waitForAgent(task, ['working', 'blocked'], activityTimeoutMs, before.completion_seq || 0);
    task.submission.status = 'observed';
    require('../lib/submission-attempt').update(attempt, 'observed');
  } catch (error) {
    if (!inputAccepted && (['agent_blocked', 'agent_not_ready', 'agent_not_running', 'agent_not_found', 'agent_not_registered', 'pane_not_found'].includes(error.herdrCode)
        || error.requestSent === false && error.origin === 'bridge-preflight')) {
      if (task.taskProtocol === 2) await require('../lib/cbc-protocol-v2').transition(task, 'transport.rejected', { inputWritten: false, reason: error.code || error.herdrCode }, 'transport-rejected');
      const diagnostic = require('../lib/cbc-prompt').guardDiagnostics(error);
      require('../lib/submission-attempt').update(attempt, 'rejected-before-input', { errorCode: error.herdrCode || error.code, inputWritten: false, ...diagnostic });
      // A server-side rejection precedes input; preserve the prior review round. / 服务端拒绝先于写入，保留此前主审轮次。
      for (const key of Object.keys(task)) if (!Object.hasOwn(preparationBaseline, key)) delete task[key];
      Object.assign(task, preparationBaseline);
      task.lastSubmissionRejection = { at: now(), code: error.herdrCode || error.code, message: error.message, ...attempt, ...diagnostic };
      task.rejectedSubmissions = [...(task.rejectedSubmissions || []), task.lastSubmissionRejection];
      saveTask(task); event(task, 'submission_rejected', { code: error.herdrCode });
      throw error;
    }
    if (task.taskProtocol === 2) await require('../lib/cbc-protocol-v2').transition(task, 'transport.unknown', { reason: error.code || 'response-lost' }, 'transport-unknown');
    task.status = 'submission_unknown';
    task.submission.status = 'uncertain';
    task.error = error.message;
    try { require('../lib/submission-attempt').update(attempt, 'uncertain', { inputAccepted,
      inputWritten: 'unknown', transportAcknowledged: inputAccepted,
      ...(error.transportDiagnostic ? { transportDiagnostic: error.transportDiagnostic } : {}),
      errorCode: error.herdrCode || error.code || null }); }
    catch (journalError) { task.submission.journalError = journalError.message; }
    saveTask(task);
    event(task, 'submission_uncertain', { message: error.message });
    if (task.agent === 'cbc' && task.cbcTurnProtocol === 1 && error.code !== 'CBC_TURN_SUPERSEDED') {
      // A lost receipt starts observation only, never another input attempt. / 回执丢失只启动观察，绝不再发输入。
      task.watcherPid = startWatcherFn(task.id);
      saveTask(task);
      event(task, 'uncertain_submission_observer_started', { watcherPid: task.watcherPid });
    }
    throw error;
  }
  updateWorkerSession(task);
  writeLease(task);
  task.notification = { status: 'pending', round: task.round };
  saveTask(task);
  recordContext(task);
  task.watcherPid = startWatcherFn(task.id);
  saveTask(task);
  event(task, 'submitted', { paneId: task.paneId, round: task.round, watcherPid: task.watcherPid });
}

async function dispatch(options) {
  if (!options['spec-file']) throw new Error('New delegation requires --spec-file with a complete task-spec-v1 specification');
  const taskSpec = normalizeTaskSpec(readJson(path.resolve(options['spec-file'])));
  const promptBody = options['prompt-file'] || options.prompt ? promptFrom(options) : taskSpec.goal;
  const waitTimeoutMs = Number(options['wait-timeout-ms'] ?? process.env.AGENT_BRIDGE_WAIT_TIMEOUT_MS
    ?? (process.env.AGENT_BRIDGE_TASK_PROTOCOL === '2' && getAgent(options.agent || 'cbc').id === 'cbc' ? 0 : 1800000));
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 86400000) {
    throw new Error('--wait-timeout-ms must be 0 (unbounded) or milliseconds up to one day');
  }
  if (process.env.HERDR_ENV !== '1' && !options.session && !process.env.HERDR_SESSION) {
    throw new Error('No inherited Herdr context; provide an explicitly verified --session (daemon execution does not inherit Pane environment)');
  }
  const cwd = path.resolve(required(options.cwd, 'cwd'));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Invalid cwd: ${cwd}`);
  const worker = getAgent(options.agent || 'cbc');
  if (options['resume-task'] && (worker.id !== 'cbc' || options['new-session'])) {
    throw new Error('--resume-task requires CBC and cannot be combined with --new-session');
  }
  if (options.parallel && !options['worker-key']) throw new Error('Explicit parallel tasks require distinct --worker-key bindings');
  let zcodeConfig, zcodeBindingSha256;
  if (worker.id === 'zcode') {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('ZCode Desktop adapter requires Node.js 24 or later');
    zcodeConfig = path.resolve(options['zcode-config'] || process.env.AGENT_BRIDGE_ZCODE_CONFIG
      || path.join(config().stateDir, 'zcode-desktop.json'));
    const binding = require('../lib/zcode-remote').readBinding(zcodeConfig);
    zcodeBindingSha256 = require('node:crypto').createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  }
  const herdrSession = options.session || config().defaultSession;
  const cbcBinary = options['cbc-binary'] || config().cbc;
  const task = {
    schemaVersion: 1,
    id: options['task-id'] || makeTaskId(),
    agent: worker.id,
    ...(worker.id === 'cbc' && process.env.AGENT_BRIDGE_TASK_PROTOCOL === '2' ? { taskProtocol: 2,
      ...(process.env.AGENT_BRIDGE_RELEASE_ID ? { runtimeReleaseId: process.env.AGENT_BRIDGE_RELEASE_ID } : {}) } : {}),
    ...(worker.id === 'cbc' ? { cbcBinary, cbcNativeBinary: options['cbc-native-binary']
      || (/\.ps1$/i.test(cbcBinary) ? config().cbcNative : cbcBinary), nodeExecutable: options['node-executable'] || process.execPath } : {}),
    workerKey: bindingKey(options['worker-key']),
    ...(options['resume-task'] ? { resumeFromTaskId: options['resume-task'] } : {}),
    parallel: Boolean(options.parallel),
    ...(zcodeConfig ? { zcodeConfig, zcodeBindingSha256 } : {}),
    placement: placementFor(options),
    cwd,
    herdrSession,
    stateDir: config().stateDir,
    permissionMode: options['permission-mode'] || config().defaultPermissionMode,
    skipPermissions: !options['no-skip-permissions'],
    permissionExplicit: Boolean(options['permission-mode'] || options['no-skip-permissions']),
    model: options.model || null,
    effort: options.effort || null,
    waitTimeoutMs,
    taskSpec,
    forceFullContext: Boolean(options['full-context']),
    allowedWritePaths: taskSpec.allowedChanges,
    codexThread: options['codex-thread'] || detectCodexThread(herdrSession),
    round: 0,
    status: 'created',
    history: [],
    createdAt: now(),
  };
  assertSingleActive(task);
  if (fs.existsSync(path.join(taskDir(task.id), 'task.json'))) throw new Error(`Task already exists: ${task.id}`);
  task.initialPromptPath = path.join(ensureDir(taskDir(task.id)), 'initial-request.md');
  fs.writeFileSync(task.initialPromptPath, `${promptBody}\n`);
  saveTask(task);
  try {
    task.startup = { protocol: 1, attemptId: require('node:crypto').randomUUID(), phase: 'checking-server',
      workerEffectsPossible: false, ownerPid: process.pid, timestamp: now() };
    saveTask(task);
    await ensureServer(task.herdrSession);
    // Save before context reuse or any Pane operation, including uncertain location creation. / 在上下文复用或Pane操作前保存边界，含位置创建结果不确定的情况。
    task.startup.phase = 'reuse-check'; task.startup.workerEffectsPossible = false;
    saveTask(task);
    const reused = tryReuseContext(task, { fresh: Boolean(options['new-session']) });
    if (task.resumeFromTaskId && !reused && !task.resumeContextSessionId) {
      throw new Error('Explicit CBC session reuse was not attested; no new session created');
    }
    if (worker.id === 'zcode' && !options.effort) task.effort = 'max';
    if (!reused) {
      task.model ||= worker.id === 'zcode' ? 'GLM-5.3-Flash' : null;
      await launchWorker(task, task.resumeContextSessionId || null, { trustFolder: Boolean(options['trust-folder']) });
    }
    await submit(task, promptBody);
  } catch (error) {
    await failDispatch(task, error, { deferNotification: true });
    throw error;
  }
  return task;
}

async function failDispatch(task, error, notifyOptions = {}) {
  if (task.status !== 'submission_unknown') task.status = error.code === 'AGENT_BRIDGE_BLOCKED' ? 'blocked' : 'failed';
  task.error = error.message;
  task.history.push({ round: task.round, status: task.status, timestamp: now(), message: error.message });
  saveTask(task);
  event(task, 'dispatch_failed', { message: error.message });
  // Startup may block before a completion watcher exists. / 启动可能在完成监听器建立之前阻塞。
  if (task.status === 'blocked' && !notifyOptions.deferNotification) {
    try { await require('../lib/notify').notifyTask(task, notifyOptions); }
    catch (notificationError) { event(task, 'startup_notification_failed', { message: notificationError.message }); }
  }
}

async function ensureWorkerAlive(task) {
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    return false;
  } catch (error) {
    if (!missingWorker(error) && error.code !== 'WORKER_IDENTITY_MISMATCH') throw error;
    require('../lib/worker-identity').assertWorkerAbsent(task);
  }
  if (!task.workerSessionId) {
    throw new Error('Worker pane is gone and no worker session ID was captured; inspect session records before a new dispatch');
  }
  await launchWorker(task, task.workerSessionId, { trustFolder: true });
  return true;
}

function applyReworkModel(task, options) {
  const model = Object.hasOwn(options, 'model');
  const effort = Object.hasOwn(options, 'effort');
  if (!model && !effort) return;
  if (getAgent(task.agent).id !== 'opencode') throw new Error('Rework --model/--effort currently supports only oc; other agents require their native recovery flow');
  if (model) required(typeof options.model === 'string' && options.model.trim(), 'model');
  if (effort) required(typeof options.effort === 'string' && options.effort.trim(), 'effort');
  if (model) {
    task.model = options.model.trim();
    // Do not carry the old model's variant into a different model implicitly. / 不把旧模型的variant隐式带入新模型。
    if (!effort) task.effort = null;
  }
  if (effort) task.effort = options.effort.trim();
}

async function rework(options) {
  const task = loadTask(required(options._[0], 'task id'));
  const stoppedCbc = task.agent === 'cbc' && task.status === 'blocked' && task.cbcTurnProtocol === 1
    && task.submission?.status === 'observed' && require('../lib/cbc-turn').readTurn(task).state === 'stopped';
  if (!['review_pending', 'delivery_missing', 'failed'].includes(task.status) && !(task.agent === 'zcode' && task.status === 'blocked') && !stoppedCbc) {
    throw new Error(`Rework requires review_pending/delivery_missing/failed; current: ${task.status}`);
  }
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('A watcher is still active for this task');
  require('../lib/messages').assertMessagesSettled(task);
  applyReworkModel(task, options);
  if (Object.hasOwn(options, 'model') || Object.hasOwn(options, 'effort')) {
    // Persist the requested model before native calls, so failures cannot restore an old pin silently. / 原生调用前保存目标模型，失败后不静默恢复旧模型绑定。
    task.history.push({ round: task.round, status: 'model_change_requested', model: task.model, effort: task.effort, timestamp: now() });
    saveTask(task);
  }
  await ensureServer(task.herdrSession);
  await ensureWorkerAlive(task);
  task.forceFullContext = Boolean(options['full-context']);
  if (options['spec-file']) {
    task.taskSpec = normalizeTaskSpec(readJson(path.resolve(options['spec-file'])));
    task.allowedWritePaths = task.taskSpec.allowedChanges;
  }
  await submit(task, promptFrom(options));
  return task;
}

async function cancel(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (task.taskProtocol === 2 && task.layeredRequestFile) return require('../lib/cbc-protocol-v2').cancel(task);
  if (['accepted', 'cancelled'].includes(task.status)) return task;
  if (require('../lib/startup-recovery').candidate(task)) {
    try { return require('../lib/startup-recovery').cancelNotStarted(task); }
    catch (error) { throw new Error(`${error.message}; use abandon with --reason --actor --evidence-file if native outcome cannot be proved; resources remain quarantined`); }
  }
  if (task.status === 'cancel_pending' && getAgent(task.agent).reconcileCancellation) {
    return getAgent(task.agent).reconcileCancellation(task);
  }
  if (getAgent(task.agent).cancellationState) return require('../lib/cancellation').cancelNative(task);
  throw new Error('This adapter has no verified native cancellation contract; no input or task state changed');
}

async function resume(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (task.taskProtocol === 2 && task.layeredRequestFile) return require('../lib/cbc-protocol-v2').recover(task, options);
  if (task.status === 'submission_unknown') {
    await recoverOne(task);
    const current = loadTask(task.id);
    if (current.status === 'submission_unknown') throw new Error('Submission remains uncertain; force never authorizes replay. Reconcile or abandon with evidence');
    return current;
  }
  if (!['blocked', 'failed'].includes(task.status)) throw new Error(`Resume requires blocked/failed; current: ${task.status}`);
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('A watcher is still active for this task');
  if (require('../lib/startup-recovery').candidate(task)) {
    try { require('../lib/startup-recovery').proveNotStarted(task); }
    catch (error) { throw new Error(`${error.message}; use abandon with reason, actor and evidence; no replay authorized`); }
    throw new Error(`No native session was created; run cancel ${task.id}, then dispatch with the original spec and worker-key`);
  }
  await ensureServer(task.herdrSession);
  if (options.workspace || options.pane || options['new-workspace']) {
    if (!options.force) throw new Error('Explicit recovery placement requires --force and absent original owner');
    task.recoveryPlacement = placementFor({ ...options, session: task.herdrSession }, {});
    await launchWorker(task, required(task.workerSessionId, 'native session'), { trustFolder: false });
  } else await ensureWorkerAlive(task);
  if (options['retry-failed']) return require('../lib/task-recovery').retryFailed(task);
  if (task.round === 0) { await submit(task, pendingRoundPrompt(task)); return task; }
  // Restoring a terminal only reattaches observation; it never replays submitted work. / 恢复终端仅续接观察，绝不重放已提交任务。
  return require('../lib/task-recovery').observe(task, options);
}

async function accept(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (task.taskProtocol === 2 && task.layeredRequestFile) return require('../lib/cbc-protocol-v2').accept(task);
  if (task.status !== 'review_pending') throw new Error(`Accept requires review_pending; current: ${task.status}`);
  if (task.agent === 'cbc' && task.cbcTurnProtocol === 1) {
    const turn = require('../lib/cbc-turn').readTurn(task);
    if (turn.state !== 'stopped') throw Object.assign(new Error(`CBC native turn is ${turn.state}: ${turn.reason || 'terminal proof unavailable'}; inspect current-turn evidence before acceptance; do not replay`), {
      code: 'CBC_ACCEPT_TURN_UNCONFIRMED' });
  }
  require('../lib/messages').assertMessagesSettled(task);
  task.status = 'accepted';
  task.history.push({ round: task.round, status: 'accepted', timestamp: now() });
  saveTask(task);
  event(task, 'accepted');
  recordContext(task);
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    api(task.herdrSession, ['pane', 'rename', task.paneId, getAgent(task.agent).displayName || task.agent]);
    api(task.herdrSession, ['agent', 'rename', task.paneId, '--clear']);
    task.agentNameReleased = true;
    saveTask(task);
  } catch (error) {
    event(task, 'agent_name_release_failed', { message: error.message });
  }
  return task;
}

function pendingRoundPrompt(task) {
  const source = task.promptPath || task.initialPromptPath;
  if (!source || !fs.existsSync(source)) return null;
  const text = fs.readFileSync(source, 'utf8');
  const marker = '=== 任务与验收要求 ===';
  return text.includes(marker) ? text.split(marker).pop().trim() : text.trim();
}

async function recoverOne(task, options = {}) {
  if (task.taskProtocol === 2 && task.layeredRequestFile) return require('../lib/cbc-protocol-v2').recover(task);
  const actions = [];
  if (require('../lib/startup-recovery').candidate(task)) {
    try {
      require('../lib/startup-recovery').proveNotStarted(task);
      return [`No native worker/submission; run cancel ${task.id}, then dispatch with original binding`];
    } catch (error) {
      if (task.startup?.ownerPid && processAlive(task.startup.ownerPid)) return ['Startup owner remains active; no recovery mutation'];
      task.status = 'failed'; task.error = `Startup outcome unconfirmed: ${error.message}; inspect ownership or abandon with evidence`;
      saveTask(task); return ['Startup uncertainty retained; no prompt replay or fabricated cancellation'];
    }
  }
  if (task.status === 'cancel_pending' && (getAgent(task.agent).cancellationState || getAgent(task.agent).reconcileCancellation)) {
    const result = getAgent(task.agent).reconcileCancellation
      ? await getAgent(task.agent).reconcileCancellation(task)
      : await require('../lib/cancellation').cancelNative(task, { reconcileOnly: true });
    return [result.status === 'cancelled' ? 'native cancellation confirmed; original session retained, no interrupt or prompt sent'
      : 'cancellation remains pending; native evidence unavailable or still active, no interrupt or prompt sent'];
  }
  if (['created', 'ready', 'recovering'].includes(task.status)) {
    task.status = 'failed';
    task.error = 'Startup was interrupted; inspect the saved pane before explicit rework or cancellation';
    saveTask(task);
    actions.push('interrupted startup marked failed; no task automatically retransmitted');
  }
  if (task.agent === 'opencode' && task.opencodeRetry?.round === task.round
      && ['sending', 'uncertain'].includes(task.opencodeRetry.status) && task.status !== 'cancel_pending') {
    const adapter = require('../lib/opencode'), proof = adapter.reconcileSubmission(task);
    if (proof.state === 'admitted') {
      const receipt = adapter.confirmReconciledSubmission(task, proof);
      task.opencodeRetry = { ...task.opencodeRetry, status: 'confirmed', admissionId: receipt.admissionId };
      task.submission.status = 'observed'; task.status = 'running'; task.error = null; saveTask(task);
      actions.push('Exact retry admission reconciled; no prompt retransmitted');
    } else if (proof.state === 'not_sent') {
      task.opencodeRetry.status = 'prepared'; task.status = 'blocked'; task.submission.status = 'observed';
      task.error = 'Retry was prepared but never sent; explicit resume --retry-failed may reuse that same admission ID';
      saveTask(task); return ['Retry request never started; same prepared ID retained, no prompt sent'];
    } else {
      task.status = 'submission_unknown'; task.submission.status = 'uncertain'; saveTask(task);
      return ['Retry admission remains uncertain; no prompt resent'];
    }
  }
  if (task.status === 'submission_unknown') {
    if (task.agent === 'zcode') {
      const result = await require('../lib/zcode-reconciliation').recover(task);
      return [`ZCode exact native command and terminal reconciled to ${result.status}; transport uncertainty retained, no prompt sent`];
    } else if (task.agent === 'cbc' && options['cbc-transcript']) {
      const result = await require('../lib/cbc-reconciliation').recover(task, { nativeTranscript: options['cbc-transcript'] });
      return [`CBC exact native input and round execution reconciled to ${result.status}; no prompt or interrupt sent`];
    } else if (task.agent === 'cbc' && task.cbcTurnProtocol === 1) {
      if (!task.watcherPid || !processAlive(task.watcherPid)) {
        assertWorker(task, agentInfo(task.herdrSession, task.paneId));
        task.watcherPid = startWatcher(task.id); saveTask(task);
        return ['CBC receipt observer attached; native input must match this attempt, no prompt sent'];
      }
      return ['CBC receipt observer is already active; no duplicate observer or prompt sent'];
    } else if (task.agent === 'opencode') {
      const adapter = require('../lib/opencode'), proof = adapter.reconcileSubmission(task);
      if (proof.state === 'admitted') {
        const receipt = adapter.confirmReconciledSubmission(task, proof);
        if (task.opencodeRetry) task.opencodeRetry = { ...task.opencodeRetry, status: 'confirmed', admissionId: receipt.admissionId };
        task.submission.status = 'observed'; task.status = 'running'; task.error = null; saveTask(task);
        actions.push('Exact native admission reconciled; no prompt retransmitted');
      } else return [`Native admission ${proof.state}; no replay. Inspect or abandon with evidence`];
    } else return [task.agent === 'cbc'
      ? 'CBC submission remains uncertain; use recover --cbc-transcript <exact native JSONL> after read-only reconciliation; never replay'
      : 'Submission remains uncertain; use native command reconciliation or evidence-based abandon, never force replay'];
  }
  if (task.status === 'running') {
    try {
      const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      if (!task.watcherPid || !processAlive(task.watcherPid)) {
        task.watcherPid = startWatcher(task.id);
        saveTask(task);
        actions.push(`watcher restarted while agent is ${agent.agent_status}`);
      }
    } catch (error) {
      // Transport loss is an observation problem, not an execution outcome. / 传输失败属于观察问题，不能推断执行终态。
      task.observationError = { at: now(), message: error.message, originalExecutionMayContinue: true };
      saveTask(task); event(task, 'recovery_observation_unavailable', { message: error.message });
      actions.push('Observation unavailable; running status and existing watcher retained, no prompt retransmitted');
    }
  } else if (['review_pending', 'delivery_missing', 'blocked', 'failed'].includes(task.status)) {
    actions.push('Notification reconciliation scheduled after task lock release');
  }

  return actions;
}

async function recover(options) {
  const root = path.join(config().stateDir, 'tasks');
  const ids = options._[0] ? [options._[0]]
    : fs.existsSync(root) ? fs.readdirSync(root)
      .filter(id => fs.existsSync(path.join(root, id, 'task.json'))) : [];
  const results = [];
  for (const id of ids) {
    try {
      results.push(await withLock(id, async () => {
        const task = loadTask(id);
        if (options['codex-thread']) {
          task.codexThread = options['codex-thread'];
          saveTask(task);
        }
        if (options['resend-notification'] && task.notification?.status === 'uncertain') {
          task.notification.status = 'pending';
          saveTask(task);
        }
        return { taskId: id, actions: await recoverOne(task, options) };
      }));
    } catch (error) {
      results.push({ taskId: id, error: error.message,
        ...(error.diagnosticFile ? { diagnosticFile: error.diagnosticFile, failedChecks: error.failedChecks || [] } : {}) });
    }
  }
  return results;
}

async function ack(options) {
  const task = loadTask(required(options._[0], 'task id'));
  const { acknowledgeTask } = require('../lib/notify');
  await acknowledgeTask(task, required(options.key, 'key'));
  return task;
}

async function postNotifications(ids) {
  for (const id of new Set(ids.filter(Boolean))) {
    try {
      const task = loadTask(id);
      if (['review_pending', 'delivery_missing', 'blocked', 'failed'].includes(task.status)) await require('../lib/notify').notifyTask(task);
      else if (task.codexThread) await require('../lib/notification-control').reconcileThread(task.codexThread, { allowAdd: false });
    } catch (error) {
      try { event(loadTask(id), 'notification_reconciliation_failed', { message: error.message }); } catch {}
    }
  }
}

async function main() {
  const command = process.argv[2];
  const options = parse(process.argv.slice(3));
  let result;
  const mutations = { rework, resume, cancel, accept,
    observe: options => { const task = loadTask(options._[0]); return task.taskProtocol === 2 && task.layeredRequestFile
      ? require('../lib/cbc-protocol-v2').recover(task, options) : require('../lib/task-recovery').observe(task, options); },
    settle: options => { const task = loadTask(options._[0]); return task.taskProtocol === 2 && task.layeredRequestFile
      ? require('../lib/cbc-protocol-v2').recover(task) : require('../lib/task-recovery').settle(task); },
    'adopt-restored': options => require('../lib/task-recovery').adoptRestored(loadTask(options._[0]), options),
    abandon: options => require('../lib/coordination-exit').abandon(loadTask(options._[0]), {
      reason: options.reason, actor: options.actor, evidenceFile: options['evidence-file'], rejectionReceipt: options['rejection-receipt'],
    }),
  };
  try {
  if (command === 'notifications') {
    const { pendingTasks, controlState, reconcileThread, setPaused } = require('../lib/notification-control');
    const thread = required(options['codex-thread'] || process.env.CODEX_THREAD_ID, 'codex-thread');
    const action = options._[0] || 'status';
    if (action === 'pause') result = await setPaused(thread, true);
    else if (action === 'resume') result = await setPaused(thread, false);
    else if (action === 'pending') result = pendingTasks(thread);
    else if (action === 'reconcile') result = await reconcileThread(thread, { allowAdd: true });
    else if (action === 'status') result = { ...controlState(thread), pending: pendingTasks(thread) };
    else throw new Error('notifications <pause|resume|status|pending|reconcile>');
  }
  else if (command === 'message') {
    const taskId = required(options._[0], 'task id');
    result = await withLock(taskId, async () => {
      const messages = require('../lib/messages');
      const receipt = await messages.deliver(loadTask(taskId), { id: required(options['message-id'], 'message-id'),
        mode: required(options.mode, 'mode'), text: promptFrom(options), waitMs: Number(options['wait-ms'] ?? 15000) });
      return messages.publicReceipt(receipt);
    });
  }
  else if (['message-status', 'message-reconcile'].includes(command)) {
    const messages = require('../lib/messages'), task = loadTask(required(options._[0], 'task id'));
    const id = required(options['message-id'], 'message-id');
    result = messages.publicReceipt(command === 'message-reconcile' ? await messages.reconcile(task, id) : messages.readMessage(task, id));
  }
  else if (command === 'message-retire') {
    const id = required(options._[0], 'task id');
    result = await withLock(id, async () => {
      const messages = require('../lib/messages');
      return messages.publicReceipt(await messages.retireMessage(loadTask(id), required(options['message-id'], 'message-id'), {
        reason: options.reason, evidence: options.evidence, actor: options.actor,
      }));
    });
  }
  else if (command === 'ack') result = await ack(options);
  else if (command === 'reconcile-submission') {
    const id = required(options._[0], 'task id');
    result = await withLock(id, () => loadTask(id).taskProtocol === 2
      ? require('../lib/cbc-protocol-v2').recover(loadTask(id), options)
      : options['cbc-transcript']
      ? (() => {
        const task = loadTask(id);
        if (task.agent === 'cbc' && task.cbcTurnProtocol === 1 && task.submission?.status === 'observed') {
          return { taskId: task.id, round: task.round,
            ...require('../lib/cbc-turn').readTurn(task, { nativeTranscript: options['cbc-transcript'] }),
            readOnly: true, taskMutated: false, scope: 'native-turn-only; no live-process or technical acceptance' };
        }
        return require('../lib/cbc-reconciliation').inspect(task, { nativeTranscript: options['cbc-transcript'] });
      })()
      : require('../lib/submission-rejection').inspectRejection(loadTask(id), {
        receiptFile: required(options['rejection-receipt'], 'rejection-receipt'),
      }));
  }
  else if (['diagnose-zcode-admission', 'diagnose-zcode-terminal'].includes(command)) {
    const id = required(options._[0], 'task id');
    result = await withLock('dispatch-global', () => withLock(id,
      () => require('../lib/zcode-reconciliation')[command === 'diagnose-zcode-terminal' ? 'diagnoseTerminal' : 'diagnose'](loadTask(id))));
  }
  else if (command === 'dispatch') {
    options['task-id'] ||= makeTaskId();
    result = await withLock('dispatch-global', () => withLock(options['task-id'], () => dispatch(options)));
  }
  else if (command === 'adopt-zcode') {
    const id = required(options._[0], 'task id');
    result = await withLock('dispatch-global', () => withLock(id, () => require('../lib/zcode-adoption').adopt(loadTask(id), {
      commandFile: required(options['command-file'], 'command-file'), specFile: required(options['spec-file'], 'spec-file'),
      deliveryFile: required(options['delivery-file'], 'delivery-file'), round: Number(required(options.round, 'round')),
    })));
  }
  else if (['rework', 'resume', 'accept', 'observe', 'settle', 'adopt-restored', 'abandon'].includes(command)) {
    result = await withLock('dispatch-global', () => withLock(required(options._[0], 'task id'), () => mutations[command](options)));
  }
  else if (mutations[command]) result = await withLock(required(options._[0], 'task id'), () => mutations[command](options));
  else if (command === 'recover') result = await withLock('dispatch-global', () => recover(options));
  else if (command === 'status') {
    result = loadTask(required(options._[0], 'task id'));
    if (result.taskProtocol === 2 && result.layeredRequestFile) {
      try { require('../lib/cbc-protocol-v2').sync(result); }
      catch (error) { result.protocolDiagnostic = { code: error.code || 'PROTOCOL_READ_FAILED', message: error.message }; }
    }
  }
  else if (command === 'read') {
    const task = loadTask(required(options._[0], 'task id'));
    if (task.taskProtocol === 2 && task.layeredRequestFile) result = require('../lib/cbc-protocol-v2').report(task);
    else {
      assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      result = { taskId: task.id, round: task.round, text: agentText(task.herdrSession, task.paneId) };
    }
  } else if (command === 'sessions') {
    result = listContexts(options.cwd, options.agent, options['worker-key']);
  } else if (command === 'agents') {
    result = listAgents();
  } else if (command === 'list') {
    const root = path.join(config().stateDir, 'tasks');
    result = fs.existsSync(root) ? fs.readdirSync(root)
      .filter(id => fs.existsSync(path.join(root, id, 'task.json')))
      .map(id => readJson(path.join(root, id, 'task.json'))) : [];
  } else {
    throw new Error('Usage: agent-bridge <dispatch|rework|resume|observe|settle|adopt-restored|abandon|reconcile-submission|diagnose-zcode-admission|diagnose-zcode-terminal|message-retire|adopt-zcode|status|read|cancel|accept|ack|recover|notifications|list|agents|sessions> [options]');
  }
  } catch (error) {
    if (['dispatch', 'rework', 'resume', 'cancel', 'observe', 'settle', 'adopt-restored', 'abandon'].includes(command)) {
      await postNotifications([options['task-id'] || options._[0]]);
    }
    throw error;
  }
  if (command === 'recover') await postNotifications(result.map(item => item.taskId));
  else if (mutations[command] || command === 'dispatch' || command === 'adopt-zcode') await postNotifications([result?.id]);
  if (result?.id) result = loadTask(result.id);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code || 'AGENT_BRIDGE_ERROR',
    ...require('../lib/cbc-prompt').guardDiagnostics(error) })}\n`);
  process.exitCode = 1;
});

module.exports = { parse, dispatch, submit, resume, rework, recoverOne, accept, ack, main, assertSingleActive, failDispatch, applyReworkModel, postNotifications, namedWorkerReady };
