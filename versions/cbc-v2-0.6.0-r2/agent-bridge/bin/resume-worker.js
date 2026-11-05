#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getAgent } = require('../lib/agents');
const { leasePath } = require('../lib/worker-lease');
const { readJson } = require('../lib/util');
const { readPaneIdentity, readNativeInventory } = require('../hooks/herdr-binding');

const TERMINAL_TASK_STATUSES = new Set(['accepted', 'cancelled', 'abandoned']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readTask(stateDir, taskId) {
  if (!path.isAbsolute(stateDir) || stateDir.includes("'") || CONTROL.test(stateDir)) {
    throw new Error('Resume worker requires a safe absolute state directory');
  }
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(taskId)) throw new Error('Resume worker task ID is invalid');
  const file = path.join(stateDir, 'tasks', taskId, 'task.json');
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (task.id !== taskId || !samePath(task.stateDir, stateDir)) {
    throw new Error('Resume worker task state directory binding mismatch');
  }
  return task;
}

function buildCommand(stateDir, taskId, nativeId) {
  if (typeof nativeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(nativeId)) {
    throw new Error('Resume worker native session ID is invalid');
  }
  const task = readTask(stateDir, taskId);
  if (task.workerSessionId !== nativeId) throw new Error('Resume worker native session ID does not match saved task');
  if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error(`Resume worker refuses terminal task status: ${task.status}`);
  if (typeof task.status !== 'string' || !task.cwd || typeof task.herdrSession !== 'string'
      || !fs.statSync(task.cwd).isDirectory()) {
    throw new Error('Resume worker task status or working directory is invalid');
  }
  const descriptor = getAgent(task.agent);
  if (typeof descriptor.buildCommand !== 'function') throw new Error('Resume worker agent has no native resume command');
  const command = descriptor.buildCommand(task, nativeId);
  if (typeof command !== 'string' || !command.trim()) throw new Error('Resume worker agent returned an empty command');
  return { task, command };
}

function verifyRestoreOwner(task, stateDir, nativeId, env, { readPane, readInventory }) {
  if (env.HERDR_ENV !== '1' || typeof env.HERDR_PANE_ID !== 'string' || !env.HERDR_PANE_ID
      || typeof env.HERDR_BIN_PATH !== 'string' || !env.HERDR_BIN_PATH) {
    throw new Error('Resume worker cannot identify its current Herdr Pane; no agent process started');
  }
  if (env.AGENT_BRIDGE_HERDR_SESSION && env.AGENT_BRIDGE_HERDR_SESSION !== task.herdrSession) {
    throw new Error('Resume worker Herdr session does not match the saved task');
  }
  if (env.HERDR_PANE_ID !== task.paneId) {
    throw new Error(`Resume worker Pane changed; verify and run adopt-restored ${task.id} before restoring this session`);
  }

  const lease = readJson(leasePath(stateDir, task.herdrSession, env.HERDR_PANE_ID), null);
  if (!lease || lease.taskId !== task.id || lease.herdrSession !== task.herdrSession
      || lease.paneId !== env.HERDR_PANE_ID || lease.workerSessionId !== nativeId
      || lease.terminalId !== task.terminalId
      || (task.workerStartedAt && lease.workerStartedAt !== task.workerStartedAt)) {
    throw new Error(`Resume worker Pane lease is unclaimed or stale; verify and run adopt-restored ${task.id}`);
  }

  const pane = readPane(env.HERDR_BIN_PATH, task.herdrSession, env.HERDR_PANE_ID);
  const records = readInventory(env.HERDR_BIN_PATH, task.herdrSession);
  if (!pane || pane.paneId !== env.HERDR_PANE_ID || !Array.isArray(records)) {
    throw new Error('Resume worker cannot confirm the current Pane through Herdr; no agent process started');
  }
  const current = records.find(item => item?.pane_id === env.HERDR_PANE_ID);
  if (!current || current.terminal_id !== pane.terminalId) {
    throw new Error('Resume worker current Pane inventory is incomplete or inconsistent; no agent process started');
  }
  const currentNativeId = current.agent_session?.value;
  if ((current.agent || current.agent_name || current.agent_status) && !currentNativeId) {
    throw new Error('Resume worker current Pane has agent state without an independently reported native session; no agent process started');
  }
  if (currentNativeId && currentNativeId !== nativeId) {
    throw new Error('Resume worker current Pane is registered to another native session; no agent process started');
  }
  const elsewhere = records.filter(item => item?.pane_id !== env.HERDR_PANE_ID
    && (item.agent_session?.value === nativeId || item.terminal_id === task.terminalId));
  if (elsewhere.length) {
    throw new Error(`Resume worker found the native session or old terminal on another Pane (${elsewhere.map(item => item.pane_id).join(', ')}); no agent process started`);
  }
  return { paneId: current.pane_id, terminalId: current.terminal_id };
}

function runShell(command, cwd, stateDir, taskId, herdrSession, env = process.env, spawnFn = spawn) {
  const shell = env.AGENT_BRIDGE_POWERSHELL || 'pwsh';
  const child = spawnFn(shell, ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd, stdio: 'inherit', windowsHide: false,
    env: { ...env, AGENT_BRIDGE_STATE_DIR: stateDir,
      AGENT_BRIDGE_TASK_ID: taskId, AGENT_BRIDGE_HERDR_SESSION: herdrSession },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', error => {
      if (settled) return;
      settled = true; reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true; resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

async function main(argv = process.argv.slice(2), {
  spawnFn = spawn,
  env = process.env,
  readPane = readPaneIdentity,
  readInventory = readNativeInventory,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 3) {
    throw new Error('Usage: resume-worker.js <stateDir> <taskId> <nativeSessionId>');
  }
  const [stateDir, taskId, nativeId] = argv;
  const { task, command } = buildCommand(stateDir, taskId, nativeId);
  verifyRestoreOwner(task, path.resolve(stateDir), nativeId, env, { readPane, readInventory });
  return runShell(command, task.cwd, path.resolve(stateDir), task.id, task.herdrSession, env, spawnFn);
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`Agent bridge resume refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildCommand, main, runShell, verifyRestoreOwner, TERMINAL_TASK_STATUSES };
