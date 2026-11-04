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
    if (['EACCES', 'EPERM'].includes(error.code) || ['PermissionDenied', 'permission_denied', 'access_denied'].includes(error.herdrCode)
        || /PermissionDenied|拒绝访问|access (?:is )?denied|elevated server|administrator terminal/i.test(error.message)) {
      error.code = 'HERDR_IPC_ACCESS_DENIED';
    }
    throw error;
  }
  let response = null;
  if (stdout) {
    try { response = JSON.parse(stdout); }
    catch { response = stdout; }
  }
  // Preserve a successful empty CLI response separately from a missing transport reply. / 将CLI成功空响应与传输回执缺失分开保存。
  return options.includeTransportReceipt
    ? { transport: 'herdr-cli', exitCode: result.status, response }
    : response;
}

function api(session, args, options) {
  return run([...sessionArgs(session), ...args], options);
}

function resultPayload(response) {
  return response && response.result ? response.result : response;
}

// A zero exit code does not prove the server is running. / 退出码0不代表服务运行，须检查状态字段。
function serverRunning(session, { probe = api } = {}) {
  try {
    const response = probe(session, ['status', 'server'], { timeout: 5000 });
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    if (/status:\s*running/i.test(text) || /"status"\s*:\s*"running"/i.test(text)) return true;
    if (/status:\s*(?:stopped|not running)/i.test(text) || /"status"\s*:\s*"stopped"/i.test(text)) return false;
    throw new Error('Herdr server probe returned an unrecognized state; no service started');
  } catch (error) {
    if (['EACCES', 'EPERM', 'PermissionDenied', 'permission_denied', 'access_denied', 'HERDR_IPC_ACCESS_DENIED'].includes(error.code)
        || ['PermissionDenied', 'permission_denied', 'access_denied'].includes(error.herdrCode)
        || /PermissionDenied|拒绝访问|access (?:is )?denied|elevated server|administrator terminal/i.test(error.message)) {
      error.code = 'HERDR_IPC_ACCESS_DENIED';
      throw error;
    }
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code) || ['server_not_running', 'server_not_found'].includes(error.herdrCode)) return false;
    throw error;
  }
}

async function ensureServer(session, { probe = serverRunning, start = spawn, pause = sleep } = {}) {
  if (probe(session)) return;

  const cfg = config();
  const logDir = ensureDir(path.join(cfg.stateDir, 'logs'));
  const fd = fs.openSync(path.join(logDir, `herdr-${session}.log`), 'a');
  const scripted = /\.(?:c?js)$/i.test(cfg.herdr);
  const child = start(scripted ? process.execPath : cfg.herdr, [...(scripted ? [cfg.herdr] : []), ...sessionArgs(session), 'server'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  // Bound server startup; new sessions may need manual initialization. / 服务启动有界等待，新会话可能需要人工初始化。
  for (let i = 0; i < 60; i += 1) {
    await pause(250);
    if (probe(session)) return;
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

module.exports = { agentInfo, api, ensureServer, serverRunning, paneInfo, resultPayload, run, sessionArgs, startWatcher };
