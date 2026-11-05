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

test('custom-source missing native metadata requires exact receipt and live wrapper process proof', async () => {
  const f = fixture(); delete f.agent.agent_session;
  assert.equal((await submit(f.task, 'unused', f.deps)).nativeAcceptanceConfirmed, false);
  assert.equal(f.proofs.length, 2);
  const g = fixture(); delete g.agent.agent_session;
  g.deps.prove = async () => { throw new Error('process no longer bound'); };
  await assert.rejects(submit(g.task, 'unused', g.deps), e => e.requestSent === false);
  assert.equal(g.calls.some(c => c[1] === 'run'), false);
  const h = fixture(); h.agent.agent_session.value = 'foreign-native';
  await assert.rejects(submit(h.task, 'unused', h.deps), e => e.requestSent === false);
  assert.equal(h.calls.length, 0);
});

test('real exit-zero empty CLI stdout is recorded as text_queued, not native acceptance', async () => {
  const f = fixture(), cli = path.join(root, 'empty-cli.cjs'), log = path.join(root, 'empty-cli.calls');
  fs.writeFileSync(cli, `require('node:fs').appendFileSync(${JSON.stringify(log)},'called\\n');`);
  const previous = process.env.HERDR_BIN_PATH; process.env.HERDR_BIN_PATH = cli;
  const original = f.deps.call;
  f.deps.call = (session, args, options) => args[1] === 'run' ? require('../lib/herdr').api(session, args, options) : original(session, args);
  try {
    const result = await submit(f.task, 'unused', f.deps);
    assert.equal(result.status, 'text_queued'); assert.equal(result.nativeAcceptanceConfirmed, false);
    assert.deepEqual(result.transportAcknowledgement, { transport: 'herdr-cli', exitCode: 0, emptyStdout: true });
    assert.equal(fs.readFileSync(log, 'utf8'), 'called\n');
  } finally { if (previous === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = previous; }
});

test('null, malformed CLI receipt, nonzero and nested negative outcomes retain uncertainty with no second write', async () => {
  for (const response of [null, { transport: 'herdr-cli', exitCode: 0 }, { transport: 'herdr-cli', exitCode: 7, response: null },
    { transport: 'herdr-cli', exitCode: 0, response: { result: { error: { code: 'denied' } } } }]) {
    const f = fixture(), original = f.deps.call; let writes = 0;
    f.deps.call = (session, args) => { if (args[1] === 'run') { writes++; return response; } return original(session, args); };
    await assert.rejects(submit(f.task, 'unused', f.deps), error => error.requestSent !== false && error.transportDiagnostic?.outcome === 'uncertain');
    assert.equal(writes, 1);
  }
});
