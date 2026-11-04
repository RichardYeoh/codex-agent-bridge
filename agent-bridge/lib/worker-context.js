'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { config, readJson, writeJsonAtomic, now, event, saveTask, taskDir, processAlive } = require('./util');
const { agentInfo, api, resultPayload } = require('./herdr');
const { getAgent, chooseAgentName, matchesHerdrAgent } = require('./agents');
const { writeLease } = require('./worker-lease');
const { POLICY_VERSION, renderWorkerPolicy } = require('./worker-policy');
const { bindingKey, sameBinding } = require('./worker-binding');

function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function projectKey(cwd, agent, session, workerKey) {
  const canonical = path.resolve(cwd);
  return digest(`${process.platform === 'win32' ? canonical.toLowerCase() : canonical}\n${agent}\n${session}`
    + (workerKey === undefined ? '' : `\n${bindingKey(workerKey)}`));
}
function contextPath(task) {
  return path.join(task.stateDir, 'worker-contexts', `${projectKey(task.cwd, task.agent, task.herdrSession, bindingKey(task.workerKey))}.json`);
}
function loadContext(task) {
  const current = readJson(contextPath(task), null);
  if (current) return current;
  // Legacy receipts belong only to the default binding. / 旧版回执只归默认绑定，不能挪给其他上下文。
  if (bindingKey(task.workerKey) !== 'primary') return null;
  return readJson(path.join(task.stateDir, 'worker-contexts', `${projectKey(task.cwd, task.agent, task.herdrSession)}.json`), null);
}
function listContexts(cwd, agent, workerKey) {
  // Nicknames resolve to the existing persisted identity, never a second context namespace. / 昵称映射到既有持久身份，不另建上下文命名空间。
  const canonicalAgent = agent ? getAgent(agent).id : null;
  const root = path.join(config().stateDir, 'worker-contexts');
  return (fs.existsSync(root) ? fs.readdirSync(root) : []).filter(name => name.endsWith('.json'))
    .map(name => readJson(path.join(root, name)))
    .filter(item => (!cwd || path.resolve(item.cwd).toLowerCase() === path.resolve(cwd).toLowerCase())
      && (!canonicalAgent || item.agent === canonicalAgent) && (workerKey === undefined || bindingKey(item.workerKey) === bindingKey(workerKey)))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(item => {
      let actualTaskStatus = null;
      try {
        const source = readJson(path.join(taskDir(item.lastTaskId), 'task.json'), null);
        if (source && source.workerSessionId === item.workerSessionId && sameBinding(source, item)) actualTaskStatus = source.status;
      } catch {}
      return { ...item, workerKey: bindingKey(item.workerKey), actualTaskStatus };
    })
    .filter((item, index, entries) => entries.findIndex(other => projectKey(other.cwd, other.agent, other.herdrSession, other.workerKey)
      === projectKey(item.cwd, item.agent, item.herdrSession, item.workerKey)) === index);
}
function background(task) { return task.taskSpec?.projectContext || task.taskSpec?.background || ''; }

function observedContext(task) {
  const file = path.join(task.stateDir, 'hook-events.ndjson');
  if (!fs.existsSync(file)) return null;
  let sessionId = null;
  let compactAt = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      if (entry.herdrSession !== task.herdrSession || entry.paneId !== task.paneId
          || (task.workerStartedAt && entry.timestamp < task.workerStartedAt)) continue;
      if (entry.taskId !== task.id || entry.terminalId && task.terminalId && entry.terminalId !== task.terminalId) continue;
      if (task.agent === 'agy' && (entry.source !== 'agy-native-hook' || entry.terminalId !== task.terminalId)) continue;
      if (entry.sessionId) sessionId = entry.sessionId;
      if (entry.source === 'compact') compactAt = entry.timestamp;
    } catch {}
  }
  return sessionId ? { sessionId, compactAt } : null;
}

function recordContext(task) {
  if (!task.workerSessionId || !task.taskSpec || task.submission?.status !== 'observed'
      || !['review_pending', 'accepted'].includes(task.status)) return;
  const previous = loadContext(task);
  writeJsonAtomic(contextPath(task), {
    cwd: task.cwd, agent: task.agent, herdrSession: task.herdrSession, workspaceId: task.workspaceId,
    workerKey: bindingKey(task.workerKey), mainPaneId: task.mainPaneId,
    lastGoal: task.taskSpec.goal, lastWriteScope: task.allowedWritePaths || task.taskSpec.allowedChanges,
    tabId: task.tabId, paneId: task.paneId, terminalId: task.terminalId,
    workerSessionId: task.workerSessionId, workerStartedAt: task.workerStartedAt,
    lastTaskId: task.id, lastRound: task.round, lastStatus: task.status,
    projectContext: background(task), projectContextSha256: digest(background(task)),
    taskBackgroundSha256: digest(task.taskSpec.background),
    policyVersion: task.workerPolicyVersion, policySha256: task.workerPolicySha256,
    model: task.model, effort: task.effort, permissionMode: task.permissionMode,
    skipPermissions: task.skipPermissions, updatedAt: now(),
    zcodeBindingSha256: task.zcodeBindingSha256,
    agyDeliveryProfile: task.agyDeliveryProfile,
    history: [...(previous?.history || []).slice(-19), { taskId: task.id, round: task.round, status: task.status }],
  });
}

function preparePromptContext(task, delta) {
  const prior = loadContext(task);
  task.promptContext = { mode: 'full', reason: 'new or unverified context' };
  if (task.forceFullContext) { task.promptContext.reason = 'explicit full-context request'; return; }
  if (!task.taskSpec || !prior || prior.workerSessionId !== task.workerSessionId
      || (prior.terminalId !== task.terminalId && task.restoredContextSessionId !== prior.workerSessionId)
      || prior.policyVersion !== POLICY_VERSION
      || prior.policySha256 !== task.workerPolicySha256 || prior.projectContextSha256 !== digest(background(task))) return;
  // Compact boundaries invalidate old receipts; the model needs a fresh baseline. / 压缩边界使旧确认失效，需要重发完整基线。
  if (task.contextInvalidatedAt && task.contextInvalidatedAt > prior.updatedAt) return;
  task.promptContext = { mode: 'delta', sessionId: task.workerSessionId,
    previousTaskId: prior.lastTaskId, previousRound: prior.lastRound,
    projectContextSha256: prior.projectContextSha256,
    delta: [delta || task.taskSpec.goal, ...task.taskSpec.requirements,
      ...(prior.taskBackgroundSha256 !== digest(task.taskSpec.background) ? [`本轮背景：${task.taskSpec.background}`] : []),
      ...task.taskSpec.inputs.map(item => `输入：${item.path}；用途：${item.purpose}`),
      ...task.taskSpec.steps, ...task.taskSpec.preserve.map(item => `保留：${item}`),
      ...task.taskSpec.edgeCases.map(item => `边界：${item}`), ...task.taskSpec.examples,
      ...task.taskSpec.nonGoals.map(item => `不在范围：${item}`),
      ...task.taskSpec.stopConditions.map(item => `停止条件：${item}`),
      ...task.taskSpec.followupChanges],
  };
}

function tryReuseContext(task, { fresh = false, inspect = agentInfo, call = api, attest = observedContext } = {}) {
  const explicit = Boolean(task.resumeFromTaskId);
  if (explicit && (fresh || task.agent !== 'cbc')) throw new Error('--resume-task requires CBC and cannot be combined with --new-session');
  if (fresh || !task.taskSpec) return false;
  let prior = loadContext(task);
  const priorTask = explicit ? readJson(path.join(taskDir(task.resumeFromTaskId), 'task.json'), null)
    : prior ? readJson(path.join(task.stateDir, 'tasks', prior.lastTaskId, 'task.json'), null) : null;
  const cancelled = task.agent === 'cbc' && priorTask?.status === 'cancelled';
  const requireReuse = explicit || cancelled;
  const unavailable = reason => { if (requireReuse) throw new Error('CBC original session reuse refused: ' + reason + '; no new session created'); return false; };
  if (explicit || cancelled) {
    if (!priorTask || !['accepted', 'cancelled'].includes(priorTask.status)) return unavailable('source task is not accepted or cancelled');
    if (!sameBinding(task, priorTask) || !priorTask.workerSessionId) return unavailable('source project, worker binding or native ID mismatch');
    if (priorTask.watcherPid && processAlive(priorTask.watcherPid)) return unavailable('source watcher is still active');
    const conflict = require('./worker-scheduling').taskList(task.stateDir).find(other => other.id !== task.id && other.id !== priorTask.id
      && other.agent === 'cbc' && other.workerSessionId === priorTask.workerSessionId && !['accepted', 'cancelled'].includes(other.status));
    if (conflict) return unavailable('native session has another unresolved owner');
    // A terminal task is identity evidence, never an accepted technical delivery. / 终态任务仅提供身份依据，不代表技术交付已通过。
    prior = { ...priorTask, lastTaskId: priorTask.id, lastStatus: priorTask.status,
      policyVersion: priorTask.workerPolicyVersion, policySha256: priorTask.workerPolicySha256 };
  }
  if (!prior || (!requireReuse && prior.lastStatus !== 'accepted') || prior.policyVersion !== POLICY_VERSION) return unavailable('no compatible policy receipt');
  if (prior.policySha256 !== digest(renderWorkerPolicy(task))) return unavailable('worker policy changed');
  if (task.placement?.mode === 'workspace'
      || (task.placement?.workspaceId && task.placement.workspaceId !== prior.workspaceId)) return unavailable('workspace placement changed');
  if (task.permissionExplicit === false && typeof prior.skipPermissions === 'boolean') {
    task.permissionMode = prior.permissionMode; task.skipPermissions = prior.skipPermissions;
  }
  if ((task.model && prior.model !== task.model) || (task.effort && prior.effort !== task.effort)
      || prior.skipPermissions !== task.skipPermissions || prior.permissionMode !== task.permissionMode) return unavailable('model or permission profile changed');
  if (!requireReuse && priorTask?.status !== 'accepted') return false;
  if (task.agent === 'zcode') {
    let priorBinding = prior.zcodeBindingSha256;
    if (!priorBinding && priorTask.zcodeConfig) {
      priorBinding = digest(JSON.stringify(require('./zcode-remote').readBinding(priorTask.zcodeConfig)));
    }
    if (priorBinding !== task.zcodeBindingSha256) return false;
  }
  const inherit = () => Object.assign(task, { workerSessionId: prior.workerSessionId,
    ...(task.agent === 'cbc' && require('./worker-identity').cbcProcessProof(priorTask)
      ? { cbcPriorProcessProof: require('./worker-identity').cbcProcessProof(priorTask) } : {}),
    agyDeliveryProfile: prior.agyDeliveryProfile || priorTask.agyDeliveryProfile,
    reusedFromTaskId: prior.lastTaskId, model: task.model || prior.model, effort: task.effort || prior.effort,
    ...(cancelled ? { forceFullContext: true, reusedTerminalStatus: 'cancelled' } : {}),
    mainPaneId: task.placement?.anchorPaneId || task.mainPaneId || prior.mainPaneId });
  let agent;
  try { agent = inspect(task.herdrSession, prior.paneId); }
  catch (error) {
    if (!['agent_not_found', 'pane_not_found', 'agent_not_registered'].includes(error.herdrCode)) throw error;
    if (error.herdrCode !== 'pane_not_found') {
      let paneMissing = false;
      try { call(task.herdrSession, ['pane', 'get', prior.paneId]); }
      catch (paneError) { if (paneError.herdrCode === 'pane_not_found') paneMissing = true; else throw paneError; }
      if (!paneMissing) throw new Error('Saved worker Pane still exists without a registered agent; inspect before resuming');
    }
    require('./worker-identity').assertWorkerAbsent({ ...priorTask, herdrSession: task.herdrSession, agent: task.agent,
      paneId: prior.paneId, terminalId: prior.terminalId, workerSessionId: prior.workerSessionId }, { call });
    inherit(); task.resumeContextSessionId = prior.workerSessionId;
    event(task, 'worker_context_resume_planned', { priorTaskId: prior.lastTaskId });
    return false;
  }
  try {
    if (!matchesHerdrAgent(task.agent, agent.agent) || agent.terminal_id !== prior.terminalId
        || !['idle', 'done'].includes(agent.agent_status)) throw new Error('Saved worker identity or idle state changed; inspect before creating another session');
    // Prefer the official native reference; use bound Hook evidence only for older integrations. / 优先使用官方原生引用，旧集成才使用绑定Hook证据。
    const receipt = agent.agent_session?.value ? { sessionId: agent.agent_session.value }
      : attest({ ...task, id: prior.lastTaskId, paneId: prior.paneId, terminalId: prior.terminalId, workerStartedAt: prior.workerStartedAt });
    if (receipt?.sessionId !== prior.workerSessionId) throw new Error('Saved worker session changed; inspect before creating another session');
    if (task.placement?.mode === 'pane') {
      const anchor = resultPayload(call(task.herdrSession, ['pane', 'get', task.placement.anchorPaneId])).pane;
      if (anchor?.workspace_id !== prior.workspaceId) return unavailable('anchor workspace changed');
    }
    const values = resultPayload(call(task.herdrSession, ['agent', 'list'])).agents;
    inherit();
    Object.assign(task, { workspaceId: prior.workspaceId, tabId: prior.tabId, paneId: prior.paneId,
      terminalId: prior.terminalId, workerSessionId: prior.workerSessionId,
      workerStartedAt: prior.workerStartedAt, agentName: chooseAgentName(task.agent, values, prior.paneId),
      reusedFromTaskId: prior.lastTaskId, model: task.model || prior.model, effort: task.effort || prior.effort });
    if (receipt.compactAt) task.contextInvalidatedAt = receipt.compactAt;
    call(task.herdrSession, ['agent', 'rename', task.paneId, task.agentName]);
    task.status = 'ready';
    writeLease(task);
    saveTask(task);
    event(task, 'worker_reused', { priorTaskId: prior.lastTaskId, workerSessionId: prior.workerSessionId });
    return true;
  } catch (error) {
    event(task, 'worker_reuse_unavailable', { message: error.message });
    throw error;
  }
}

module.exports = { digest, projectKey, contextPath, loadContext, listContexts, recordContext, preparePromptContext, tryReuseContext, observedContext };
