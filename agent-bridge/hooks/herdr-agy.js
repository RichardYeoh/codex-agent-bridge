#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { config, loadTask, readJson, writeJsonAtomic, now } = require('../lib/util');
const { leaseForEvent } = require('../lib/worker-lease');
const { classifyBlocker } = require('../lib/blocker');

async function main() {
  const { HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH, AGENT_BRIDGE_HERDR_SESSION } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID || !HERDR_BIN_PATH || !AGENT_BRIDGE_HERDR_SESSION) return {};
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text), name = process.argv[2], sessionId = input.conversationId;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return {};
  const lease = leaseForEvent(config().stateDir, AGENT_BRIDGE_HERDR_SESSION, HERDR_PANE_ID, sessionId);
  const task = loadTask(lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID);
  if (task.agent !== 'agy' || (task.workerSessionId && task.workerSessionId !== sessionId)) throw new Error('Agy Hook session mismatch');
  const response = {};
  // "allow" delegates to the native permission policy; it is not auto_approve. / allow继续执行原生权限策略，并非auto_approve授权。
  if (name === 'PreToolUse') response.decision = 'allow';
  let state = name === 'SessionStart' ? 'idle' : 'working', reason;
  if (name === 'PreInvocation' && task.workerPolicyPath) {
    const policy = fs.readFileSync(task.workerPolicyPath, 'utf8');
    const digest = crypto.createHash('sha256').update(sessionId + '\n' + policy).digest('hex');
    const marker = path.join(task.stateDir, 'agy-policy-receipts', digest + '.json');
    if (!readJson(marker, null)) {
      response.injectSteps = [{ systemMessage: { systemMessage: policy, metadata: { source: 'codex-agent-bridge' } } }];
      writeJsonAtomic(marker, { sessionId, timestamp: now(), policySha256: task.workerPolicySha256 });
    }
  }
  if (name === 'PreToolUse' && (input.toolCall?.name !== 'notify_user' || input.toolCall?.args?.BlockedOnUser === true)) {
    state = 'blocked'; reason = 'user_input_required';
  }
  if (name === 'Stop') {
    if (input.error) { state = 'blocked'; reason = classifyBlocker(input.error)?.type || 'execution_error'; }
    else if (input.fullyIdle === true) state = 'idle';
    else { state = 'blocked'; reason = 'background_work_unconfirmed'; }
  }
  const receipt = { timestamp: now(), name, source: 'agy-native-hook', sessionId, taskId: task.id,
    herdrSession: task.herdrSession, paneId: task.paneId, round: task.round,
    ...(name === 'Stop' ? { fullyIdle: input.fullyIdle, terminationReason: input.terminationReason } : {}),
    ...(reason ? { reason, originalExecutionMayContinue: input.fullyIdle !== true } : {}) };
  fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify(receipt) + '\n');
  writeJsonAtomic(path.join(path.dirname(task.workerPolicyPath), 'agy-state.json'), { ...receipt, state });
  const args = ['pane', 'report-agent', task.paneId, '--source', 'custom:agent-bridge-agy', '--agent', 'agy',
    '--state', state, '--seq', String(Date.now()), '--agent-session-id', sessionId,
    '--', config().agy, '--conversation', sessionId];
  if (process.env.AGENT_BRIDGE_HOOK_DRY_RUN === '1') return { ...response, dryRun: { args, state, sessionId } };
  const child = spawn(HERDR_BIN_PATH, args, { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
  return response;
}

// Hook stdout is reserved for native decisions and system-rule injection. / Hook标准输出仅用于原生决策与系统规则注入。
main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => {
  process.stdout.write('{}\n'); process.exitCode = 1;
});
