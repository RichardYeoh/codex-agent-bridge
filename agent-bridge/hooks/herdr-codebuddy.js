#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { leaseForEvent } = require('../lib/worker-lease');

const states = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  Stop: 'idle',
  Notification: 'blocked',
};

async function main() {
  const { HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID || !HERDR_BIN_PATH) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }

  const name = event.hook_event_name || event.event;
  try {
    const logDir = process.env.AGENT_BRIDGE_STATE_DIR || path.join(process.env.LOCALAPPDATA, 'agent-bridge');
    const lease = leaseForEvent(logDir, process.env.AGENT_BRIDGE_HERDR_SESSION, HERDR_PANE_ID, event.session_id);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'hook-events.ndjson'), `${JSON.stringify({
      timestamp: new Date().toISOString(), name, source: event.source, paneId: HERDR_PANE_ID,
      sessionId: event.session_id, notificationType: event.notification_type,
      taskId: lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID,
      herdrSession: process.env.AGENT_BRIDGE_HERDR_SESSION,
    })}\n`);
  } catch {}
  const release = name === 'SessionEnd';
  if (!release && !Object.hasOwn(states, name)) return;
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;

  const state = name === 'SessionStart' && event.source === 'compact'
    ? 'working'
    : states[name];
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;
  const args = [
    'pane', release ? 'release-agent' : 'report-agent', HERDR_PANE_ID,
    '--source', 'custom:agent-bridge',
    '--agent', 'codebuddy',
    '--seq', String(Date.now()),
  ];
  if (!release) args.push('--state', state);
  if (!release && typeof event.session_id === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(event.session_id)) {
    args.push('--agent-session-id', event.session_id);
  }
  if (name === 'Notification') args.push('--message', 'CodeBuddy permission required');
  if (!release && typeof event.session_id === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(event.session_id)) {
    args.push('--', 'codebuddy', '--resume', event.session_id);
  }

  if (process.env.AGENT_BRIDGE_HOOK_DRY_RUN === '1') {
    process.stdout.write(`${JSON.stringify({ binary: HERDR_BIN_PATH, args })}\n`);
    return;
  }
  const child = spawn(HERDR_BIN_PATH, args, {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  // Preserve hook order before CBC continues. / 等待状态上报完成后再继续，避免事件乱序。
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

main().catch(() => {});
