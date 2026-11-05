'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { writeLease } = require('../lib/worker-lease');

test('known-session startup failure stays detached and a later explicit resume is not poisoned by rejected initialization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-recoverable-start-'));
  const directory = path.join(root, 'tasks', 'recoverable-start'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'recoverable-start', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 4, status: 'blocked', workerSessionId: 'original-session' };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  fs.writeFileSync(path.join(directory, 'round-004-zcode-command.json'), JSON.stringify({ envelope: {
    commandId: 'already-running', sessionId: task.workerSessionId } }));
  const herdr = path.join(root, 'herdr.json'), trigger = path.join(root, 'fail'), calls = path.join(root, 'calls.ndjson');
  fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} })); fs.writeFileSync(trigger, 'fail');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), task.workerSessionId], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root,
      AGENT_BRIDGE_TASK_ID: task.id, AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane',
      ZCODE_TEST_RUNNING: '1', ZCODE_TEST_RECOVERY_FAILURE: trigger, ZCODE_TEST_CALLS: calls,
      HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  try {
    await new Promise((resolve, reject) => {
      let output = '', resumed = false;
      const timer = setTimeout(() => reject(new Error(`known-session recovery stalled: ${output}`)), 10000);
      child.once('error', reject); child.stdout.on('data', chunk => {
        output += chunk;
        if (!resumed && output.includes('zcode: blocked (relay_kicked)')) {
          resumed = true; fs.unlinkSync(trigger); child.stdin.write(':resume\n');
        }
        if (output.includes('zcode: working')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(child.exitCode, null); assert.equal(fs.existsSync(calls), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'zcode-state.json'))).commandId, 'already-running');
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deferred reload keeps the same saved session and command without opening any connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-deferred-'));
  const directory = path.join(root, 'tasks', 'deferred-observer'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'deferred-observer', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 4, status: 'blocked', workerSessionId: 'original-session' };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  fs.writeFileSync(path.join(directory, 'round-004-zcode-command.json'), JSON.stringify({ envelope: {
    commandId: 'original-command', sessionId: task.workerSessionId } }));
  const herdr = path.join(root, 'herdr.json'); fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), task.workerSessionId, '--defer-observe'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root,
      AGENT_BRIDGE_TASK_ID: task.id, AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane',
      ZCODE_TEST_FORBID_CONNECT: '1', HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`deferred observer stalled: ${output}`)), 10000);
      child.once('error', reject); child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('zcode: blocked (observer_detached)')) { clearTimeout(timer); resolve(); }
      });
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'zcode-state.json')));
    assert.equal(receipt.sessionId, task.workerSessionId); assert.equal(receipt.commandId, 'original-command');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'task.json'))).status, 'blocked');
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume failure retains the real stage, command binding and KICKED cause without another native write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-resume-error-'));
  const directory = path.join(root, 'tasks', 'resume-failure'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'resume-failure', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 0, status: 'ready', workerSessionId: 'original-session' };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  const herdr = path.join(root, 'herdr.json'), calls = path.join(root, 'calls.ndjson'), trigger = path.join(root, 'fail');
  fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), task.workerSessionId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root, AGENT_BRIDGE_TASK_ID: task.id,
      AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane', ZCODE_TEST_CALLS: calls,
      ZCODE_TEST_RECOVERY_FAILURE: trigger, HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  try {
    await new Promise((resolve, reject) => {
      let output = '', sent = false;
      const timer = setTimeout(() => reject(new Error(`resume stalled: ${output}`)), 10000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (!sent && output.includes('zcode: idle')) {
          sent = true; task.round = 1; task.status = 'blocked';
          fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
          fs.writeFileSync(path.join(directory, 'round-001-zcode-command.json'), JSON.stringify({ envelope: {
            commandId: 'original-command', sessionId: task.workerSessionId } }));
          fs.writeFileSync(trigger, 'fail'); child.stdin.write(':resume\n');
        }
        if (output.includes('zcode: blocked (relay_kicked)')) { clearTimeout(timer); resolve(); }
      });
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'zcode-state.json')));
    assert.equal(receipt.diagnostic.stage, 'attach-project');
    assert.equal(receipt.diagnostic.message, 'ZCode relay KICKED');
    assert.equal(receipt.commandId, 'original-command');
    assert.equal(fs.existsSync(path.join(directory, 'zcode-errors.ndjson')), true);
    assert.equal(fs.existsSync(calls), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'task.json'))).status, 'blocked');
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker automatically attests original session after uncertain first creation, without creating twice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-worker-'));
  const directory = path.join(root, 'tasks', 'create-recovery'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'create-recovery', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 0, status: 'ready' };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  const herdr = path.join(root, 'herdr.json'), calls = path.join(root, 'calls.ndjson');
  fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root, AGENT_BRIDGE_TASK_ID: task.id,
      AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane', ZCODE_TEST_CALLS: calls,
      HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  let output = '', errors = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker stalled: ${output} ${errors}`)), 10000);
      child.once('error', reject);
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('zcode: idle')) { clearTimeout(timer); resolve(); } });
    });
    const recovered = JSON.parse(fs.readFileSync(path.join(directory, 'zcode-create.json')));
    assert.equal(recovered.ack.result.sessionId, 'recovered-original-session');
    assert.equal(recovered.status, 'acknowledged');
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
      [['command', 'uncertain-original-create'], ['query', 'uncertain-original-create']]);
    const registered = JSON.parse(fs.readFileSync(herdr)).calls;
    assert.ok(registered.some(call => call.includes('--agent-session-id') && call.includes('recovered-original-session')));
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a resumed sending journal queries the same admission key and never resends unknown input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-send-unknown-'));
  const directory = path.join(root, 'tasks', 'send-unknown'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'send-unknown', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 3, status: 'blocked', workerSessionId: 'original-session' };
  const command = { type: 'sendText', commandId: 'original-unknown-command', sessionId: task.workerSessionId,
    payload: { text: 'this exact command is never replayed' } };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  fs.writeFileSync(path.join(directory, 'round-003-zcode-command.json'), JSON.stringify({ envelope: command, status: 'sending' }));
  const herdr = path.join(root, 'herdr.json'), calls = path.join(root, 'calls.ndjson');
  fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), task.workerSessionId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root, AGENT_BRIDGE_TASK_ID: task.id,
      AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane', ZCODE_TEST_CALLS: calls,
      ZCODE_TEST_QUERY_UNKNOWN: '1', HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`unknown admission reconciliation stalled: ${output}`)), 15000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('zcode: blocked (execution_unconfirmed)')) { clearTimeout(timer); resolve(); }
      });
    });
    const callsLog = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(callsLog.length >= 4); assert.ok(callsLog.every(([op, id]) => op === 'query' && id === command.commandId));
    const journal = JSON.parse(fs.readFileSync(path.join(directory, 'round-003-zcode-command.json')));
    assert.equal(journal.status, 'sending'); assert.equal(journal.envelope.commandId, command.commandId);
    assert.equal(callsLog.some(([op]) => op === 'command'), false);
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume while the original observer is busy attests it without another Relay or task write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-busy-'));
  const directory = path.join(root, 'tasks', 'busy-recovery'); fs.mkdirSync(directory, { recursive: true });
  const task = { id: 'busy-recovery', agent: 'zcode', stateDir: root, cwd: root, herdrSession: 'stub', paneId: 'pane',
    terminalId: 'terminal', round: 1, status: 'running', workerSessionId: 'original-session' };
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  writeLease(task);
  fs.writeFileSync(path.join(directory, 'round-001-zcode-command.json'), JSON.stringify({ envelope: {
    type: 'sendText', sessionId: task.workerSessionId, commandId: 'already-running' } }));
  const herdr = path.join(root, 'herdr.json'), calls = path.join(root, 'calls.ndjson');
  fs.writeFileSync(herdr, JSON.stringify({ calls: [], agent: {} }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/zcode-preload.cjs'),
    path.join(__dirname, '../bin/zcode-worker.js'), task.workerSessionId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: root, AGENT_BRIDGE_TASK_ID: task.id,
      AGENT_BRIDGE_HERDR_SESSION: 'stub', HERDR_PANE_ID: 'pane', ZCODE_TEST_CALLS: calls, ZCODE_TEST_RUNNING: '1',
      HERDR_BIN_PATH: path.join(__dirname, 'fixtures/herdr-stub.cjs'), BRIDGE_STUB_STATE: herdr } });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      let sent = false;
      const timer = setTimeout(() => reject(new Error(`busy observer stalled: ${output}`)), 10000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (!sent && output.includes('zcode: working')) { sent = true; child.stdin.write('stale-pane-input:resume\n'); }
        if ((output.match(/zcode: working/g) || []).length >= 2) { clearTimeout(timer); resolve(); }
      });
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'zcode-state.json')));
    assert.equal(receipt.observerAlreadyAttached, true); assert.equal(receipt.commandId, 'already-running');
    assert.match(output, /discarded stale Pane input before resume control/);
    assert.equal(fs.existsSync(calls), false);
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
