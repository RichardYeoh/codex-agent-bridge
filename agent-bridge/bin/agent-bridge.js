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
    if (['json', 'force', 'trust-folder', 'no-skip-permissions', 'resend-notification', 'new-workspace'].includes(key)) options[key] = true;
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
  return readText(session, ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '160']);
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
        const error = new Error('CBC is blocked by a permission or question prompt; inspect the Herdr pane');
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
  task.createdLocation = { mode: created.mode, ownsWorkspace: created.ownsWorkspace };
  delete task.recoveryPlacement;
  delete task.agentNameReleased;
  task.workerStartedAt = now();
  task.agentName = null;
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
    }
    try {
      const agent = agentInfo(task.herdrSession, task.paneId);
      if (['idle', 'done', 'working'].includes(agent.agent_status)) {
        const live = resultPayload(api(task.herdrSession, ['agent', 'list'])).agents;
        task.agentName = chooseAgentName(task.agent, live, task.paneId);
        api(task.herdrSession, ['agent', 'rename', task.paneId, task.agentName]);
        api(task.herdrSession, ['pane', 'rename', task.paneId, getAgent(task.agent).displayName || task.agent]);
        task.terminalId = agent.terminal_id;
        updateWorkerSession(task);
        task.status = 'ready';
        saveTask(task);
        return;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`Worker did not register within 120s (pane ${task.paneId})`);
}

function deliveryInstructions(task) {
  return [
    '你是由 Codex 委派的独立执行 Agent（通过 agent-bridge 调度）。请完成本文件末尾的任务，并以真实文件和测试结果为准。',
    `工作目录：${task.cwd}`,
    '未经任务明确要求，不修改其他目录，不修改任何 Codex 配置。',
    '交付前必须将 Markdown 交付报告写到以下绝对路径：',
    task.deliveryPath,
    '报告包含：完成内容、修改文件、实际执行的命令与结果、测试证据、未解决项、当前返工轮次。',
    '不得只声称完成；如果无法完成任务或无法写报告，在报告中明确说明阻塞原因。',
    '你的最终回复只写一行：交付报告路径。',
    '',
    '=== 任务与验收要求 ===',
  ].join('\n');
}

async function submit(task, promptBody, { activityTimeoutMs = 20000, startWatcherFn = startWatcher } = {}) {
  if (!promptBody) throw new Error('No pending task brief is available');
  assertSingleActive(task.id);
  const before = assertWorker(task, agentInfo(task.herdrSession, task.paneId));
  if (!['idle', 'done'].includes(before.agent_status)) {
    throw new Error(`Worker is not ready for a new round: ${before.agent_status}`);
  }
  const dir = ensureDir(taskDir(task.id));
  task.round += 1;
  const round = String(task.round).padStart(3, '0');
  task.promptPath = path.join(dir, `round-${round}-prompt.md`);
  task.deliveryPath = path.join(dir, 'deliveries', `round-${round}.md`);
  ensureDir(path.dirname(task.deliveryPath));
  fs.writeFileSync(task.promptPath, `${deliveryInstructions(task)}\n${promptBody}\n`);
  task.status = 'running';
  task.submission = { status: 'preparing', baselineCompletion: before.completion_seq || 0 };
  task.error = null;
  task.history.push({ round: task.round, status: 'submitted', timestamp: now() });
  saveTask(task);

  const pointer = `请读取任务文件 ${task.promptPath} 并严格按文件要求执行任务，完成后按文件内要求生成交付报告。不要在回复中复述任务内容。`;
  // Submission is never retried on an ambiguous timeout. / 提交超时结果不确定时禁止自动重发。
  task.submission.status = 'sending';
  saveTask(task);
  try {
    if (getAgent(task.agent).promptMode === 'pane-input') {
      // CBC is hook-recognized, not a native Herdr agent kind. / CBC 由 hook 识别，尚非 Herdr 原生 Agent 类型。
      api(task.herdrSession, ['pane', 'send-text', task.paneId, pointer]);
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
  task.notification = { status: 'pending', round: task.round };
  saveTask(task);
  task.watcherPid = startWatcherFn(task.id);
  saveTask(task);
  event(task, 'submitted', { paneId: task.paneId, round: task.round, watcherPid: task.watcherPid });
}

async function dispatch(options) {
  const promptBody = promptFrom(options);
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
  const herdrSession = options.session || config().defaultSession;
  const task = {
    schemaVersion: 1,
    id: options['task-id'] || makeTaskId(),
    agent: worker.id,
    placement: placementFor(options),
    cwd,
    herdrSession,
    stateDir: config().stateDir,
    permissionMode: options['permission-mode'] || config().defaultPermissionMode,
    skipPermissions: !options['no-skip-permissions'],
    model: options.model || null,
    effort: options.effort || null,
    waitTimeoutMs,
    codexThread: options['codex-thread'] || detectCodexThread(herdrSession),
    round: 0,
    status: 'created',
    history: [],
    createdAt: now(),
  };
  assertSingleActive(task.id);
  if (fs.existsSync(path.join(taskDir(task.id), 'task.json'))) throw new Error(`Task already exists: ${task.id}`);
  task.initialPromptPath = path.join(ensureDir(taskDir(task.id)), 'initial-request.md');
  fs.writeFileSync(task.initialPromptPath, `${promptBody}\n`);
  saveTask(task);
  try {
    await ensureServer(task.herdrSession);
    await launchWorker(task, null, { trustFolder: Boolean(options['trust-folder']) });
    await submit(task, promptBody);
  } catch (error) {
    if (task.status !== 'submission_unknown') task.status = error.code === 'AGENT_BRIDGE_BLOCKED' ? 'blocked' : 'failed';
    task.error = error.message;
    task.history.push({ round: task.round, status: task.status, timestamp: now(), message: error.message });
    saveTask(task);
    event(task, 'dispatch_failed', { message: error.message });
    throw error;
  }
  return task;
}

function assertSingleActive(taskId) {
  const tasksRoot = path.join(config().stateDir, 'tasks');
  for (const id of fs.existsSync(tasksRoot) ? fs.readdirSync(tasksRoot) : []) {
    const existing = readJson(path.join(tasksRoot, id, 'task.json'), null);
    if (existing && existing.id !== taskId && ['created', 'ready', 'running', 'blocked', 'recovering', 'submission_unknown', 'cancel_pending'].includes(existing.status)) {
      throw new Error(`Another worker task is active: ${existing.id} (${existing.status})`);
    }
  }
}

async function ensureWorkerAlive(task) {
  try {
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    return;
  } catch (error) { if (!missingWorker(error)) throw error; }
  if (!task.workerSessionId) {
    throw new Error('Worker pane is gone and no CBC session ID was captured; start a new dispatch instead');
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
    api(task.herdrSession, ['pane', 'send-keys', task.paneId, 'esc']);
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
      throw new Error('Worker pane is gone and no CBC session ID or pending prompt could be recovered');
    }
    await launchWorker(task, task.workerSessionId, { trustFolder: true });
    relaunched = true;
  }
  task.status = 'running';
  task.error = null;
  task.history.push({ round: task.round, status: 'resumed', timestamp: now(), relaunched });
  delete task.blocker;
  saveTask(task);
  if (relaunched || task.round === 0) {
    await submit(task, pendingRoundPrompt(task));
    return task;
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
  else if (['rework', 'resume'].includes(command)) {
    result = await withLock('dispatch-global', () => withLock(required(options._[0], 'task id'), () => mutations[command](options)));
  }
  else if (mutations[command]) result = await withLock(required(options._[0], 'task id'), () => mutations[command](options));
  else if (command === 'recover') result = await withLock('dispatch-global', () => recover(options));
  else if (command === 'status') result = loadTask(required(options._[0], 'task id'));
  else if (command === 'read') {
    const task = loadTask(required(options._[0], 'task id'));
    assertWorker(task, agentInfo(task.herdrSession, task.paneId));
    result = { taskId: task.id, round: task.round, text: agentText(task.herdrSession, task.paneId) };
  } else if (command === 'agents') {
    result = listAgents();
  } else if (command === 'list') {
    const root = path.join(config().stateDir, 'tasks');
    result = fs.existsSync(root) ? fs.readdirSync(root)
      .filter(id => fs.existsSync(path.join(root, id, 'task.json')))
      .map(id => readJson(path.join(root, id, 'task.json'))) : [];
  } else {
    throw new Error('Usage: agent-bridge <dispatch|rework|resume|status|read|cancel|accept|ack|recover|notifications|list|agents> [options]');
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

module.exports = { parse, dispatch, submit, recoverOne, accept, ack, main, assertSingleActive };
