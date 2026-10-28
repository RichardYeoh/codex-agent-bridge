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
  if (result.error || result.status !== 0) throw new Error(`OpenCode ${operation} unavailable (${result.error?.code || 'API_ERROR'}); inspect native CLI`);
  if (!result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout);
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

function configure(task, request = call) {
  const params = { sessionID: task.workerSessionId };
  const info = request('session.get', params, undefined, task.cwd);
  verifySession(task, info);
  if (request('session.active', {}, undefined, task.cwd)[info.id]) throw new Error('OpenCode session is already running; no task resubmitted');
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
  const params = { sessionID: task.workerSessionId };
  let info = request('session.get', params, undefined, task.cwd);
  verifySession(task, info);
  const active = request('session.active', {}, undefined, task.cwd)[info.id];
  const permissions = request('session.permission.list', params, undefined, task.cwd);
  const forms = request('session.form.list', params, undefined, task.cwd);
  if (permissions.length || forms.length) return { state: 'blocked', reason: 'user_input_required', originalExecutionMayContinue: true };
  if (active) return { state: 'working' };
  // Completion may race the earlier get; refresh outcome before publishing idle. / 完成可能与前次get并发，发布空闲前刷新结果。
  info = request('session.get', params, undefined, task.cwd);
  verifySession(task, info);
  if (request('session.active', {}, undefined, task.cwd)[info.id]) return { state: 'working' };
  if (info.outcome === 'failed') return { state: 'blocked', reason: 'execution_failed', originalExecutionMayContinue: false };
  return { state: 'idle', outcome: info.outcome || null, idleAt: info.time?.idle || 0 };
}

function interrupt(task, request = call) {
  request('session.interrupt', { sessionID: task.workerSessionId, resume: 'false' }, undefined, task.cwd);
  const state = snapshot(task, request);
  if (state.state !== 'idle') throw new Error('OpenCode interruption not confirmed');
}

function submitWorker(task, text, request = call, report = publish) {
  // Stable admission IDs make ambiguous delivery inspectable without automatic retries. / 稳定准入ID便于核对不确定提交，不自动重试。
  const id = 'msg_bridge' + crypto.createHash('sha256').update(`${task.stateDir}\n${task.id}\n${task.round}`).digest('hex').slice(0, 32);
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-opencode-admission.json`);
  writeJsonAtomic(file, { id, sessionId: task.workerSessionId, status: 'sending', timestamp: now() });
  const admission = request('session.prompt', { sessionID: task.workerSessionId }, { id, text }, task.cwd);
  if (admission?.id !== id) throw new Error('OpenCode prompt admission ID mismatch');
  writeJsonAtomic(file, { id, sessionId: task.workerSessionId, status: 'confirmed', timestamp: now() });
  // Admission is real activity even if a short turn finishes between snapshots. / 准入即真实活动，短任务在快照间完成也不能丢失活动证据。
  report(task, { state: 'working', reason: 'admitted' });
}

function idleBelongsToRound(task, state) {
  if (state.state !== 'idle' || !['running', 'submission_unknown'].includes(task.status)) return true;
  const submitted = task.history?.findLast(item => item.round === task.round && item.status === 'submitted');
  return state.idleAt >= Date.parse(submitted?.timestamp || task.createdAt);
}

function publish(task, state, report = require('./herdr').api) {
  const receipt = { timestamp: now(), taskId: task.id, herdrSession: task.herdrSession, paneId: task.paneId,
    sessionId: task.workerSessionId, round: task.round, name: state.state === 'working' ? 'UserPromptSubmit' : 'Stop', source: 'opencode-api', ...state };
  const file = path.join(taskDir(task.id), 'opencode-state.json');
  const previous = readJson(file, null);
  const fields = ['taskId', 'round', 'herdrSession', 'paneId', 'sessionId', 'state', 'reason', 'outcome', 'idleAt', 'originalExecutionMayContinue'];
  if (previous?.reported && fields.every(key => previous[key] === receipt[key])) return;
  fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify(receipt) + '\n');
  writeJsonAtomic(file, { ...receipt, reported: false });
  report(task.herdrSession, ['pane', 'report-agent', task.paneId, '--source', 'custom:agent-bridge-opencode',
    '--agent', 'opencode', '--state', state.state, '--seq', String(Date.now()), '--agent-session-id', task.workerSessionId]);
  writeJsonAtomic(file, { ...receipt, reported: true });
}

module.exports = { call, prepareWorker, configure, snapshot, interrupt, submitWorker, verifySession, modelRef, idleBelongsToRound, publish };
