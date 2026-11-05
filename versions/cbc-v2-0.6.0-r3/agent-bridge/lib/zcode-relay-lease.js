'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { acquire: acquireNativeLock } = require('./process-lock');

const DEFAULT_ROOT = path.resolve(__dirname, '../../.local/zcode-relay-leases');

// One kernel-owned lock serializes every bridge Relay client for a Desktop binding. / 一个由内核持有的锁串行化同一Desktop绑定的所有桥接Relay客户端。
async function acquire(binding, { root = process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR || DEFAULT_ROOT,
  acquireLock = acquireNativeLock, alive = legacyProcessAlive } = {}) {
  if (!binding?.sid || !binding?.mid) throw new Error('ZCode Relay lease requires a complete Desktop binding');
  const key = crypto.createHash('sha256').update(`${binding.sid}\n${binding.mid}`).digest('hex');
  const leaseRoot = path.resolve(root);
  fs.mkdirSync(leaseRoot, { recursive: true });
  let releaseNative;
  try { releaseNative = await acquireLock(path.join(leaseRoot, key), 0); }
  catch (error) {
    if (!/Timed out acquiring native coordination lock/.test(error.message)) throw error;
    const busy = new Error('ZCode Relay is already owned by a local bridge; no connection attempted');
    busy.code = 'ZCODE_RELAY_LOCAL_BUSY'; throw busy;
  }
  try {
    const legacyOwner = readLegacyOwner(path.join(leaseRoot, `${key}.lock`));
    if (legacyOwner) {
      let isAlive;
      try { isAlive = alive(legacyOwner.pid); }
      catch (cause) { throw legacyReviewRequired('legacy owner liveness could not be established', cause); }
      if (typeof isAlive !== 'boolean') throw legacyReviewRequired('legacy owner liveness result is unknown');
      if (isAlive) {
        const busy = new Error(`ZCode Relay is already owned by a legacy local bridge (PID ${legacyOwner.pid}); no connection attempted`);
        busy.code = 'ZCODE_RELAY_LOCAL_BUSY'; throw busy;
      }
      // Preserve dead legacy owner evidence; stale .reap markers are deliberately ignored. / 保留已退出旧租约证据；有意忽略陈旧.reap标记。
    }
  } catch (error) {
    try { await releaseNative(); } catch (releaseError) { error.cause ||= releaseError; }
    throw error;
  }
  let released = false;
  return { async release() {
    if (released) return;
    released = true;
    await releaseNative();
  } };
}

function readLegacyOwner(directory) {
  let directoryInfo;
  try { directoryInfo = fs.lstatSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw legacyReviewRequired('legacy lease directory could not be inspected', error);
  }
  if (!directoryInfo.isDirectory()) throw legacyReviewRequired('legacy lease path is not a directory');

  let serialized;
  try { serialized = fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'); }
  catch (error) { throw legacyReviewRequired('legacy owner file is missing or unreadable', error); }
  let owner;
  try { owner = JSON.parse(serialized); }
  catch (error) { throw legacyReviewRequired('legacy owner file is empty or malformed', error); }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw legacyReviewRequired('legacy owner record has an invalid shape');
  }
  const ownerPid = owner.ownerPid;
  const priorPid = owner.pid;
  if (ownerPid !== undefined && priorPid !== undefined && ownerPid !== priorPid) {
    throw legacyReviewRequired('legacy owner PID fields conflict');
  }
  const pid = ownerPid ?? priorPid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw legacyReviewRequired('legacy owner PID is missing or invalid');
  return { pid };
}

function legacyReviewRequired(reason, cause) {
  const error = new Error(`Legacy ZCode Relay lease requires manual review (${reason}); no connection attempted`);
  error.code = 'LEGACY_REVIEW_REQUIRED';
  if (cause) error.cause = cause;
  return error;
}

function legacyProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return undefined;
  }
}

module.exports = { acquire, DEFAULT_ROOT };
