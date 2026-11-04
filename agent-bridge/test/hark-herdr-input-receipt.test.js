'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const herdr = require('../lib/herdr');
const { submit } = require('../lib/cbc-prompt');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-receipt-'));
const cli = path.join(root, 'herdr-cli-fixture.cjs');
fs.writeFileSync(cli, `const fs=require('fs');if(process.env.RECEIPT_CALLS)fs.appendFileSync(process.env.RECEIPT_CALLS,'called\\n');
const mode=process.env.RECEIPT_MODE;
if(mode==='timeout')setTimeout(()=>{},5000);
else if(mode==='nonzero'){process.stderr.write('private diagnostic must not escape');process.exitCode=7;}
else if(mode==='negative')process.stdout.write(JSON.stringify({result:{error:{code:'fixture_error'}}}));
else if(mode==='json')process.stdout.write(JSON.stringify({result:{queued:true}}));`);
test.after(() => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });

function withCli(fn) {
  const old = process.env.HERDR_BIN_PATH; process.env.HERDR_BIN_PATH = cli;
  return Promise.resolve().then(fn).finally(() => {
    if (old === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = old;
  });
}

function dependencies(paneRun) {
  const start = new Date(Date.now() - 10000).toISOString();
  const task = { id: 'receipt-fixture-task', agent: 'cbc', round: 1, stateDir: root, status: 'running',
    cwd: root, paneId: 'fixture-pane', terminalId: 'fixture-terminal', workerSessionId: 'fixture-native',
    herdrSession: 'fixture', agentName: 'cbc', workerStartedAt: start, cbcNativeBinary: 'fixture-cbc.cmd',
    submission: { status: 'sending', attemptId: 'attempt-fixture', baselineCompletion: 0, baselineStateChange: 101 } };
  const pane = { pane_id: task.paneId, terminal_id: task.terminalId };
  const agent = { ...pane, agent: 'codebuddy', name: 'cbc', agent_status: 'idle', state_change_seq: 101 };
  const hookTime = new Date().toISOString();
  const deps = { paneRun, readTask: () => task, readLease: () => ({ ...task, taskId: task.id }),
    readEvents: () => [{ name: 'SessionStart', timestamp: hookTime, identityBound: true,
      taskId: task.id, round: 0, paneId: task.paneId, terminalId: task.terminalId,
      sessionId: task.workerSessionId, herdrSession: task.herdrSession }],
    resolveCbcExecutable: () => ({ executablePath: 'fixture-node', scriptPath: 'fixture-cbc' }),
    proveProcess: async () => ({ kind: 'cbc', pid: 10101, shellPid: 10100, processStartedAt: start }),
    call: (_s, args) => {
      const key = args.slice(0, 2).join(' '), data = {
        'pane get': { pane }, 'agent get': { agent }, 'pane list': { panes: [pane] },
        'agent list': { agents: [agent] }, 'pane process-info': { process_info: { shell_pid: 10100 } },
        'pane read': { text: 'CBC ready' },
      }[key];
      assert.ok(data, 'only the dedicated fixture may receive input'); return { result: data };
    } };
  return { task, deps };
}

test('actual CLI process distinguishes exit-zero empty stdout from a missing transport receipt without changing legacy reads', () => withCli(() => {
  assert.equal(herdr.run([], { env: { RECEIPT_MODE: 'empty' } }), null);
  assert.deepEqual(herdr.run([], { includeTransportReceipt: true, env: { RECEIPT_MODE: 'empty' } }),
    { transport: 'herdr-cli', exitCode: 0, response: null });
  assert.deepEqual(herdr.run([], { includeTransportReceipt: true, env: { RECEIPT_MODE: 'json' } }).response,
    { result: { queued: true } });
}));

test('guarded CBC input accepts a proven exit-zero empty CLI result only as text_queued, exactly once', () => withCli(async () => {
  const calls = path.join(root, 'success-calls');
  const f = dependencies((_s, pane, text) => herdr.run(['pane', 'run', pane, text], {
    includeTransportReceipt: true, env: { RECEIPT_MODE: 'empty', RECEIPT_CALLS: calls },
  }));
  const result = await submit(f.task, 'isolated pointer', f.deps);
  assert.equal(result.status, 'text_queued'); assert.equal(result.nativeAcceptanceConfirmed, false);
  assert.deepEqual(result.transportAcknowledgement, { transport: 'herdr-cli', exitCode: 0, emptyStdout: true });
  assert.equal(fs.readFileSync(calls, 'utf8'), 'called\n');
}));

test('nonzero exit, timeout and explicit negative response remain unknown and never retry input', () => withCli(async () => {
  for (const mode of ['nonzero', 'timeout', 'negative']) {
    const calls = path.join(root, mode + '-calls');
    const f = dependencies((_s, pane, text) => herdr.run(['pane', 'run', pane, text], {
      includeTransportReceipt: true, timeout: mode === 'timeout' ? 200 : 3000,
      env: { RECEIPT_MODE: mode, RECEIPT_CALLS: calls },
    }));
    await assert.rejects(submit(f.task, 'isolated pointer', f.deps), error => {
      assert.equal(error.code, 'CBC_PROMPT_OUTCOME_UNKNOWN');
      assert.equal(error.requestSent, true);
      assert.doesNotMatch(JSON.stringify(error.transportDiagnostic), /private diagnostic/);
      return true;
    });
    assert.equal(fs.readFileSync(calls, 'utf8'), 'called\n');
  }
}));

test('a bare null or malformed typed receipt is still uncertain', async () => {
  for (const receipt of [null, { transport: 'herdr-cli', exitCode: 0 }, { transport: 'herdr-cli', exitCode: 1, response: null }]) {
    let calls = 0;
    const f = dependencies(async () => { calls++; return receipt; });
    await assert.rejects(submit(f.task, 'isolated pointer', f.deps), { code: 'CBC_PROMPT_OUTCOME_UNKNOWN' });
    assert.equal(calls, 1);
  }
});
