'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-agents-'));
process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
process.env.AGENT_BRIDGE_CBC = 'C:\\fake dir\\cbc.cmd';

const { getAgent, listAgents, chooseAgentName } = require('../lib/agents');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('registry exposes the cbc worker', () => {
  assert.deepEqual(listAgents(), [{ id: 'cbc', label: 'CodeBuddy CLI' }]);
});

test('display names are independent of task IDs and remain unique among live agents', () => {
  assert.equal(chooseAgentName('cbc', [], 'w1:p1'), 'cbc');
  assert.equal(chooseAgentName('cbc', [{ name: 'cbc', pane_id: 'w2:p1' }], 'w1:p1'), 'cbc-2');
  assert.equal(chooseAgentName('cbc', [{ name: 'cbc', pane_id: 'w1:p1' }], 'w1:p1'), 'cbc');
});

test('unknown agent names are rejected with the list of registered agents', () => {
  assert.throws(() => getAgent('zcode'), /Unsupported agent: zcode.*cbc/);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => getAgent(name), /Unsupported agent/);
  }
});

test('cbc command skips permissions by default and quotes paths', () => {
  const task = { id: 'test-cmd-ok', skipPermissions: true, permissionMode: 'acceptEdits' };
  const command = getAgent('cbc').buildCommand(task, null);
  assert.match(command, /^& 'C:\\fake dir\\cbc\.cmd'/);
  assert.match(command, / -y /);
  assert.match(command, /--add-dir '.*test-cmd-ok'/);
  assert.doesNotMatch(command, /--resume/);
});

test('cbc command honours permission mode and resume id', () => {
  const task = { id: 'test-cmd-resume', skipPermissions: false, permissionMode: 'ask' };
  const command = getAgent('cbc').buildCommand(task, 'session-123');
  assert.doesNotMatch(command, / -y /);
  assert.match(command, /--permission-mode 'ask'/);
  assert.match(command, /--resume 'session-123'/);
});
