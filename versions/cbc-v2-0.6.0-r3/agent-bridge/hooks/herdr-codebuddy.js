#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { config, readJson } = require('../lib/util');
const { leaseForEvent, leasePath, writeLease } = require('../lib/worker-lease');
const { captureSubmission, nativeTranscriptPath } = require('../lib/cbc-turn');
const { buildResumeArgv } = require('./herdr-resume');
const { readPaneIdentity } = require('./herdr-binding');

const states = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  Stop: 'idle',
  Notification: 'blocked',
};
const TERMINAL_TASK_STATUSES = new Set(['accepted', 'cancelled', 'abandoned']);

function resolveBinding(event, stateDir, paneId, herdrSession, herdrBinary, currentPane) {
  if (typeof event.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(event.session_id)) return null;
  const lease = leaseForEvent(stateDir, herdrSession, paneId, event.session_id);
  if (!lease?.taskId) return null;
  const task = readJson(path.join(stateDir, 'tasks', lease.taskId, 'task.json'), null);
  const pane = currentPane || readPaneIdentity(herdrBinary, herdrSession, paneId);
  if (!task || typeof task.stateDir !== 'string'
      || path.resolve(task.stateDir).toLowerCase() !== path.resolve(stateDir).toLowerCase()
      || task.agent !== 'cbc' || task.id !== lease.taskId
      || task.paneId !== paneId || task.herdrSession !== herdrSession
      || !pane || pane.paneId !== paneId || !task.terminalId || pane.terminalId !== task.terminalId
      || lease.terminalId !== task.terminalId
      || !Number.isInteger(task.round) || (event.round != null && event.round !== task.round)) return null;
  const firstBind = !task.workerSessionId && !lease.workerSessionId;
  const promotedBind = !task.workerSessionId && lease.workerSessionId === event.session_id;
  const existingBind = task.workerSessionId === event.session_id && lease.workerSessionId === event.session_id;
  if (!firstBind && !promotedBind && !existingBind) return null;
  if ((firstBind || promotedBind) && (!task.workerStartedAt
      || !lease.workerStartedAt || lease.workerStartedAt !== task.workerStartedAt
      || TERMINAL_TASK_STATUSES.has(task.status))) return null;
  if (lease.workerStartedAt && task.workerStartedAt && lease.workerStartedAt !== task.workerStartedAt) return null;
  if (firstBind) writeLease({ ...task, workerSessionId: event.session_id });
  return { lease, task, firstBind: firstBind || promotedBind };
}

async function report(binary, args) {
  if (process.env.AGENT_BRIDGE_HOOK_DRY_RUN === '1') {
    process.stdout.write(`${JSON.stringify({ binary, args })}\n`);
    return;
  }
  const child = spawn(binary, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  // Preserve hook order before CBC continues. / 等待状态上报完成后再继续，避免事件乱序。
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  const { HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH, AGENT_BRIDGE_HERDR_SESSION } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID || !HERDR_BIN_PATH || !AGENT_BRIDGE_HERDR_SESSION) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try { event = JSON.parse(input); }
  catch { return; }

  const name = event.hook_event_name || event.event;
  if (!Object.hasOwn(states, name) && name !== 'SessionEnd') return;
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;

  const stateDir = config().stateDir;
  const expectedBridgeBinding = Boolean(process.env.AGENT_BRIDGE_TASK_ID
    || readJson(leasePath(stateDir, AGENT_BRIDGE_HERDR_SESSION, HERDR_PANE_ID), null));
  // Standalone sessions are displayed by the installed CodeBuddy plugin. / 独立会话的显示由已安装CodeBuddy插件负责。
  if (!expectedBridgeBinding) return;
  let pane = null;
  if (expectedBridgeBinding || name === 'UserPromptSubmit') {
    try { pane = readPaneIdentity(HERDR_BIN_PATH, AGENT_BRIDGE_HERDR_SESSION, HERDR_PANE_ID); } catch {}
  }
  let binding = null;
  try { binding = resolveBinding(event, stateDir, HERDR_PANE_ID, AGENT_BRIDGE_HERDR_SESSION, HERDR_BIN_PATH, pane); } catch {}
  if (!binding && expectedBridgeBinding && name !== 'UserPromptSubmit') return;
  // V2 uses a task-only Hook and the installed status provider. / V2使用独立任务Hook和已安装的状态插件。
  if (binding?.task.taskProtocol === 2) return;
  const release = name === 'SessionEnd';
  if (release && !binding) return;

  const turnCapture = name === 'UserPromptSubmit' ? captureSubmission(event, binding?.task) : { promptSha256: null };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'hook-events.ndjson'), `${JSON.stringify({
      timestamp: new Date().toISOString(), name, source: event.source, paneId: HERDR_PANE_ID,
      sessionId: event.session_id, notificationType: event.notification_type,
      taskId: binding?.task.id || null, round: binding?.task.round ?? null,
      terminalId: binding?.task.terminalId || pane?.terminalId || null, herdrSession: AGENT_BRIDGE_HERDR_SESSION,
      identityBound: Boolean(binding),
      promptSha256: turnCapture.promptSha256,
      promptSha256Origin: turnCapture.promptSha256Origin || null,
      ...(name === 'UserPromptSubmit' && binding && nativeTranscriptPath(event.transcript_path, binding.task)
        ? { nativeTranscript: nativeTranscriptPath(event.transcript_path, binding.task) } : {}),
      ...(turnCapture.submissionAttemptId ? { submissionAttemptId: turnCapture.submissionAttemptId } : {}),
    })}\n`);
  } catch {}

  // Unbound submissions are journaled as hash-only boundaries; they cannot change Herdr task state. / 未绑定输入仅记录哈希边界，不得更改Herdr任务状态。
  if (!binding && expectedBridgeBinding) return;

  const state = name === 'SessionStart' && event.source === 'compact'
    ? 'working'
    : states[name];
  const args = [
    'pane', release ? 'release-agent' : 'report-agent', HERDR_PANE_ID,
    '--source', 'custom:agent-bridge',
    '--agent', 'codebuddy',
    '--seq', String(Date.now()),
  ];
  if (!release) args.push('--state', state);
  if (typeof event.session_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(event.session_id)) {
    args.push('--agent-session-id', event.session_id);
  }
  if (name === 'Notification') args.push('--message', 'CodeBuddy permission required');
  if (!release && binding && !TERMINAL_TASK_STATUSES.has(binding.task.status)) {
    const resume = buildResumeArgv(stateDir, binding.task.id, event.session_id);
    if (resume) args.push('--', ...resume);
  }
  await report(HERDR_BIN_PATH, args);
}

if (require.main === module) main().catch(() => {});
module.exports = { resolveBinding };
