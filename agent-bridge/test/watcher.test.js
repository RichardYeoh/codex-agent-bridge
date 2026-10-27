'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-watcher-'));
const { saveTask, loadTask } = require('../lib/util');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const [mode, terminal, expected] of [
  ['timeout', '', 'wait_timeout'],
  ['idle', 'API error: insufficient_quota', 'quota'],
  ['blocked', 'fetch failed: ENOTFOUND', 'network'],
  ['idle', '429 Too Many Requests', 'rate_limit'],
]) {
  test(`watcher preserves session and never resubmits after ${expected}`, () => {
    const stateDir = path.join(root, expected);
    process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'herdr.json');
    const value = { id: 'watcher-test', stateDir, status: 'running', round: 1, agent: 'cbc',
      herdrSession: 'stub', paneId: 'w1:p1', terminalId: 'term-stub', agentName: 'cbc',
      workerSessionId: 'preserved-session', history: [], waitTimeoutMs: 50 };
    saveTask(value);
    fs.writeFileSync(stateFile, JSON.stringify({ mode, terminal, calls: [], agent: {
      agent: 'codebuddy', name: 'cbc', terminal_id: 'term-stub', completion_seq: 2,
      agent_status: mode === 'blocked' ? 'blocked' : 'idle',
    } }));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/agent-bridge-watcher.js'), value.id], {
      env: { ...process.env, BRIDGE_STUB_STATE: stateFile,
        HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs') },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const settled = loadTask(value.id);
    assert.equal(settled.status, 'blocked');
    assert.equal(settled.blocker.type, expected);
    assert.equal(settled.workerSessionId, 'preserved-session');
    assert.equal(settled.round, 1);
    assert.equal(settled.notification.status, 'pending');
    const calls = JSON.parse(fs.readFileSync(stateFile)).calls;
    assert.equal(calls.filter(call => ['send-text', 'send-keys', 'run'].includes(call[1])).length, 0);
    assert.ok(calls.some(call => call[1] === 'wait' && call.includes('50')));
    if (expected === 'wait_timeout') assert.equal(settled.blocker.originalExecutionMayContinue, true);
    settled.status = 'running';
    const firstKey = settled.notification.key;
    saveTask(settled);
    const resumed = spawnSync(process.execPath, [path.join(__dirname, '../bin/agent-bridge-watcher.js'), value.id], {
      env: { ...process.env, BRIDGE_STUB_STATE: stateFile,
        HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs') },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.notEqual(loadTask(value.id).notification.key, firstKey);
    assert.equal(loadTask(value.id).round, 1);
  });
}
