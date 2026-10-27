'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { config, ensureDir, sleep } = require('./util');

function sessionArgs(session) {
  return session && session !== 'default' ? ['--session', session] : [];
}

function run(args, options = {}) {
  const cfg = config();
  const command = cfg.herdr.endsWith('.js') || cfg.herdr.endsWith('.cjs') ? process.execPath : cfg.herdr;
  const cliArgs = command === process.execPath ? [cfg.herdr, ...args] : args;
  const result = spawnSync(command, cliArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 30000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.error || result.status !== 0) {
    const error = new Error(stderr || stdout || result.error?.message || `Herdr exited ${result.status}`);
    error.code = result.error?.code || 'HERDR_COMMAND_FAILED';
    error.args = args;
    error.status = result.status;
    error.stdout = stdout;
    error.stderr = stderr;
    try { error.herdrCode = JSON.parse(stderr || stdout).error?.code; } catch {}
    throw error;
  }
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

function api(session, args, options) {
  return run([...sessionArgs(session), ...args], options);
}

function resultPayload(response) {
  return response && response.result ? response.result : response;
}

// A zero exit code does not prove the server is running. / 退出码0不代表服务运行，须检查状态字段。
function serverRunning(session) {
  try {
    const response = api(session, ['status', 'server'], { timeout: 5000 });
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    return /status:\s*running/i.test(text) || /"status"\s*:\s*"running"/i.test(text);
  } catch {
    return false;
  }
}

async function ensureServer(session) {
  if (serverRunning(session)) return;

  const cfg = config();
  const logDir = ensureDir(path.join(cfg.stateDir, 'logs'));
  const fd = fs.openSync(path.join(logDir, `herdr-${session}.log`), 'a');
  const child = spawn(cfg.herdr, [...sessionArgs(session), 'server'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  // Bound server startup; new sessions may need manual initialization. / 服务启动有界等待，新会话可能需要人工初始化。
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    if (serverRunning(session)) return;
  }
  throw new Error(`Herdr server for session "${session}" did not start; `
    + `if this is a new named session, run \`herdr session attach ${session}\` once to initialize it`);
}

function agentInfo(session, paneId) {
  const response = api(session, ['agent', 'get', paneId]);
  return resultPayload(response).agent;
}

function paneInfo(session, paneId) {
  const response = api(session, ['pane', 'get', paneId]);
  return resultPayload(response).pane;
}

function startWatcher(taskId) {
  const cfg = config();
  const logDir = ensureDir(path.join(cfg.stateDir, 'logs'));
  const fd = fs.openSync(path.join(logDir, `${taskId}-watcher.log`), 'a');
  const child = spawn(process.execPath, [path.join(cfg.root, 'bin', 'agent-bridge-watcher.js'), taskId], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

module.exports = { agentInfo, api, ensureServer, paneInfo, resultPayload, run, sessionArgs, startWatcher };
