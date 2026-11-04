#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { config, loadTask } = require('../lib/util');
const { leaseForEvent } = require('../lib/worker-lease');
const { snapshot, idleBelongsToRound, publish } = require('../lib/opencode');

const sessionId = process.argv[2];
let child, timer, stopping = false;
let settledLease = '';
let consecutiveApiFailures = 0;
let outageReported = false;
const API_FAILURE_THRESHOLD = 3;

function isApiFailure(error) {
  return error?.code === 'OPENCODE_API_UNAVAILABLE' || error?.code === 'OPENCODE_API_MALFORMED';
}

function schedule(delay) {
  if (!stopping) timer = setTimeout(observe, delay);
}

function currentTask() {
  const lease = leaseForEvent(config().stateDir, process.env.AGENT_BRIDGE_HERDR_SESSION, process.env.HERDR_PANE_ID, sessionId);
  const task = loadTask(lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID);
  if (task.agent !== 'opencode' || task.workerSessionId !== sessionId) throw new Error('OpenCode pane lease mismatch');
  return task;
}

function report(task, state) {
  const live = currentTask();
  if (live.id !== task.id || live.round !== task.round) return;
  task = live;
  // A previous turn's idle snapshot cannot settle a newly admitted round. / 上轮空闲快照不能收口刚提交的新一轮任务。
  if (!idleBelongsToRound(task, state)) return;
  publish(task, state);
}

function observe() {
  if (stopping) return;
  let task, state;
  try {
    task = currentTask();
    const lease = `${task.id}:${task.round}:${task.status}`;
    // Accepted/cancelled workers watch only the local lease until reused. / 已验收或取消的执行者仅检查本地租约，复用前不轮询API。
    if (!['accepted', 'cancelled'].includes(task.status) || settledLease !== lease) {
      state = snapshot(task);
      settledLease = ['accepted', 'cancelled'].includes(task.status) ? lease : '';
    }
    consecutiveApiFailures = 0; outageReported = false;
  } catch (error) {
    if (isApiFailure(error)) {
      consecutiveApiFailures++;
      if (consecutiveApiFailures >= API_FAILURE_THRESHOLD && !outageReported) {
        try { report(currentTask(), { state: 'blocked', reason: 'api_unavailable', originalExecutionMayContinue: true }); } catch {}
        outageReported = true;
      }
      // One failed read cannot settle a possibly active task; retry with bounded backoff. / 单次读取失败不得收口可能仍在运行的任务；使用有界退避重试。
      schedule(Math.min(3000 * (2 ** (consecutiveApiFailures - 1)), 15000));
      return;
    }
    stopping = true; clearTimeout(timer);
    process.stderr.write('OpenCode bridge observer lost its task or Pane lease; inspect saved state.\n');
    process.exitCode = 1; return;
  }
  if (state) {
    try { report(task, state); }
    catch {
      stopping = true; clearTimeout(timer);
      process.stderr.write('OpenCode bridge observer could not publish state; inspect saved state.\n');
      process.exitCode = 1; return;
    }
  }
  // Snapshot checks cost no model turns; only one observer runs per visible TUI. / 快照核对不消耗模型轮次，每个可见TUI只有一个观察器。
  schedule(state?.state === 'working' ? 1000 : 3000);
}

function main() {
  if (!sessionId || !/^ses[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Verified OpenCode session ID required');
  const task = currentTask();
  let initial;
  try { initial = snapshot(task); }
  catch (error) {
    if (!isApiFailure(error)) throw error;
    consecutiveApiFailures = 1;
  }
  const args = ['--session', sessionId, task.cwd];
  // The child owns the terminal: preserve native rendering, dialogs, input and manual takeover. / 子进程占用终端，保留原生界面、审批、输入及人工接管。
  child = spawn(config().opencode, args, { cwd: task.cwd, stdio: 'inherit', windowsHide: true });
  child.once('error', () => { stopping = true; clearTimeout(timer); report(currentTask(), { state: 'blocked', reason: 'cli_start_failed' }); process.exitCode = 1; });
  child.once('exit', () => {
    stopping = true; clearTimeout(timer);
    try { report(currentTask(), { state: 'blocked', reason: 'cli_exited', originalExecutionMayContinue: true }); } catch {}
  });
  if (initial) report(task, initial);
  // Keep the native TUI available while the read-only API recovers. / 只读API恢复期间仍保持原生TUI可用。
  schedule(initial ? 1000 : Math.min(3000 * consecutiveApiFailures, 15000));
}

try { main(); } catch { process.stderr.write('OpenCode bridge could not attach; inspect saved session state.\n'); process.exitCode = 1; }
