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
    if (['json', 'force', 'trust-folder', 'no-skip-permissions', 'resend-notification', 'new-workspace', 'new-session', 'full-context', 'parallel'].includes(key)) options[key] = true;
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
      const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
      last = agent;
      if (desired.includes(agent.agent_status)) return agent;
      if (baselineCompletion !== undefined && agent.completion_seq > baselineCompletion) return agent;
      if (agent.agent_status === 'blocked' && !desired.includes('blocked')) {
        const error = new Error(`${task.agent} is blocked by a permission or question prompt; inspect the Herdr pane`);
        error.code = 'AGENT_BRIDGE_BLOCKED';
        throw error;
      }
    } catch (error) {
      if (error.code === 'AGENT_BRIDGE_BLOCKED') throw error;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${desired.join('/')}; last state: ${last?.agent_status || 'not registered'}`);
}

function launchCommand(task, resumeId) {
  return getAgent(task.agent).buildCommand(task, resumeId);
}

async function launchWorker(task, resumeId, { trustFolder = false } = {}) {
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
      const agent = agentInfo(task.herdrSession, task.paneId);
      if (agent.agent_status === 'blocked') {
        const error = new Error(getAgent(task.agent).readBlocker?.(task)?.message || 'Worker requires input during startup');
        error.code = 'AGENT_BRIDGE_BLOCKED';
        throw error;
      }
      if (['idle', 'done', 'working'].includes(agent.agent_status)) {
        const live = resultPayload(api(task.herdrSession, ['agent', 'list'])).agents;
        task.agentName = chooseAgentName(task.agent, live, task.paneId);
        api(task.herdrSession, ['agent', 'rename', task.paneId, task.agentName]);
        api(task.herdrSession, ['pane', 'rename', task.paneId, getAgent(task.agent).displayName || task.agent]);
        task.terminalId = agent.terminal_id;
        updateWorkerSession(task);
        if (resumeId) {
          if (observedContext(task)?.sessionId !== resumeId) throw new Error('Restored worker session has not been attested');
          task.restoredContextSessionId = resumeId;
        }
        writeLease(task);
        task.status = 'ready';
        saveTask(task);
        return;
      }
    } catch (error) { if (error.code === 'AGENT_BRIDGE_BLOCKED') throw error; }
    await sleep(400);
  }
  throw new Error(`Worker did not register within 120s (pane ${task.paneId})`);
}

function deliveryInstructions(task) {
  return renderRoundInstructions(task);
}

async function submit(task, promptBody, { activityTimeoutMs = 20000, startWatcherFn = startWatcher } = {}) {
  if (!promptBody) throw new Error('No pending task brief is available');
  assertSingleActive(task);
  const before = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
  if (!['idle', 'done'].includes(before.agent_status)) {
    throw new Error(`Worker is not ready for a new round: ${before.agent_status}`);
  }
  const dir = ensureDir(taskDir(task.id));
  task.round += 1;
  const round = String(task.round).padStart(3, '0');
  task.promptPath = path.join(dir, `round-${round}-prompt.md`);
  task.deliveryPath = path.join(dir, 'deliveries', `round-${round}.md`);
  task.promptBody = promptBody;
  ensureDir(path.dirname(task.deliveryPath));
  writeWorkerPolicy(task);
  preparePromptContext(task, promptBody);
  fs.writeFileSync(task.promptPath, `${deliveryInstructions(task)}\n${promptBody}\n`);
  await getAgent(task.agent).prepareSubmission?.(task);
  task.status = 'running';
  task.submission = { status: 'preparing', baselineCompletion: before.completion_seq || 0 };
  task.error = null;
  task.history.push({ round: task.round, status: 'submitted', timestamp: now() });
  saveTask(task);

  const pointer = renderSubmissionPointer(task);
  // Submission is never retried on an ambiguous timeout. / 提交超时结果不确定时禁止自动重发。
  task.submission.status = 'sending';
  saveTask(task);
  try {
    if (getAgent(task.agent).submitWorker) {
      await getAgent(task.agent).submitWorker(task, pointer);
    } else if (['pane-input', 'file-input'].includes(getAgent(task.agent).promptMode)) {
      // CBC is hook-recognized, not a native Herdr agent kind. / CBC 由 hook 识别，尚非 Herdr 原生 Agent 类型。
      api(task.herdrSession, ['pane', 'send-text', task.paneId,
        getAgent(task.agent).promptMode === 'file-input' ? task.promptPath : pointer]);
      await sleep(600);
      api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
    } else {
      api(task.herdrSession, ['agent', 'prompt', task.paneId, pointer]);
    }
    await waitForAgent(task, ['working', 'blocked'], activityTimeoutMs, before.completion_seq || 0);
    task.submission.status = 'observed';
  } catch (error) {
    task.status = 'submission_unknown';
    task.submission.status = 'uncertain';
    task.error = error.message;
    saveTask(task);
    event(task, 'submission_uncertain', { message: error.message });
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
  const waitTimeoutMs = Number(options['wait-timeout-ms'] ?? process.env.AGENT_BRIDGE_WAIT_TIMEOUT_MS ?? 1800000);
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 86400000) {
    throw new Error('--wait-timeout-ms must be 0 (unbounded) or milliseconds up to one day');
  }
  if (process.env.HERDR_ENV !== '1' && !options.session && !process.env.HERDR_SESSION) {
    throw new Error('No inherited Herdr context; provide an explicitly verified --session (daemon execution does not inherit Pane environment)');
  }
  const cwd = path.resolve(required(options.cwd, 'cwd'));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Invalid cwd: ${cwd}`);
  const worker = getAgent(options.agent || 'cbc');
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
  const task = {
    schemaVersion: 1,
    id: options['task-id'] || makeTaskId(),
    agent: worker.id,
    workerKey: bindingKey(options['worker-key']),
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
    await ensureServer(task.herdrSession);
    const reused = tryReuseContext(task, { fresh: Boolean(options['new-session']) });
    if (worker.id === 'zcode' && !options.effort) task.effort = 'max';
    if (!reused) {
      task.model ||= worker.id === 'zcode' ? 'GLM-5.3-Flash' : null;
      await launchWorker(task, task.resumeContextSessionId || null, { trustFolder: Boolean(options['trust-folder']) });
    }
    await submit(task, promptBody);
  } catch (error) {
    await failDispatch(task, error);
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
  if (task.status === 'blocked') {
    try { await require('../lib/notify').notifyTask(task, notifyOptions); }
    catch (notificationError) { event(task, 'startup_notification_failed', { message: notificationError.message }); }
  }
}

async function ensureWorkerAlive(task) {
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    return;
  } catch (error) { if (!missingWorker(error)) throw error; }
  if (!task.workerSessionId) {
    throw new Error('Worker pane is gone and no worker session ID was captured; inspect session records before a new dispatch');
  }
  await launchWorker(task, task.workerSessionId, { trustFolder: true });
}

async function rework(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (!['review_pending', 'delivery_missing', 'failed'].includes(task.status)) {
    throw new Error(`Rework requires review_pending/delivery_missing/failed; current: ${task.status}`);
  }
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('A watcher is still active for this task');
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
  if (['accepted', 'cancelled'].includes(task.status)) return task;
  task.status = 'cancel_pending';
  saveTask(task);
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    if (getAgent(task.agent).cancelWorker) await getAgent(task.agent).cancelWorker(task);
    else api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'esc']);
    await waitForAgent(task, ['idle', 'done'], 10000);
    task.status = 'cancelled';
  } catch (error) {
    task.error = `Cancellation not confirmed: ${error.message}`;
    saveTask(task);
    event(task, 'cancel_pending', { message: task.error });
    return task;
  }
  task.error = null;
  task.watcherPid = null;
  task.history.push({ round: task.round, status: 'cancelled', timestamp: now() });
  saveTask(task);
  event(task, 'cancelled');
  return task;
}

async function resume(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (!['blocked', 'failed'].includes(task.status) && !(task.status === 'submission_unknown' && options.force)) {
    throw new Error(`Resume requires blocked/failed; current: ${task.status}`);
  }
  if (task.watcherPid && processAlive(task.watcherPid)) throw new Error('A watcher is still active for this task');
  await ensureServer(task.herdrSession);
  if (options.workspace || options.pane || options['new-workspace']) {
    if (!options.force) throw new Error('Explicit recovery placement requires --force after confirming the original worker stopped');
    if (!task.workerSessionId) throw new Error('No worker session ID available for recovery');
    task.recoveryPlacement = placementFor({ ...options, session: task.herdrSession }, {});
    await launchWorker(task, task.workerSessionId, { trustFolder: true });
    await submit(task, pendingRoundPrompt(task));
    return task;
  }
  if (options.force) {
    try { assertWorker(task, agentInfo(task.herdrSession, task.paneId)); }
    catch {
      if (!task.workerSessionId) throw new Error('No worker session ID available for an explicit recreation');
      await launchWorker(task, task.workerSessionId, { trustFolder: true });
    }
    await submit(task, pendingRoundPrompt(task));
    return task;
  }
  let relaunched = false;
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
  } catch (error) {
    if (!missingWorker(error)) throw error;
    const promptBody = pendingRoundPrompt(task);
    if (!task.workerSessionId || !promptBody) {
      throw new Error('Worker pane is gone and no worker session ID or pending prompt could be recovered');
    }
    await launchWorker(task, task.workerSessionId, { trustFolder: true });
    relaunched = true;
  }
  task.status = 'running';
  task.error = null;
  task.history.push({ round: task.round, status: 'resumed', timestamp: now(), relaunched });
  // Refresh protocol state before waiting; a just-answered dialog may still look blocked. / 等待前刷新协议状态，刚答复的对话框可能仍显示阻塞。
  if (!relaunched) await getAgent(task.agent).refreshWorker?.(task);
  delete task.blocker;
  saveTask(task);
  if ((relaunched && getAgent(task.agent).replayOnRelaunch !== false) || task.round === 0) {
    await submit(task, pendingRoundPrompt(task));
    return task;
  }
  if (!relaunched && getAgent(task.agent).resumeInput) {
    api(task.herdrSession, ['pane', 'send-text', task.paneId, getAgent(task.agent).resumeInput]);
    api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
    await waitForAgent(task, ['working', 'idle', 'done'], 20000);
  }
  task.watcherPid = startWatcher(task.id);
  saveTask(task);
  event(task, 'resumed', { round: task.round });
  return task;
}

function accept(options) {
  const task = loadTask(required(options._[0], 'task id'));
  if (task.status !== 'review_pending') throw new Error(`Accept requires review_pending; current: ${task.status}`);
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

async function recoverOne(task) {
  const actions = [];
  if (['created', 'ready', 'recovering'].includes(task.status)) {
    task.status = 'failed';
    task.error = 'Startup was interrupted; inspect the saved pane before explicit rework or cancellation';
    saveTask(task);
    actions.push('interrupted startup marked failed; no task automatically retransmitted');
  }
  if (task.status === 'submission_unknown') {
    const agent = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    if (agent.agent_status === 'working' || agent.agent_status === 'blocked'
        || agent.completion_seq > (task.submission?.baselineCompletion || 0)) {
      task.status = 'running';
      task.submission.status = 'observed';
      saveTask(task);
      actions.push('submission activity confirmed; no prompt retransmitted');
    } else {
      return ['submission remains uncertain; inspect the pane before any manual retry'];
    }
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
      // A transport failure is not proof that execution stopped. / 连接错误不能证明原任务已经停止。
      task.status = 'failed';
      task.error = `Worker unavailable: ${error.message}. Inspect execution before resume; no prompt retransmitted`;
      saveTask(task);
      event(task, 'recovery_failed', { message: task.error });
      actions.push('worker unavailable; explicit resume required, no prompt retransmitted');
    }
  } else if (['review_pending', 'delivery_missing', 'blocked', 'failed'].includes(task.status)) {
    if (!['queued', 'acknowledged', 'delivered'].includes(task.notification?.status)
        || task.notification?.codexThread && task.notification.codexThread !== task.codexThread) {
      const { notifyTask } = require('../lib/notify');
      await notifyTask(task);
      actions.push(`notification ${task.notification?.status || 'pending'}`);
    } else if (task.status === 'failed' || task.status === 'blocked') {
      // Keep notifications idempotent; resuming requires an explicit action. / 通知去重，任务恢复需要显式操作。
      actions.push(`already notified; run \`resume ${task.id}\` to retry in the same CBC session`);
    } else {
      actions.push('already notified; awaiting review (rework or accept)');
    }
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
        return { taskId: id, actions: await recoverOne(task) };
      }));
    } catch (error) {
      results.push({ taskId: id, error: error.message });
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

async function main() {
  const command = process.argv[2];
  const options = parse(process.argv.slice(3));
  let result;
  const mutations = { rework, resume, cancel, accept, ack };
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
  else if (command === 'dispatch') {
    options['task-id'] ||= makeTaskId();
    result = await withLock('dispatch-global', () => withLock(options['task-id'], () => dispatch(options)));
  }
  else if (['rework', 'resume', 'accept'].includes(command)) {
    result = await withLock('dispatch-global', () => withLock(required(options._[0], 'task id'), () => mutations[command](options)));
  }
  else if (mutations[command]) result = await withLock(required(options._[0], 'task id'), () => mutations[command](options));
  else if (command === 'recover') result = await withLock('dispatch-global', () => recover(options));
  else if (command === 'status') result = loadTask(required(options._[0], 'task id'));
  else if (command === 'read') {
    const task = loadTask(required(options._[0], 'task id'));
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    result = { taskId: task.id, round: task.round, text: agentText(task.herdrSession, task.paneId) };
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
    throw new Error('Usage: agent-bridge <dispatch|rework|resume|status|read|cancel|accept|ack|recover|notifications|list|agents|sessions> [options]');
  }
  if (['accept', 'cancel', 'rework', 'resume'].includes(command) && result.codexThread) {
    try { await require('../lib/notification-control').reconcileThread(result.codexThread); }
    catch (error) { result.notificationCleanupError = error.message; }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code || 'AGENT_BRIDGE_ERROR' })}\n`);
  process.exitCode = 1;
});

module.exports = { parse, dispatch, submit, recoverOne, accept, ack, main, assertSingleActive, failDispatch };
