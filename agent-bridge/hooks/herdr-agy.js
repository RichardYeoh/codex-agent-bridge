#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { config, loadTask, readJson, writeJsonAtomic, now, taskDir } = require('../lib/util');
const { leaseForEvent } = require('../lib/worker-lease');
const { classifyBlocker } = require('../lib/blocker');
const { buildResumeArgv } = require('./herdr-resume');
const { readPaneIdentity } = require('./herdr-binding');

const TERMINAL_TASK_STATUSES = new Set(['accepted', 'cancelled', 'abandoned']);

function hookContext(stateDir, herdrSession, paneId, sessionId, herdrBinary) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return null;
  const lease = leaseForEvent(stateDir, herdrSession, paneId, sessionId);
  const taskId = lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID;
  if (typeof taskId !== 'string' || !/^[a-z][a-z0-9-]{2,47}$/.test(taskId)) return null;
  const task = loadTask(taskId);
  const pane = readPaneIdentity(herdrBinary, herdrSession, paneId);
  if (task.agent !== 'agy' || task.id !== taskId || task.paneId !== paneId
      || task.herdrSession !== herdrSession || task.workerSessionId !== sessionId
      || (lease && lease.taskId !== task.id)) throw new Error('Agy Hook session or Pane binding mismatch');
  const identityBound = Boolean(lease && lease.paneId === task.paneId
    && lease.herdrSession === task.herdrSession && lease.taskId === task.id
    && lease.workerSessionId === sessionId && lease.terminalId
    && lease.terminalId === task.terminalId
    && pane?.paneId === paneId && pane.terminalId === task.terminalId
    && (!lease.workerStartedAt || !task.workerStartedAt || lease.workerStartedAt === task.workerStartedAt)
    && Number.isInteger(task.round));
  return { task, lease, identityBound };
}

function reportArgs(task, sessionId, state, resumeArgs) {
  const args = ['pane', 'report-agent', task.paneId, '--source', 'custom:agent-bridge-agy',
    '--agent', 'agy', '--state', state, '--seq', String(Date.now()),
    '--agent-session-id', sessionId];
  if (resumeArgs) args.push('--', ...resumeArgs);
  return args;
}

async function main() {
  const { HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH, AGENT_BRIDGE_HERDR_SESSION } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID || !HERDR_BIN_PATH || !AGENT_BRIDGE_HERDR_SESSION) return {};
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text), name = process.argv[2], sessionId = input.conversationId;
  const context = hookContext(config().stateDir, AGENT_BRIDGE_HERDR_SESSION, HERDR_PANE_ID, sessionId, HERDR_BIN_PATH);
  if (!context) return {};
  const { task, identityBound } = context;
  // Unknown Pane identity is not sufficient evidence to alter or attest task state. / Pane 身份未知时，不足以修改或证明任务状态。
  if (!identityBound) return {};
  const response = {};
  // "allow" delegates to the native permission policy; it is not auto_approve. / allow继续执行原生权限策略，并非auto_approve授权。
  if (name === 'PreToolUse') response.decision = 'allow';
  let state = name === 'SessionStart' ? 'idle' : 'working', reason;
  if (name === 'PreInvocation' && task.workerPolicyPath) {
    const policy = fs.readFileSync(task.workerPolicyPath, 'utf8');
    const digest = crypto.createHash('sha256').update(sessionId + '\n' + policy).digest('hex');
    const marker = path.join(taskDir(task.id), 'agy-policy-receipts', digest + '.json');
    if (!readJson(marker, null)) {
      response.injectSteps = [{ systemMessage: { systemMessage: policy, metadata: { source: 'codex-agent-bridge' } } }];
      writeJsonAtomic(marker, { sessionId, timestamp: now(), policySha256: task.workerPolicySha256 });
    }
    await require('../lib/messages').injectAgy(task, input, response);
  }
  if (name === 'PreToolUse' && (input.toolCall?.name !== 'notify_user' || input.toolCall?.args?.BlockedOnUser === true)) {
    state = 'blocked'; reason = 'user_input_required';
  }
  if (name === 'Stop') {
    if (input.error) { state = 'blocked'; reason = classifyBlocker(input.error)?.type || 'execution_error'; }
    else if (input.fullyIdle === true) state = 'idle';
    else { state = 'blocked'; reason = 'background_work_unconfirmed'; }
  }
  const receipt = { timestamp: now(), name, source: 'agy-native-hook',
    sessionId, taskId: task.id, herdrSession: task.herdrSession,
    paneId: task.paneId, terminalId: task.terminalId, round: task.round,
    messageHookVersion: 1, transcriptPath: input.transcriptPath,
    invocationNum: input.invocationNum, initialNumSteps: input.initialNumSteps,
    ...(name === 'Stop' ? { fullyIdle: input.fullyIdle, terminationReason: input.terminationReason } : {}),
    ...(reason ? { reason, originalExecutionMayContinue: input.fullyIdle !== true } : {}) };
  fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify(receipt) + '\n');
  writeJsonAtomic(path.join(taskDir(task.id), 'agy-state.json'), { ...receipt, state });

  const resumeArgs = !TERMINAL_TASK_STATUSES.has(task.status)
    ? buildResumeArgv(task.stateDir, task.id, sessionId) : null;
  const args = reportArgs(task, sessionId, state, resumeArgs);
  if (process.env.AGENT_BRIDGE_HOOK_DRY_RUN === '1') return { ...response,
    dryRun: { args, state, sessionId, taskId: task.id, round: task.round, terminalId: task.terminalId,
      identityBound, resumeIncluded: Boolean(resumeArgs) } };
  const child = spawn(HERDR_BIN_PATH, args, { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
  return response;
}

// Hook stdout is reserved for native decisions and system-rule injection. / Hook标准输出仅用于原生决策和系统规则注入。
main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => {
  process.stdout.write('{}\n'); process.exitCode = 1;
});
