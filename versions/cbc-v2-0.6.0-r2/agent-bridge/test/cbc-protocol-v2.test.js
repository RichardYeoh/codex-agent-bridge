'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test'), assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-layered-test-'));
process.env.AGENT_BRIDGE_STATE_DIR = path.join(root, 'state');
process.env.USERPROFILE = path.join(root, 'home');
const p = require('../lib/protocol-v2'), cbc = require('../lib/cbc-protocol-v2');
const artifacts = require('../lib/protocol-artifacts');
const util = require('../lib/util'), policy = require('../lib/worker-policy');
let serial = 0;
async function fixture({ hookPrompt, beforeInput } = {}) {
  const n = ++serial, cwd = path.join(root, 'project-' + n), id = 'layered-test-' + n;
  const dir = path.join(util.config().stateDir, 'tasks', id); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cwd);
  const task = { id, agent: 'cbc', taskProtocol: 2, cbcTurnProtocol: 1, round: 1, stateDir: util.config().stateDir,
    cwd, workerSessionId: 'native-test-' + n, terminalId: 'terminal-test-' + n, paneId: 'workspace:pane-' + n,
    herdrSession: 'fixture', workerStartedAt: new Date(Date.now() - 2000).toISOString(),
    promptPath: path.join(dir, 'round-001-prompt.md'), deliveryPath: path.join(dir, 'deliveries', 'round-001.md'),
    allowedWritePaths: [cwd], history: [], status: 'running', promptContext: { mode: 'full' },
    taskSpec: { version: 'task-spec-v1', goal: 'fixture', background: 'fixture', inputs: ['input.txt'], allowedChanges: [cwd],
      requirements: ['produce output'], acceptance: [{ command: 'node check.js', expected: 'exit 0' }], deliverables: ['output.txt'] } };
  fs.mkdirSync(path.dirname(task.deliveryPath)); fs.writeFileSync(task.promptPath, 'fixture specification');
  const attempt = require('../lib/submission-attempt').prepare(task);
  const request = await cbc.prepare(task, attempt);
  task.submission = { ...attempt, status: 'sending' }; util.saveTask(task);
  const native = path.join(process.env.USERPROFILE, '.codebuddy', 'projects', 'fixture', task.workerSessionId + '.jsonl');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  const pointer = policy.renderSubmissionPointer(task), at = new Date().toISOString();
  const row = { id: 'user-' + n, type: 'message', role: 'user', timestamp: at, cwd, sessionId: task.workerSessionId,
    content: [{ type: 'input_text', text: pointer }] };
  fs.writeFileSync(native, (beforeInput ? JSON.stringify({ ...row, id: 'earlier-input', content: [{ type: 'input_text', text: beforeInput }] }) + '\n' : '') + JSON.stringify(row) + '\n');
  const raw = { hook_event_name: 'UserPromptSubmit', session_id: task.workerSessionId, transcript_path: native, prompt: hookPrompt || pointer };
  await cbc.capture(task, raw, require('../lib/cbc-turn').captureSubmission(raw, task));
  return { task, request, native, row, raw, pointer };
}
async function finish(f) {
  fs.writeFileSync(f.task.deliveryPath, 'Review this frozen version'); fs.writeFileSync(path.join(f.task.cwd, 'output.txt'), 'old output');
  await artifacts.submitResult(f.request, { outcome: 'delivered' });
  await cbc.capture(f.task, { ...f.raw, hook_event_name: 'Stop' }, {});
  return cbc.sync(f.task);
}

test('request gets machine command, exact admission and automatic required artifact freeze', async () => {
  const f = await fixture();
  assert.match(fs.readFileSync(f.task.promptPath, 'utf8'), /bridge-result\.js/);
  assert.equal(p.inspect(f.request).transport, 'admitted');
  assert.equal(cbc.readTurn(f.task).state, 'active');
  await finish(f);
  assert.equal(f.task.status, 'review_pending');
  assert.equal(artifacts.readManifest(f.request).files.length, 2);
  assert.equal(cbc.readTurn(f.task).state, 'stopped');
});

test('rework request links immutable prior result without overwriting its evidence', async () => {
  const f = await fixture(); await finish(f); const previous = structuredClone(f.task);
  const old = p.load(f.request).eventsSha256;
  f.task.round = 2; f.task.promptPath = path.join(path.dirname(f.task.promptPath), 'round-002-prompt.md');
  f.task.deliveryPath = path.join(path.dirname(f.task.deliveryPath), 'round-002.md');
  fs.writeFileSync(f.task.promptPath, 'new requirements');
  const attempt = require('../lib/submission-attempt').prepare(f.task);
  const next = await cbc.prepare(f.task, attempt, { previous });
  assert.equal(next.predecessor.requestSha256, p.digest(f.request));
  assert.equal(next.predecessor.resultSha256, p.inspect(f.request).resultSha256);
  assert.equal(p.load(f.request).eventsSha256, old);
  assert.throws(() => p.validateRequest({ ...next, predecessor: { ...next.predecessor, round: next.round } }), /predecessor/);
});

test('Hook prompt metadata differs while first native input exactly matches the submitted pointer', async () => {
  const f = await fixture({ hookPrompt: 'Hook metadata prefix plus transformed native prompt' });
  const admission = p.load(f.request).events.find(e => e.kind === 'native.admitted');
  assert.equal(p.inspect(f.request).transport, 'admitted');
  assert.notEqual(admission.payload.hookPromptSha256, f.request.pointerSha256);
  assert.equal(admission.payload.pointerSha256, p.sha(Buffer.from(f.pointer)));
  await finish(f); assert.equal(f.task.status, 'review_pending');
});

test('exact pointer appearing after an independent native input is not accepted by a transformed Hook', async () => {
  await assert.rejects(fixture({ hookPrompt: 'transformed hook', beforeInput: 'independent user input' }), /first ordered Hook boundary/);
});

test('idle reminder after Stop preserves readiness; permission notification still blocks', async () => {
  const f = await fixture();
  const entry = { herdrSession: f.task.herdrSession, sessionId: f.task.workerSessionId,
    paneId: f.task.paneId, terminalId: f.task.terminalId, taskId: f.task.id, round: 1,
    timestamp: new Date().toISOString(), identityBound: true, name: 'Stop' };
  const reminder = { ...entry, name: 'Notification', notificationType: 'idle_prompt' };
  const boundary = require('../lib/cbc-prompt').hookBoundary;
  assert.equal(boundary({ ...f.task, round: 2 }, [entry, reminder]), entry);
  assert.throws(() => boundary({ ...f.task, round: 2 }, [entry, { ...reminder, notificationType: 'permission_prompt' }]), /idle boundary/);
});

test('worker profile adds task-only Hooks without duplicating the installed status plugin', async () => {
  const f = await fixture(), home = path.join(process.env.USERPROFILE, '.codebuddy');
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hooks', 'herdr-codebuddy-hook.js'), '// synthetic custom:codebuddy provider / 合成状态插件');
  const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']
    .map(name => [name, [{ hooks: [{ type: 'command', command: 'node "$HOME/.codebuddy/hooks/herdr-codebuddy-hook.js"' }] }]]));
  const original = JSON.stringify({ unrelated: true, hooks });
  fs.writeFileSync(path.join(home, 'settings.json'), original);
  cbc.prepareWorker(f.task);
  const profile = JSON.parse(fs.readFileSync(f.task.cbcSettingsPath));
  assert.equal(profile.contextWindow, 1000000);
  for (const entries of Object.values(profile.hooks)) {
    assert.equal(entries[0].hooks.length, 1); assert.match(entries[0].hooks[0].command, /cbc-task-events\.js/);
  }
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), original);
  delete hooks.Stop; fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks }));
  assert.throws(() => cbc.prepareWorker(f.task), /not configured for Stop/);
});

test('after frozen completion, unrelated manual chat cannot erase result or prevent snapshot acceptance', async () => {
  const f = await fixture(); await finish(f);
  const expected = p.inspect(f.request).resultSha256;
  await new Promise(resolve => setTimeout(resolve, 5));
  const manual = { ...f.row, id: 'manual-user', timestamp: new Date().toISOString(), content: [{ type: 'input_text', text: 'independent question' }] };
  fs.appendFileSync(f.native, JSON.stringify(manual) + '\n');
  await cbc.capture(f.task, { ...f.raw, prompt: 'independent question' }, {});
  await cbc.capture(f.task, { ...f.raw, hook_event_name: 'Stop' }, {});
  fs.writeFileSync(path.join(f.task.cwd, 'output.txt'), 'new manual content');
  assert.equal(p.inspect(f.request).resultSha256, expected);
  assert.equal(cbc.readTurn(f.task).state, 'stopped');
  const accepted = await cbc.accept(f.task);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.frozenResult.sourceDrift.length, 1);
});

test('manual input before completion does not donate its Stop or result to the old request', async () => {
  const f = await fixture(); await new Promise(resolve => setTimeout(resolve, 5));
  fs.appendFileSync(f.native, JSON.stringify({ ...f.row, id: 'manual-active', timestamp: new Date().toISOString(), content: [{ type: 'input_text', text: 'new work' }] }) + '\n');
  await cbc.capture(f.task, { ...f.raw, prompt: 'new work' }, {});
  await cbc.capture(f.task, { ...f.raw, hook_event_name: 'Stop' }, {});
  assert.equal(cbc.readTurn(f.task).state, 'unconfirmed');
  assert.equal(p.load(f.request).events.some(x => x.kind === 'native.stopped'), false);
  await assert.rejects(cbc.accept(f.task), /no verified frozen result/);
});

test('native Stop without structured worker result is delivery_missing, never inferred success', async () => {
  const f = await fixture(); fs.writeFileSync(f.task.deliveryPath, 'File existence is insufficient');
  await cbc.capture(f.task, { ...f.raw, hook_event_name: 'Stop' }, {});
  cbc.sync(f.task); assert.equal(f.task.status, 'delivery_missing');
  await assert.rejects(artifacts.submitResult(f.request, { outcome: 'delivered' }), /not frozen before/);
});

test('other session, terminal and tampered prompt do not establish native completion', async () => {
  const f = await fixture();
  await assert.rejects(cbc.capture(f.task, { ...f.raw, session_id: 'wrong-native' }, {}), /binding changed/);
  await assert.rejects(cbc.capture({ ...f.task, terminalId: 'wrong-terminal' }, f.raw, {}), /binding changed/);
  assert.equal(p.inspect(f.request).execution, 'running');
});

test('native admission and Stop replay are idempotent, polling never needs Herdr', async () => {
  const f = await fixture(); await finish(f); const count = p.inspect(f.request).eventCount;
  await cbc.capture(f.task, f.raw, require('../lib/cbc-turn').captureSubmission(f.raw, f.task));
  await cbc.capture(f.task, { ...f.raw, hook_event_name: 'Stop' }, {});
  assert.equal(p.inspect(f.request).eventCount, count);
  const clone = { ...f.task, paneId: 'closed-pane' };
  assert.equal(cbc.readTurn(clone).state, 'stopped');
});

test('worker result command and versioned CLI are real local command entrypoints', async () => {
  const f = await fixture(); fs.writeFileSync(f.task.deliveryPath, 'CLI report'); fs.writeFileSync(path.join(f.task.cwd, 'output.txt'), 'CLI artifact');
  const receipt = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/bridge-result.js'), '--request-file', f.task.layeredRequestFile, '--outcome', 'delivered'], { encoding: 'utf8', env: process.env });
  assert.equal(receipt.status, 0, receipt.stderr); assert.equal(JSON.parse(receipt.stdout).resultRecorded, true);
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/agent-bridge-v2.js'), 'status', f.task.id], { encoding: 'utf8', env: process.env });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).taskProtocol, 2);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
