'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-hooks-'));
process.env.AGENT_BRIDGE_STATE_DIR = root;
const { ensureHooks, hookDefinition, prepareWorker, KEY } = require('../lib/agy-hooks');
const { saveTask, taskDir } = require('../lib/util');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('project Hook installation preserves unrelated definitions and refuses edited owned configuration', () => {
  const task = { cwd: path.join(root, 'project with spaces'), stateDir: root };
  fs.mkdirSync(path.join(task.cwd, '.agents'), { recursive: true });
  const file = path.join(task.cwd, '.agents', 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ userHook: { enabled: false } }));
  ensureHooks(task); const first = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(first).userHook, { enabled: false });
  assert.deepEqual(JSON.parse(first)[KEY], hookDefinition());
  assert.equal(JSON.parse(first)[KEY].PreInvocation[0].command, 'node codex-agent-bridge-agy.cjs PreInvocation');
  assert.match(fs.readFileSync(path.join(task.cwd, '.agents/codex-agent-bridge-agy.cjs'), 'utf8'), /require\(/);
  assert.equal(fs.readdirSync(path.join(root, 'hook-backups')).length, 1);
  ensureHooks(task); assert.equal(fs.readFileSync(file, 'utf8'), first);
  fs.writeFileSync(file, JSON.stringify({ [KEY]: { enabled: false } }));
  assert.throws(() => ensureHooks(task), /changed/);
});

test('preflight verifies the native ID without submitting a model prompt', async () => {
  const previous = process.env.AGENT_BRIDGE_AGY;
  process.env.AGENT_BRIDGE_AGY = path.join(__dirname, 'fixtures/agy-stub.cjs');
  const task = { id: 'agy-preflight-test', cwd: path.join(root, 'preflight'), stateDir: root,
    herdrSession: 'test-service', paneId: 'w1:p8', skipPermissions: true };
  fs.mkdirSync(task.cwd, { recursive: true });
  try { await prepareWorker(task, 'original-session'); }
  finally { if (previous === undefined) delete process.env.AGENT_BRIDGE_AGY; else process.env.AGENT_BRIDGE_AGY = previous; }
  assert.equal(task.workerSessionId, 'original-session');
  const events = fs.readFileSync(path.join(root, 'hook-events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).source, 'agy-cli-preflight');
  assert.equal(events.at(-1).sessionId, 'original-session');
});

test('native Hooks inject policy once, preserve approvals and distinguish background work', () => {
  const task = { id: 'agy-hook-test', agent: 'agy', stateDir: root, paneId: 'w1:p7', herdrSession: 'test-service',
    workerSessionId: 'native-conversation', round: 1, history: [], workerPolicySha256: 'test-policy' };
  task.workerPolicyPath = path.join(taskDir(task.id), 'worker-policy.md'); saveTask(task);
  fs.writeFileSync(task.workerPolicyPath, 'Test policy / 测试规则');
  const invoke = (name, payload = {}) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '../hooks/herdr-agy.js'), name], { encoding: 'utf8',
      env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: task.paneId, HERDR_BIN_PATH: 'never-executed-in-dry-run',
        AGENT_BRIDGE_HERDR_SESSION: task.herdrSession, AGENT_BRIDGE_TASK_ID: task.id, AGENT_BRIDGE_HOOK_DRY_RUN: '1' },
      input: JSON.stringify({ conversationId: task.workerSessionId, ...payload }) });
    assert.equal(r.status, 0); return JSON.parse(r.stdout);
  };
  const first = invoke('PreInvocation');
  assert.match(first.injectSteps[0].systemMessage.systemMessage, /Test policy/);
  assert.equal(invoke('PreInvocation').injectSteps, undefined);
  const approval = invoke('PreToolUse', { toolCall: { name: 'ask_permission' } });
  assert.equal(approval.dryRun.state, 'blocked'); assert.equal(approval.decision, 'allow');
  assert.equal(approval.permissionOverrides, undefined);
  assert.equal(invoke('PreToolUse', { toolCall: { name: 'notify_user', args: { BlockedOnUser: false } } }).dryRun.state, 'working');
  assert.equal(invoke('Stop', { fullyIdle: false }).dryRun.state, 'blocked');
  assert.equal(invoke('Stop', { fullyIdle: true }).dryRun.state, 'idle');
  assert.equal(invoke('Stop', { fullyIdle: true, error: 'quota exhausted' }).dryRun.state, 'blocked');
});
