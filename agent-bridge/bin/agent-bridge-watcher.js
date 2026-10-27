#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { agentInfo, api, resultPayload } = require('../lib/herdr');
const { event, loadTask, now, saveTask, taskDir, withLock } = require('../lib/util');
const { notifyTask } = require('../lib/notify');
const { assertWorker, updateWorkerSession } = require('../lib/worker');
const { classifyBlocker } = require('../lib/blocker');
const { getAgent } = require('../lib/agents');
const { recordContext } = require('../lib/worker-context');

function readTerminal(task) {
  const response = api(task.herdrSession, [
    'agent', 'read', task.paneId, '--source', 'recent-unwrapped', '--lines', '240',
  ], { timeout: 20000 });
  if (typeof response === 'string') return response;
  const payload = resultPayload(response);
  return payload?.read?.text || payload?.text || JSON.stringify(response);
}

function saveTerminal(task) {
  try {
    const text = readTerminal(task);
    const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-terminal.txt`);
    fs.writeFileSync(file, text);
    task.terminalPath = file;
  } catch (error) {
    event(task, 'terminal_read_failed', { message: error.message });
  }
}

async function main() {
  const taskId = process.argv[2];
  let task = loadTask(taskId);
  if (task.status !== 'running') return;
  const round = task.round;

  try {
    const timeoutMs = task.waitTimeoutMs ?? 1800000;
    const waitArgs = [
      'agent', 'wait', task.paneId,
      '--until', 'idle', '--until', 'done', '--until', 'blocked',
    ];
    if (timeoutMs > 0) waitArgs.push('--timeout', String(timeoutMs));
    const response = api(task.herdrSession, waitArgs, { timeout: timeoutMs > 0 ? timeoutMs + 5000 : 0 });
    await withLock(taskId, async () => {
    task = loadTask(taskId);
    if (task.round !== round || task.status !== 'running') return;
    const payload = resultPayload(response);
    const agent = assertWorker(task, payload?.agent || agentInfo(task.herdrSession, task.paneId));
    task.completionSeq = agent.completion_seq || null;
    const promptContext = getAgent(task.agent).readPromptContext?.(task);
    if (promptContext) task.promptContext = promptContext;
    updateWorkerSession(task);
    saveTerminal(task);

    if (agent.agent_status === 'blocked') {
      task.status = 'blocked';
      task.blocker = getAgent(task.agent).readBlocker?.(task)
        || classifyBlocker(task.terminalPath ? fs.readFileSync(task.terminalPath, 'utf8') : '');
      task.error = task.blocker?.message || `${task.agent} requires permission or user input; inspect the Herdr pane`;
    } else if (!task.deliveryPath || !fs.existsSync(task.deliveryPath)) {
      const blocker = classifyBlocker(task.terminalPath ? fs.readFileSync(task.terminalPath, 'utf8') : '');
      task.status = blocker ? 'blocked' : 'delivery_missing';
      task.blocker = blocker;
      task.error = blocker?.message || `${task.agent} became idle without writing the required delivery report`;
    } else {
      task.status = 'review_pending';
      task.error = null;
    }
    task.watcherPid = null;
    task.settlementSeq = (task.settlementSeq || 0) + 1;
    task.history.push({ round, status: task.status, timestamp: now(), completionSeq: task.completionSeq });
    saveTask(task);
    recordContext(task);
    event(task, 'settled', { status: task.status, completionSeq: task.completionSeq });
    await notifyTask(task);
    });
  } catch (error) {
    await withLock(taskId, async () => {
    task = loadTask(taskId);
    if (task.round !== round || task.status !== 'running') return;
    const timedOut = error.herdrCode === 'timeout' || error.code === 'ETIMEDOUT';
    task.status = timedOut ? 'blocked' : 'failed';
    if (timedOut) task.blocker = { type: 'wait_timeout', requiresAction: true, originalExecutionMayContinue: true };
    task.watcherPid = null;
    task.settlementSeq = (task.settlementSeq || 0) + 1;
    task.error = error.message;
    task.history.push({ round, status: task.status, timestamp: now(), message: error.message });
    saveTask(task);
    event(task, 'watcher_failed', { message: error.message });
    await notifyTask(task);
    });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
