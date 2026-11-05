#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path');
const { config, now, writeJsonAtomic } = require('../lib/util');
const { resolveBinding } = require('./herdr-codebuddy');
const { captureSubmission, nativeTranscriptPath } = require('../lib/cbc-turn');
async function main() {
  const env = process.env;
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || !env.HERDR_BIN_PATH || !env.AGENT_BRIDGE_HERDR_SESSION) return;
  const chunks = []; let size = 0; for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 2 * 1024 * 1024) return;
    chunks.push(chunk);
  }
  let raw; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  const name = raw.hook_event_name || raw.event;
  if (name === 'Notification' && raw.notification_type === 'idle_prompt') return;
  if (!['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification'].includes(name)) return;
  const binding = resolveBinding(raw, config().stateDir, env.HERDR_PANE_ID, env.AGENT_BRIDGE_HERDR_SESSION, env.HERDR_BIN_PATH);
  if (!binding || binding.task.taskProtocol !== 2) return;
  const task = binding.task, turn = name === 'UserPromptSubmit' ? captureSubmission(raw, task) : { promptSha256: null };
  const entry = { timestamp: now(), name, source: raw.source, sessionId: raw.session_id,
    taskId: task.id, round: task.round, herdrSession: task.herdrSession, paneId: task.paneId,
    terminalId: task.terminalId, identityBound: true, notificationType: raw.notification_type, ...turn,
    ...(nativeTranscriptPath(raw.transcript_path, { ...task, workerSessionId: raw.session_id })
      ? { nativeTranscript: nativeTranscriptPath(raw.transcript_path, { ...task, workerSessionId: raw.session_id }) } : {}) };
  await require('../lib/cbc-executor-evidence').append(task, entry);
  try { await require('../lib/cbc-protocol-v2').capture(task, raw, turn); }
  catch (error) {
    writeJsonAtomic(path.join(task.stateDir, 'tasks', task.id, 'layered-hook-error.json'), {
      timestamp: now(), requestId: task.layeredRequestId || null, name,
      code: error.code || 'HOOK_CAPTURE_FAILED', message: error.message,
    });
  }
  // Never report agent state or return a permission decision; the installed plugin owns Herdr UI. / 不上报Agent状态或返回审批决定，Herdr显示归已安装插件。
}
if (require.main === module) main().catch(() => { process.exitCode = 0; });
module.exports = { main };
