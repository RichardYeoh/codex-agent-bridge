'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { submit } = require('../lib/zcode-prompt');
const { writeJsonAtomic, saveTask, taskDir } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-zcode-input-'));
let seq = 0;
test.after(() => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const stateDir = path.join(root, 'case-' + ++seq); process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const task = { id: 'zcode-input-test', agent: 'zcode', stateDir, cwd: stateDir, herdrSession: 'fixture',
    paneId: 'own-pane', terminalId: 'own-terminal', workerSessionId: 'own-native', round: 2,
    status: 'running', submission: { status: 'sending' }, history: [], promptPath: path.join(stateDir, 'round.md') };
  const born = new Date().toISOString();
  const state = { taskId: task.id, round: 1, state: 'idle', herdrSession: task.herdrSession,
    sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId, workerPid: 9001, workerProcessStartedAt: born };
  saveTask(task); writeLease(task);
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json'); writeJsonAtomic(stateFile, state);
  const calls = [], proofs = [];
  const agent = { agent: 'zcode', agent_status: 'idle', terminal_id: task.terminalId, agent_session: { value: task.workerSessionId } };
  const deps = { inspect: () => agent, inspectPane: () => ({ pane_id: task.paneId, terminal_id: task.terminalId }),
    call: (_s, args) => { calls.push(args); return { result: { type: 'input', process_info: { shell_pid: 10, foreground_processes: [] } } }; },
    prove: async input => { proofs.push(input); return { kind: 'zcode-wrapper', pid: state.workerPid, processStartedAt: born }; } };
  return { task, state, stateFile, calls, proofs, deps, agent };
}

test('owned ZCode readline receiver gets one atomic pane.run after two process checks, without agent.prompt', async () => {
  const f = fixture(), result = await submit(f.task, 'unused pointer', f.deps);
  assert.equal(result.nativeAcceptanceConfirmed, false); assert.equal(f.proofs.length, 2);
  assert.equal(f.calls.filter(args => args[1] === 'run').length, 1);
  assert.equal(f.calls.find(args => args[1] === 'run')[3], f.task.promptPath);
  assert.deepEqual(f.calls.filter(args => args[1] === 'send-keys').map(args => args[3]), ['ctrl+u']);
  assert.equal(f.calls.some(args => args[0] === 'agent'), false);
});

test('wrong wrapper/native/PID/lifetime or blocked input never receives business text', async () => {
  for (const variant of ['native', 'round', 'blocked', 'process', 'lifetime']) {
    const f = fixture();
    if (variant === 'native') { f.state.sessionId = 'other-native'; writeJsonAtomic(f.stateFile, f.state); }
    if (variant === 'round') { f.state.round = 0; writeJsonAtomic(f.stateFile, f.state); }
    if (variant === 'blocked') f.agent.agent_status = 'blocked';
    if (variant === 'process') f.deps.prove = async () => ({ pid: 9002, processStartedAt: f.state.workerProcessStartedAt });
    if (variant === 'lifetime') f.deps.prove = async () => ({ pid: 9001, processStartedAt: '2000-01-01T00:00:00Z' });
    await assert.rejects(submit(f.task, 'unused', f.deps), error => error.requestSent === false && error.origin === 'bridge-preflight');
    assert.equal(f.calls.some(args => args[1] === 'run'), false);
  }
});

test('a lost pane.run response remains uncertain and is never automatically retried', async () => {
  const f = fixture(), original = f.deps.call;
  f.deps.call = (s, args) => { const result = original(s, args); if (args[1] === 'run') throw new Error('fixture lost reply'); return result; };
  await assert.rejects(submit(f.task, 'unused', f.deps), error => error.requestSent !== false);
  assert.equal(f.calls.filter(args => args[1] === 'run').length, 1);
});
