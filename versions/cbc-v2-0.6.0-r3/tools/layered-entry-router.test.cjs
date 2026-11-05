'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROUTER_SOURCE = path.join(__dirname, 'layered-entry-router.cjs');

function makeFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-entry-router-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const projectRoot = path.join(tempRoot, 'project');
  const bridgeRoot = path.join(projectRoot, 'agent-bridge');
  const bin = path.join(bridgeRoot, 'bin');
  const lib = path.join(bridgeRoot, 'lib');
  const releases = path.join(projectRoot, 'releases');
  const stateDir = path.join(tempRoot, 'state');
  const logFile = path.join(tempRoot, 'router-calls.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(releases, { recursive: true });

  const router = path.join(bin, 'agent-bridge.js');
  const legacy = path.join(bin, 'agent-bridge-v1.js');
  const configFile = path.join(bin, 'layered-release.json');
  fs.copyFileSync(ROUTER_SOURCE, router);
  fs.writeFileSync(legacy, `
'use strict';
const fs = require('node:fs');
function record() {
  fs.appendFileSync(process.env.ROUTER_CALL_LOG, JSON.stringify({
    entry: 'v1', args: process.argv.slice(2), releaseId: process.env.AGENT_BRIDGE_RELEASE_ID || null,
  }) + '\\n');
}
if (require.main === module) { record(); process.exitCode = Number(process.env.ROUTER_V1_EXIT || '0'); }
module.exports = { identity: 'legacy-v1', record };
`, 'utf8');
  fs.writeFileSync(path.join(lib, 'agents.js'), `
'use strict';
const ids = { cbc: 'cbc', codebuddy: 'cbc', oc: 'opencode', opencode: 'opencode', zcode: 'zcode' };
exports.getAgent = name => {
  if (!Object.hasOwn(ids, name)) throw new Error('Unsupported agent: ' + name);
  return { id: ids[name] };
};
`, 'utf8');

  const releaseEntries = {};
  for (const releaseId of ['r1', 'r2']) {
    const releaseDir = path.join(releases, releaseId);
    fs.mkdirSync(releaseDir, { recursive: true });
    const entry = path.join(releaseDir, 'agent-bridge-v2.cjs');
    fs.writeFileSync(entry, `
'use strict';
const fs = require('node:fs');
fs.appendFileSync(process.env.ROUTER_CALL_LOG, JSON.stringify({
  entry: 'v2', release: require('node:path').basename(__dirname),
  args: process.argv.slice(2), releaseId: process.env.AGENT_BRIDGE_RELEASE_ID || null,
}) + '\\n');
process.exitCode = Number(process.env.ROUTER_V2_EXIT || '0');
`, 'utf8');
    releaseEntries[releaseId] = path.relative(projectRoot, entry).split(path.sep).join('/');
  }

  return {
    tempRoot, projectRoot, router, legacy, configFile, releaseEntries, stateDir, logFile,
    env: {
      AGENT_BRIDGE_STATE_DIR: stateDir,
      LOCALAPPDATA: path.join(tempRoot, 'local-app-data'),
      ROUTER_CALL_LOG: logFile,
      ROUTER_V1_EXIT: '0',
      ROUTER_V2_EXIT: '0',
    },
  };
}

function writeConfig(fixture, { enabledCBC = true, currentRelease = 'r1', releases = fixture.releaseEntries } = {}) {
  fs.writeFileSync(fixture.configFile, JSON.stringify({ enabledCBC, currentRelease, releases }, null, 2), 'utf8');
}

function writeTask(fixture, id, task) {
  const dir = path.join(fixture.stateDir, 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, ...task }), 'utf8');
}

function clearCalls(fixture) {
  fs.writeFileSync(fixture.logFile, '', 'utf8');
}

function calls(fixture) {
  if (!fs.existsSync(fixture.logFile)) return [];
  return fs.readFileSync(fixture.logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function run(fixture, args, extraEnv = {}, nodeExecArgv = []) {
  return spawnSync(process.execPath, [...nodeExecArgv, fixture.router, ...args], {
    env: { ...process.env, ...fixture.env, ...extraEnv },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
}

test('require keeps the exact legacy module export', t => {
  const fixture = makeFixture(t);
  const loadedRouter = require(fixture.router);
  const loadedLegacy = require(fixture.legacy);
  assert.equal(loadedRouter, loadedLegacy);
  assert.equal(loadedRouter.identity, 'legacy-v1');
});

test('Node preload options reach the final CLI process while inspector flags are not duplicated', t => {
  const fixture = makeFixture(t);
  const preload = path.join(fixture.tempRoot, 'fixture-preload.cjs');
  const importPreload = path.join(fixture.tempRoot, 'fixture-import-preload.mjs');
  const importSpecifier = pathToFileURL(importPreload).href;
  const marker = path.join(fixture.tempRoot, 'require-preload-runs.jsonl');
  const importMarker = path.join(fixture.tempRoot, 'import-preload-runs.jsonl');
  fs.writeFileSync(preload, `
'use strict';
require('node:fs').appendFileSync(process.env.ROUTER_PRELOAD_MARKER, JSON.stringify({
  pid: process.pid, script: process.argv[1], execArgv: process.execArgv,
}) + '\\n');
`, 'utf8');
  fs.writeFileSync(importPreload, `
import fs from 'node:fs';
fs.appendFileSync(process.env.ROUTER_IMPORT_MARKER, JSON.stringify({
  pid: process.pid, script: process.argv[1], execArgv: process.execArgv,
}) + '\\n');
`, 'utf8');
  const nodeExecArgv = ['--require', preload, '--import', importSpecifier, '--inspect=127.0.0.1:0'];
  const extraEnv = { NODE_OPTIONS: '', ROUTER_PRELOAD_MARKER: marker, ROUTER_IMPORT_MARKER: importMarker };
  const readRecords = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

  writeConfig(fixture, { enabledCBC: false });
  const legacyRun = run(fixture, ['status', 'legacy-missing'], extraEnv, nodeExecArgv);
  assert.equal(legacyRun.status, 0, legacyRun.stderr || legacyRun.stdout);
  let records = readRecords(marker);
  let importRecords = readRecords(importMarker);
  assert.equal(records.length, 2, 'preload must execute once in router and once in final legacy CLI');
  assert.equal(importRecords.length, 2, 'import preload must execute in router and final legacy CLI');
  assert.equal(path.resolve(records[0].script), fixture.router);
  assert.equal(path.resolve(records[1].script), fixture.legacy);
  assert.ok(records.every(record => record.execArgv.includes('--require') && record.execArgv.includes(preload)));
  assert.ok(records.every(record => record.execArgv.includes('--import') && record.execArgv.includes(importSpecifier)));
  assert.ok(records[0].execArgv.some(argument => argument.startsWith('--inspect')));
  assert.ok(!records[1].execArgv.some(argument => argument.startsWith('--inspect')),
    'child inspector flags are filtered to avoid a duplicate listener');
  assert.deepEqual(importRecords.map(record => path.resolve(record.script)), [fixture.router, fixture.legacy]);

  fs.writeFileSync(marker, '', 'utf8');
  fs.writeFileSync(importMarker, '', 'utf8');
  writeConfig(fixture, { enabledCBC: true, currentRelease: 'r1' });
  const versionedEntry = path.join(fixture.projectRoot, fixture.releaseEntries.r1);
  const runtimeRun = run(fixture, ['dispatch', '--prompt', 'preload fixture'], extraEnv, nodeExecArgv);
  assert.equal(runtimeRun.status, 0, runtimeRun.stderr || runtimeRun.stdout);
  records = readRecords(marker);
  importRecords = readRecords(importMarker);
  assert.equal(records.length, 2, 'preload must execute in the routed runtime process too');
  assert.equal(importRecords.length, 2, 'import preload must execute in the routed runtime process too');
  assert.equal(path.resolve(records[0].script), fixture.router);
  assert.equal(path.resolve(records[1].script), versionedEntry);
  assert.ok(records[1].execArgv.includes('--require') && records[1].execArgv.includes(preload));
  assert.ok(records[1].execArgv.includes('--import') && records[1].execArgv.includes(importSpecifier));
  assert.ok(!records[1].execArgv.some(argument => argument.startsWith('--inspect')));
  assert.deepEqual(importRecords.map(record => path.resolve(record.script)), [fixture.router, versionedEntry]);
});

test('CBC default and resolver aliases route to the enabled pinned runtime and preserve exit status and argv', t => {
  const fixture = makeFixture(t);
  writeConfig(fixture, { enabledCBC: true, currentRelease: 'r2' });

  const defaultRun = run(fixture, ['dispatch', '--prompt', 'synthetic task'], { ROUTER_V2_EXIT: '23' });
  assert.equal(defaultRun.status, 23, defaultRun.stderr || defaultRun.stdout);
  assert.deepEqual(calls(fixture), [{
    entry: 'v2', release: 'r2', args: ['dispatch', '--prompt', 'synthetic task'], releaseId: 'r2',
  }]);

  clearCalls(fixture);
  const aliasRun = run(fixture, ['dispatch', '--agent', 'codebuddy', '--prompt', 'synthetic alias']);
  assert.equal(aliasRun.status, 0, aliasRun.stderr || aliasRun.stdout);
  assert.deepEqual(calls(fixture), [{
    entry: 'v2', release: 'r2', args: ['dispatch', '--agent', 'codebuddy', '--prompt', 'synthetic alias'], releaseId: 'r2',
  }]);
});

test('disabled rollout, non-CBC dispatch, existing v1 task, and missing config use the legacy entry', t => {
  const fixture = makeFixture(t);
  writeConfig(fixture, { enabledCBC: false });

  assert.equal(run(fixture, ['dispatch', '--prompt', 'legacy default']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v1');
  assert.equal(run(fixture, ['dispatch', '--agent', 'oc', '--prompt', 'non-CBC']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v1');

  writeTask(fixture, 'legacy-task', { agent: 'cbc', taskProtocol: 1 });
  writeConfig(fixture, { enabledCBC: true, currentRelease: 'r2' });
  assert.equal(run(fixture, ['status', 'legacy-task']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v1');

  clearCalls(fixture);
  fs.unlinkSync(fixture.configFile);
  assert.equal(run(fixture, ['dispatch', '--prompt', 'no release config']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v1');
});

test('existing V2 tasks stay on their recorded release across upgrades and rollback', t => {
  const fixture = makeFixture(t);
  writeTask(fixture, 'pinned-task', { agent: 'cbc', taskProtocol: 2, runtimeReleaseId: 'r1' });
  writeTask(fixture, 'unpinned-task', { agent: 'cbc', taskProtocol: 2 });
  writeConfig(fixture, { enabledCBC: true, currentRelease: 'r2' });

  assert.equal(run(fixture, ['status', 'pinned-task']).status, 0);
  assert.equal(calls(fixture).at(-1).release, 'r1');
  assert.equal(calls(fixture).at(-1).releaseId, 'r1');
  assert.equal(run(fixture, ['status', 'unpinned-task']).status, 0);
  assert.equal(calls(fixture).at(-1).release, 'r2', 'early V2 tasks without a pin use currentRelease');

  assert.equal(run(fixture, ['dispatch', '--prompt', 'new task']).status, 0);
  assert.equal(calls(fixture).at(-1).release, 'r2');

  writeTask(fixture, 'rolled-back-task', { agent: 'cbc', taskProtocol: 2, runtimeReleaseId: 'r2' });
  writeConfig(fixture, { enabledCBC: false, currentRelease: 'r1' });
  assert.equal(run(fixture, ['status', 'pinned-task']).status, 0);
  assert.equal(calls(fixture).at(-1).release, 'r1', 'rollback must not move an existing task');
  assert.equal(run(fixture, ['status', 'rolled-back-task']).status, 0);
  assert.equal(calls(fixture).at(-1).release, 'r2', 'rollback must keep a task pinned to the later release');
  assert.equal(run(fixture, ['dispatch', '--prompt', 'after rollback']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v1', 'rollback disables only new V2 enrollment');
});

test('protocol-2 task fails closed when routing config or its recorded release is unavailable', t => {
  const fixture = makeFixture(t);
  writeTask(fixture, 'v2-task', { agent: 'cbc', taskProtocol: 2, runtimeReleaseId: 'r1' });

  for (const configState of ['missing', 'invalid-json', 'missing-release']) {
    clearCalls(fixture);
    if (configState === 'missing') fs.rmSync(fixture.configFile, { force: true });
    else if (configState === 'invalid-json') fs.writeFileSync(fixture.configFile, '{bad json', 'utf8');
    else writeConfig(fixture, { enabledCBC: false, currentRelease: 'r2', releases: { r2: fixture.releaseEntries.r2 } });

    const result = run(fixture, ['status', 'v2-task']);
    assert.notEqual(result.status, 0, configState);
    assert.match(result.stderr, /refusing legacy fallback/i, configState);
    assert.deepEqual(calls(fixture), [], configState);
  }
});

test('global reads stay on v1 while a single V2 task command uses its versioned runtime', t => {
  const fixture = makeFixture(t);
  writeConfig(fixture, { enabledCBC: true, currentRelease: 'r2' });
  writeTask(fixture, 'v2-task', { agent: 'cbc', taskProtocol: 2, runtimeReleaseId: 'r1' });

  for (const args of [['list'], ['sessions'], ['notifications', 'status'], ['status']]) {
    assert.equal(run(fixture, args).status, 0, args.join(' '));
    assert.equal(calls(fixture).at(-1).entry, 'v1', args.join(' '));
  }
  assert.equal(run(fixture, ['status', 'v2-task']).status, 0);
  assert.equal(calls(fixture).at(-1).entry, 'v2');
  assert.equal(calls(fixture).at(-1).release, 'r1');
});

test('recover without a task ID refuses to scan a mixed-version state tree', t => {
  const fixture = makeFixture(t);
  writeTask(fixture, 'legacy-task', { agent: 'opencode', taskProtocol: 1 });
  writeTask(fixture, 'v2-task', { agent: 'cbc', taskProtocol: 2, runtimeReleaseId: 'r1' });
  writeConfig(fixture, { enabledCBC: false, currentRelease: 'r2' });

  const scan = run(fixture, ['recover']);
  assert.notEqual(scan.status, 0);
  assert.match(scan.stderr, /recover requires a task ID.*mixed-version scan/i);
  assert.deepEqual(calls(fixture), []);

  const targeted = run(fixture, ['recover', 'v2-task']);
  assert.equal(targeted.status, 0, targeted.stderr);
  assert.equal(calls(fixture).at(-1).entry, 'v2');
  assert.equal(calls(fixture).at(-1).release, 'r1');
});

test('release entry traversal and symlink escape are rejected before child execution', t => {
  const fixture = makeFixture(t);
  const outside = path.join(fixture.tempRoot, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'runtime.cjs'), "process.exitCode = 0;\n", 'utf8');
  writeConfig(fixture, {
    enabledCBC: true, currentRelease: 'escape',
    releases: { escape: '../outside/runtime.cjs' },
  });
  const escaped = run(fixture, ['dispatch', '--prompt', 'synthetic']);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /escapes the engineering project/i);
  assert.deepEqual(calls(fixture), []);

  const linked = path.join(fixture.projectRoot, 'releases', 'linked');
  try {
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Host does not permit symlink fixtures: ${error.code}`);
      return;
    }
    throw error;
  }
  writeConfig(fixture, {
    enabledCBC: true, currentRelease: 'linked',
    releases: { linked: 'releases/linked/runtime.cjs' },
  });
  const symlinked = run(fixture, ['dispatch', '--prompt', 'synthetic']);
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /symbolic link or reparse point/i);
  assert.deepEqual(calls(fixture), []);
});

test('malformed CBC rollout config blocks CBC enrollment but leaves addressed V1 tasks on legacy', t => {
  const fixture = makeFixture(t);
  writeTask(fixture, 'legacy-task', { agent: 'cbc', taskProtocol: 1 });
  fs.writeFileSync(fixture.configFile, JSON.stringify({ enabledCBC: 'yes', currentRelease: '../outside', releases: {} }), 'utf8');

  const legacyTask = run(fixture, ['status', 'legacy-task']);
  assert.equal(legacyTask.status, 0, legacyTask.stderr);
  assert.equal(calls(fixture).at(-1).entry, 'v1');

  clearCalls(fixture);
  const newTask = run(fixture, ['dispatch', '--prompt', 'synthetic']);
  assert.notEqual(newTask.status, 0);
  assert.match(newTask.stderr, /CBC release configuration is invalid/i);
  assert.deepEqual(calls(fixture), []);
});
