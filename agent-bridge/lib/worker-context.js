'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { config, readJson, writeJsonAtomic, now, event, saveTask } = require('./util');
const { agentInfo, api, resultPayload } = require('./herdr');
const { getAgent, chooseAgentName } = require('./agents');
const { writeLease } = require('./worker-lease');
const { POLICY_VERSION, renderWorkerPolicy } = require('./worker-policy');

function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function projectKey(cwd, agent, session) {
  const canonical = path.resolve(cwd);
  return digest(`${process.platform === 'win32' ? canonical.toLowerCase() : canonical}\n${agent}\n${session}`);
}
function contextPath(task) {
  return path.join(task.stateDir, 'worker-contexts', `${projectKey(task.cwd, task.agent, task.herdrSession)}.json`);
}
function listContexts(cwd, agent) {
  const root = path.join(config().stateDir, 'worker-contexts');
  return (fs.existsSync(root) ? fs.readdirSync(root) : []).filter(name => name.endsWith('.json'))
    .map(name => readJson(path.join(root, name)))
    .filter(item => (!cwd || path.resolve(item.cwd).toLowerCase() === path.resolve(cwd).toLowerCase())
      && (!agent || item.agent === agent));
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
      if (entry.sessionId) sessionId = entry.sessionId;
      if (entry.source === 'compact') compactAt = entry.timestamp;
    } catch {}
  }
  return sessionId ? { sessionId, compactAt } : null;
}

function recordContext(task) {
  if (!task.workerSessionId || !task.taskSpec || task.submission?.status !== 'observed'
      || !['review_pending', 'accepted'].includes(task.status)) return;
  const previous = readJson(contextPath(task), null);
  writeJsonAtomic(contextPath(task), {
    cwd: task.cwd, agent: task.agent, herdrSession: task.herdrSession, workspaceId: task.workspaceId,
    tabId: task.tabId, paneId: task.paneId, terminalId: task.terminalId,
    workerSessionId: task.workerSessionId, workerStartedAt: task.workerStartedAt,
    lastTaskId: task.id, lastRound: task.round, lastStatus: task.status,
    projectContext: background(task), projectContextSha256: digest(background(task)),
    taskBackgroundSha256: digest(task.taskSpec.background),
    policyVersion: task.workerPolicyVersion, policySha256: task.workerPolicySha256,
    model: task.model, effort: task.effort, permissionMode: task.permissionMode,
    skipPermissions: task.skipPermissions, updatedAt: now(),
    zcodeBindingSha256: task.zcodeBindingSha256,
    history: [...(previous?.history || []).slice(-19), { taskId: task.id, round: task.round, status: task.status }],
  });
}

function preparePromptContext(task, delta) {
  const prior = readJson(contextPath(task), null);
  task.promptContext = { mode: 'full', reason: 'new or unverified context' };
  if (task.forceFullContext) { task.promptContext.reason = 'explicit full-context request'; return; }
  if (!task.taskSpec || !prior || prior.workerSessionId !== task.workerSessionId
      || prior.terminalId !== task.terminalId || prior.policyVersion !== POLICY_VERSION
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
  if (fresh || !task.taskSpec) return false;
  const prior = readJson(contextPath(task), null);
  if (!prior || prior.lastStatus !== 'accepted' || prior.policyVersion !== POLICY_VERSION) return false;
  if (prior.policySha256 !== digest(renderWorkerPolicy(task))) return false;
  if (task.agent === 'zcode' && prior.zcodeBindingSha256 !== task.zcodeBindingSha256) return false;
  if (task.placement?.mode === 'workspace'
      || (task.placement?.workspaceId && task.placement.workspaceId !== prior.workspaceId)) return false;
  if ((task.model && prior.model !== task.model) || (task.effort && prior.effort !== task.effort)
      || prior.skipPermissions !== task.skipPermissions || prior.permissionMode !== task.permissionMode) return false;
  const priorTask = readJson(path.join(task.stateDir, 'tasks', prior.lastTaskId, 'task.json'), null);
  if (priorTask?.status !== 'accepted') return false;
  try {
    const agent = inspect(task.herdrSession, prior.paneId);
    if (agent.agent !== getAgent(task.agent).herdrAgent || agent.terminal_id !== prior.terminalId
        || !['idle', 'done'].includes(agent.agent_status)) return false;
    // Herdr 0.9.5 omits session IDs from pane/get; correlate the live terminal with Hook receipts. / Herdr 0.9.5查询不暴露会话ID，结合存活终端与Hook确认。
    const receipt = attest({ ...task, paneId: prior.paneId, workerStartedAt: prior.workerStartedAt });
    if (receipt?.sessionId !== prior.workerSessionId) return false;
    if (task.placement?.mode === 'pane') {
      const anchor = resultPayload(call(task.herdrSession, ['pane', 'get', task.placement.anchorPaneId])).pane;
      if (anchor?.workspace_id !== prior.workspaceId) return false;
    }
    const values = resultPayload(call(task.herdrSession, ['agent', 'list'])).agents;
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
    return false;
  }
}

module.exports = { digest, projectKey, contextPath, listContexts, recordContext, preparePromptContext, tryReuseContext, observedContext };
