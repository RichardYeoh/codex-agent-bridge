'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { acquire } = require('../lib/zcode-relay-lease');
const { ZCodeRemote } = require('../lib/zcode-remote');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relay-lease-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function bindingKey(binding) {
  return crypto.createHash('sha256').update(`${binding.sid}\n${binding.mid}`).digest('hex');
}

function writeLegacyOwner(binding, content, { ownerFile = true } = {}) {
  const directory = path.join(root, `${bindingKey(binding)}.lock`);
  fs.mkdirSync(directory, { recursive: true });
  if (ownerFile) fs.writeFileSync(path.join(directory, 'owner.json'), content);
  return directory;
}

test('one binding owns one kernel lease, different bindings are independent, release is idempotent', async () => {
  const binding = { sid: 'test-device', mid: 'test-machine' };
  const first = await acquire(binding, { root });
  await assert.rejects(acquire(binding, { root }), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
  const other = await acquire({ ...binding, mid: 'another' }, { root });
  await other.release(); await other.release();
  await first.release(); await first.release();
  const next = await acquire(binding, { root }); await next.release();
});

test('active legacy PID and ownerPid records block without changing their evidence', async () => {
  for (const [index, field] of ['pid', 'ownerPid'].entries()) {
    const binding = { sid: `legacy-active-${index}`, mid: 'desktop' };
    const directory = writeLegacyOwner(binding, JSON.stringify({ [field]: process.pid, token: `legacy-${field}` }));
    const ownerFile = path.join(directory, 'owner.json');
    const before = fs.readFileSync(ownerFile, 'utf8');
    await assert.rejects(acquire(binding, { root }), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), before);
    assert.equal(fs.existsSync(directory), true);
  }
});

test('dead legacy owner and stale .reap evidence do not block or get removed by the native lease', async () => {
  const binding = { sid: 'legacy-dead', mid: 'desktop' };
  const directory = writeLegacyOwner(binding, JSON.stringify({ ownerPid: 2147483647, token: 'dead-owner' }));
  const ownerFile = path.join(directory, 'owner.json');
  const reapFile = path.join(root, `${bindingKey(binding)}.reap`);
  fs.writeFileSync(reapFile, 'stale-reaper-marker');
  const ownerBefore = fs.readFileSync(ownerFile, 'utf8');
  const reapBefore = fs.readFileSync(reapFile, 'utf8');

  const lease = await acquire(binding, { root, alive: () => false });
  await assert.rejects(acquire(binding, { root, alive: () => false }), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
  await lease.release();
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), ownerBefore);
  assert.equal(fs.readFileSync(reapFile, 'utf8'), reapBefore);
  assert.equal(fs.existsSync(directory), true);

  const next = await acquire(binding, { root, alive: () => false });
  await next.release();
});

test('malformed, empty, missing and conflicting legacy owner records require manual review', async () => {
  const cases = [
    ['malformed', '{'],
    ['empty', ''],
    ['invalid-pid', JSON.stringify({ ownerPid: 'unknown' })],
    ['conflicting-pids', JSON.stringify({ pid: 11, ownerPid: 12 })],
  ];
  for (const [name, content] of cases) {
    const binding = { sid: `legacy-unknown-${name}`, mid: 'desktop' };
    writeLegacyOwner(binding, content);
    await assert.rejects(acquire(binding, { root }), error => {
      assert.equal(error.code, 'LEGACY_REVIEW_REQUIRED');
      assert.match(error.message, /no connection attempted/);
      return true;
    });
    const fixed = path.join(root, `${bindingKey(binding)}.lock`, 'owner.json');
    fs.writeFileSync(fixed, JSON.stringify({ ownerPid: 2147483647 }));
    const recovered = await acquire(binding, { root, alive: () => false });
    await recovered.release();
  }

  const missing = { sid: 'legacy-owner-missing', mid: 'desktop' };
  const directory = writeLegacyOwner(missing, '', { ownerFile: false });
  await assert.rejects(acquire(missing, { root }), { code: 'LEGACY_REVIEW_REQUIRED' });
  assert.equal(fs.existsSync(directory), true);

  const unknownLiveness = { sid: 'legacy-liveness-unknown', mid: 'desktop' };
  writeLegacyOwner(unknownLiveness, JSON.stringify({ ownerPid: process.pid }));
  await assert.rejects(acquire(unknownLiveness, { root, alive: () => undefined }), {
    code: 'LEGACY_REVIEW_REQUIRED',
  });
  const afterReview = await acquire(unknownLiveness, { root, alive: () => false });
  await afterReview.release();
});

test('kernel lease is released when its owning process exits; no stale PID/reaper cleanup is needed', async () => {
  const binding = { sid: 'crash-device', mid: 'crash-machine' };
  const ready = path.join(root, 'holder-ready');
  const script = path.join(root, 'lease-holder.cjs');
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    `const { acquire } = require(${JSON.stringify(path.resolve(__dirname, '../lib/zcode-relay-lease'))});`,
    '(async () => { await acquire({ sid: process.env.TEST_SID, mid: process.env.TEST_MID });',
    'fs.writeFileSync(process.env.TEST_READY, "ready"); setInterval(() => {}, 1000); })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });',
  ].join('\n'));
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, TEST_SID: binding.sid, TEST_MID: binding.mid, TEST_READY: ready,
    AGENT_BRIDGE_ZCODE_LEASE_DIR: root,
  } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(ready), true, stderr);
    await assert.rejects(acquire(binding, { root }), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    const afterExit = await acquire(binding, { root }); await afterExit.release();
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('all Remote callers reject local contention before authentication or network', async () => {
  const prior = process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR;
  process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR = root;
  const binding = { sid: 'active', mid: 'desktop' }, lease = await acquire(binding, { root });
  let credentials = 0;
  try {
    const remote = new ZCodeRemote(binding, { credential: () => { credentials++; return 'unused'; } });
    await assert.rejects(remote.connect(), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
    assert.equal(credentials, 0);
    await lease.release();
    const rejected = new ZCodeRemote(binding, { credential: () => undefined });
    await assert.rejects(rejected.connect(), /login unavailable/);
    const reusable = await acquire(binding, { root }); await reusable.release();
  } finally {
    await lease.release();
    if (prior === undefined) delete process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR;
    else process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR = prior;
  }
});
