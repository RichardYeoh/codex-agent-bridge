'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire } = require('../lib/zcode-relay-lease');
const { ZCodeRemote } = require('../lib/zcode-remote');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relay-lease-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('one binding has one seat across callers, different bindings are independent, release is idempotent', () => {
  const binding = { sid: 'test-device', mid: 'test-machine' };
  const first = acquire(binding, { root });
  assert.throws(() => acquire(binding, { root }), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
  const other = acquire({ ...binding, mid: 'another' }, { root }); other.release();
  first.release(); first.release();
  acquire(binding, { root }).release();
});

test('dead owner recovery is local only; a live owner or unpublished ownership stays protected', () => {
  const binding = { sid: 'dead', mid: 'test' };
  acquire(binding, { root });
  const entry = fs.readdirSync(root).find(f => f.endsWith('.lock'));
  fs.writeFileSync(path.join(root, entry, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'abandoned' }));
  acquire(binding, { root, alive: () => false }).release();
});

test('all Remote callers reject local contention before auth or network, including separate business roots', async () => {
  const prior = process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR;
  process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR = root;
  const binding = { sid: 'active', mid: 'desktop' }, lease = acquire(binding, { root });
  let credentials = 0;
  const remote = new ZCodeRemote(binding, { credential: () => { credentials++; return 'unused'; } });
  try {
    await assert.rejects(remote.connect(), { code: 'ZCODE_RELAY_LOCAL_BUSY' });
    assert.equal(credentials, 0);
    lease.release();
    const rejected = new ZCodeRemote(binding, { credential: () => undefined });
    await assert.rejects(rejected.connect(), /login unavailable/);
    acquire(binding, { root }).release();
  } finally {
    lease.release();
    if (prior === undefined) delete process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR;
    else process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR = prior;
  }
});
