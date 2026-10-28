'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function now() {
  return new Date().toISOString();
}

function homePath(...parts) {
  return path.join(process.env.USERPROFILE || require('node:os').homedir(), ...parts);
}

function config() {
  return {
    root: ROOT,
    herdr: process.env.HERDR_BIN_PATH || path.join(process.env.LOCALAPPDATA, 'Programs', 'Herdr', 'bin', 'herdr.exe'),
    cbc: process.env.AGENT_BRIDGE_CBC || path.join(process.env.APPDATA, 'npm', 'cbc.cmd'),
    agy: process.env.AGENT_BRIDGE_AGY || path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    opencode: process.env.AGENT_BRIDGE_OPENCODE || path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    codexJs: process.env.AGENT_BRIDGE_CODEX_JS || path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    stateDir: process.env.AGENT_BRIDGE_STATE_DIR || path.join(process.env.LOCALAPPDATA, 'agent-bridge'),
    defaultSession: process.env.HERDR_SESSION || 'default',
    defaultPermissionMode: process.env.AGENT_BRIDGE_PERMISSION_MODE || 'acceptEdits',
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

// Retry transient Windows sharing errors only. / 仅重试 Windows 瞬时文件占用错误。
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(fn, attempts = 8) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      last = error;
      if (!RETRYABLE.has(error.code)) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw last;
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  withRetry(() => fs.writeFileSync(temp, data, { mode: 0o600 }));

  try {
    // Replace without removing the readable destination first. / 直接替换，保持旧文件始终可读。
    withRetry(() => fs.renameSync(temp, file));
  } finally {
    // A failed replacement preserves the old file. / 替换失败保留旧文件，清理失败不回滚。
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
  }
}

async function withLock(name, operation, timeoutMs = 180000) {
  const lockRoot = ensureDir(path.join(config().stateDir, 'locks'));
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(name)) throw new Error(`Invalid lock name: ${name}`);
  const lock = path.join(lockRoot, `${name}.lock`);
  const owner = path.join(lock, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, createdAt: now() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = readJson(owner, null);
      // Recover abandoned locks; allow time to publish ownership. / 回收失效锁，保留所有者写入窗口。
      if ((prior && !processAlive(prior.pid))
          || (!prior && Date.now() - fs.statSync(lock).mtimeMs > 10000)) {
        try { fs.rmSync(lock, { recursive: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock: ${name}`);
      await sleep(50);
    }
  }
  try { return await operation(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  const line = `${JSON.stringify(value)}\n`;
  withRetry(() => fs.appendFileSync(file, line, { mode: 0o600 }));
}

function taskDir(taskId) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  return path.join(config().stateDir, 'tasks', taskId);
}

function taskFile(taskId) {
  return path.join(taskDir(taskId), 'task.json');
}

function loadTask(taskId) {
  return readJson(taskFile(taskId));
}

function saveTask(task) {
  task.updatedAt = now();
  writeJsonAtomic(taskFile(task.id), task);
  return task;
}

function event(task, type, data = {}) {
  appendJsonl(path.join(config().stateDir, 'events.ndjson'), {
    timestamp: now(), taskId: task.id, round: task.round, type, ...data,
  });
}

function makeTaskId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase();
  return `task-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ROOT, appendJsonl, config, ensureDir, event, homePath, loadTask, makeTaskId,
  now, processAlive, psQuote, readJson, saveTask, sleep, taskDir, taskFile, writeJsonAtomic, withLock,
};
