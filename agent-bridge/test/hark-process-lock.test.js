'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { withLock } = require('../lib/util');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-process-lock-'));
let fixtureNumber = 0;
const lockName = 'hark-process-lock';

test.after(() => {
  const resolvedRoot = path.resolve(root);
  assert.ok(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
});

function stateDir() {
  const dir = path.join(root, `case-${++fixtureNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runWithState(directory, operation) {
  const previous = process.env.AGENT_BRIDGE_STATE_DIR;
  process.env.AGENT_BRIDGE_STATE_DIR = directory;
  try { return await operation(); }
  finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
    else process.env.AGENT_BRIDGE_STATE_DIR = previous;
  }
}

function spawnNode(source, env = {}) {
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for child marker: ${file}`);
}

test('withLock serializes independent Node processes sharing the same isolated state root', async () => {
  const directory = stateDir();
  const enteredA = path.join(directory, 'a-entered');
  const releasedA = path.join(directory, 'a-released');
  const enteredB = path.join(directory, 'b-entered');
  const modulePath = path.resolve(__dirname, '..', 'lib', 'util.js');
  const childA = spawnNode(`
    const fs = require('node:fs');
    const { withLock, sleep } = require(${JSON.stringify(modulePath)});
    withLock('${lockName}', async () => {
      fs.writeFileSync(process.env.LOCK_A_ENTERED, 'yes');
      await sleep(700);
      fs.writeFileSync(process.env.LOCK_A_RELEASED, 'yes');
    }, 5000).then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
  `, { AGENT_BRIDGE_STATE_DIR: directory, LOCK_A_ENTERED: enteredA, LOCK_A_RELEASED: releasedA });
  let childB;
  try {
    await waitForFile(enteredA);
    childB = spawnNode(`
      const fs = require('node:fs');
      const { withLock, sleep } = require(${JSON.stringify(modulePath)});
      withLock('${lockName}', async () => {
        fs.writeFileSync(process.env.LOCK_B_ENTERED, fs.existsSync(process.env.LOCK_A_RELEASED) ? 'after-release' : 'overlap');
        await sleep(20);
      }, 5000).then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
    `, { AGENT_BRIDGE_STATE_DIR: directory, LOCK_A_RELEASED: releasedA, LOCK_B_ENTERED: enteredB });
    const [resultA, resultB] = await Promise.all([childA.closed, childB.closed]);
    assert.equal(resultA.code, 0, childA.stderr);
    assert.equal(resultB.code, 0, childB.stderr);
    assert.equal(fs.readFileSync(enteredB, 'utf8'), 'after-release');
  } finally {
    for (const processHandle of [childA, childB]) {
      if (processHandle && processHandle.child.exitCode === null && processHandle.child.signalCode === null) {
        processHandle.child.kill();
        await processHandle.closed;
      }
    }
  }
});

test('a killed lock holder releases the kernel lock and a later process reclaims its protocol-2 owner record', async () => {
  const directory = stateDir();
  const entered = path.join(directory, 'holder-entered');
  const modulePath = path.resolve(__dirname, '..', 'lib', 'util.js');
  const holder = spawnNode(`
    const fs = require('node:fs');
    const { withLock } = require(${JSON.stringify(modulePath)});
    withLock('${lockName}', async () => {
      fs.writeFileSync(process.env.LOCK_HOLDER_ENTERED, 'yes');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }, 5000).catch(error => { console.error(error.stack); process.exit(1); });
  `, { AGENT_BRIDGE_STATE_DIR: directory, LOCK_HOLDER_ENTERED: entered });
  try {
    await waitForFile(entered);
    holder.child.kill();
    const result = await holder.closed;
    assert.notEqual(result.code, 0);

    const acquired = await runWithState(directory, () => withLock(lockName, () => {
      const ownerPath = path.join(directory, 'locks', `${lockName}.lock`, 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      assert.equal(owner.protocol, 2);
      assert.equal(owner.pid, process.pid);
      return owner;
    }, 5000));
    assert.ok(acquired.token);
    assert.equal(fs.existsSync(path.join(directory, 'locks', `${lockName}.lock`)), false);
  } finally {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill();
      await holder.closed;
    }
  }
});

test('a protocol-2 stale owner is reclaimed even when its recorded PID equals the current PID', async () => {
  const directory = stateDir();
  const lockDir = path.join(directory, 'locks', `${lockName}.lock`);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    protocol: 2, pid: process.pid, token: 'stale-token-for-reused-pid', createdAt: new Date().toISOString(),
  }));

  const owner = await runWithState(directory, () => withLock(lockName, () => {
    const current = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(current.protocol, 2);
    assert.equal(current.pid, process.pid);
    assert.notEqual(current.token, 'stale-token-for-reused-pid');
    return current;
  }, 5000));

  assert.ok(owner.token);
  assert.equal(fs.existsSync(lockDir), false);
});

test('withLock releases ownership when the callback throws', async () => {
  const directory = stateDir();
  const failure = new Error('isolated callback failure');
  await runWithState(directory, async () => {
    await assert.rejects(withLock(lockName, () => { throw failure; }, 5000), error => error === failure);
    const result = await withLock(lockName, () => 'reacquired', 5000);
    assert.equal(result, 'reacquired');
  });
  assert.equal(fs.existsSync(path.join(directory, 'locks', `${lockName}.lock`)), false);
});

test('a mismatched owner token cannot remove a replacement owner', async () => {
  const directory = stateDir();
  const lockDir = path.join(directory, 'locks', `${lockName}.lock`);
  const ownerPath = path.join(lockDir, 'owner.json');
  await runWithState(directory, async () => {
    await withLock(lockName, () => {
      const current = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, JSON.stringify({ ...current, token: 'replacement-owner-token' }));
    }, 5000);

    assert.equal(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token, 'replacement-owner-token');
    await withLock(lockName, () => {
      const current = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      assert.notEqual(current.token, 'replacement-owner-token');
    }, 5000);
  });
  assert.equal(fs.existsSync(lockDir), false);
});

test('config accepts explicit state and binary paths without LOCALAPPDATA, APPDATA or USERPROFILE', async () => {
  const directory = stateDir();
  const modulePath = path.resolve(__dirname, '..', 'lib', 'util.js');
  const child = spawnNode(`
    const { config } = require(${JSON.stringify(modulePath)});
    process.stdout.write(JSON.stringify(config()));
  `, {
    AGENT_BRIDGE_STATE_DIR: directory,
    HERDR_BIN_PATH: path.join(directory, 'herdr'),
    AGENT_BRIDGE_CBC: path.join(directory, 'cbc'),
    AGENT_BRIDGE_AGY: path.join(directory, 'agy'),
    AGENT_BRIDGE_OPENCODE: path.join(directory, 'opencode'),
    AGENT_BRIDGE_CODEX_JS: path.join(directory, 'codex.js'),
    LOCALAPPDATA: undefined,
    APPDATA: undefined,
    USERPROFILE: undefined,
  });
  const result = await child.closed;
  assert.equal(result.code, 0, child.stderr);
  const config = JSON.parse(child.stdout);
  assert.equal(config.stateDir, directory);
  assert.equal(config.herdr, path.join(directory, 'herdr'));
  assert.equal(config.cbc, path.join(directory, 'cbc'));
  assert.equal(config.agy, path.join(directory, 'agy'));
  assert.equal(config.opencode, path.join(directory, 'opencode'));
  assert.equal(config.codexJs, path.join(directory, 'codex.js'));
});
