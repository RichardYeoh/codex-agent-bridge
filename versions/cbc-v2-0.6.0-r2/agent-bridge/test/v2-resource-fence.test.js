'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSingleActive } = require('../lib/worker-scheduling');
const { canonicalPath } = require('../lib/path-identity');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-v2-resource-fence-'));
// Keep all task roots, scopes, and aliases inside this test-owned directory. / 所有任务目录、写范围和别名均限制在本测试创建的临时目录内。
const project = path.join(root, 'project-a');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });

function task(id, overrides = {}) {
  return {
    id,
    workerKey: `worker-${id}`,
    cwd: project,
    agent: 'cbc',
    herdrSession: `herdr-${id}`,
    paneId: `pane-${id}`,
    terminalId: `terminal-${id}`,
    workerSessionId: `native-${id}`,
    status: 'running',
    allowedWritePaths: ['src/output.js'],
    ...overrides,
  };
}

function blockedByFence(candidate, prior, reason) {
  assert.throws(() => assertSingleActive(candidate, [prior]), reason);
}

test('V2 cancelled tasks with possible continuing execution fence the same native session', () => {
  const cancelled = task('cancelled-native', {
    taskProtocol: 2,
    status: 'cancelled',
    workerSessionId: 'native-shared',
    layers: { execution: 'unknown', conflicts: [], reviewIntegrity: 'consistent' },
    cancellation: { status: 'confirmed', originalExecutionMayContinue: true },
  });
  const candidate = task('next-native', { workerSessionId: 'native-shared' });
  blockedByFence(candidate, cancelled, /Worker resource conflict.*native session/i);
});

test('V2 cancelled uncertainty fences overlapping write scopes even with a different native session', () => {
  const cancelled = task('cancelled-scope', {
    taskProtocol: 2,
    status: 'cancelled',
    workerSessionId: 'native-old',
    parallel: true,
    allowedWritePaths: ['src/output.js'],
    originalExecutionMayContinue: true,
    layers: { execution: 'unknown', conflicts: [], reviewIntegrity: 'consistent' },
  });
  const candidate = task('next-scope', {
    workerSessionId: 'native-new',
    parallel: true,
    allowedWritePaths: ['src/output.js'],
  });
  blockedByFence(candidate, cancelled, /Worker resource conflict.*write scope/i);
});

test('V2 accepted tasks with conflicted layer evidence fence native reuse and overlapping writes', () => {
  const accepted = task('accepted-conflict', {
    taskProtocol: 2,
    status: 'accepted',
    layers: {
      execution: 'ended',
      review: 'accepted',
      reviewIntegrity: 'contested',
      conflicts: ['foreign-input-during-request'],
    },
  });

  const sameNative = task('accepted-native-next', { workerSessionId: accepted.workerSessionId });
  blockedByFence(sameNative, accepted, /Worker resource conflict.*native session/i);

  const sameScope = task('accepted-scope-next', {
    parallel: true,
    workerSessionId: 'different-native',
    allowedWritePaths: ['src/output.js'],
  });
  const parallelAccepted = { ...accepted, parallel: true };
  blockedByFence(sameScope, parallelAccepted, /Worker resource conflict.*write scope/i);
});

test('V2 fences remain project-scoped for an independent project and native session', () => {
  const uncertain = task('other-project-cancelled', {
    taskProtocol: 2,
    status: 'cancelled',
    cwd: path.join(root, 'project-b'),
    workerSessionId: 'native-project-b',
    originalExecutionMayContinue: true,
    layers: { execution: 'unknown', conflicts: [], reviewIntegrity: 'consistent' },
  });
  const candidate = task('project-a-next', {
    workerSessionId: 'native-project-a',
    allowedWritePaths: ['src/independent.js'],
  });
  fs.mkdirSync(uncertain.cwd, { recursive: true });
  assert.doesNotThrow(() => assertSingleActive(candidate, [uncertain]));
});

test('canonicalPath resolves existing junction or symlink aliases and paths not yet created', async t => {
  const realProject = path.join(root, 'real-project');
  const aliasProject = path.join(root, 'project-alias');
  fs.mkdirSync(realProject, { recursive: true });
  const existingFile = path.join(realProject, 'existing.txt');
  fs.writeFileSync(existingFile, 'synthetic fixture');

  try {
    fs.symlinkSync(realProject, aliasProject, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32') {
      t.skip(`Windows junction creation unavailable (${error.code || error.name}): ${error.message}`);
      return;
    }
    throw error;
  }

  const aliasedExistingFile = path.join(aliasProject, 'existing.txt');
  assert.equal(canonicalPath(existingFile), canonicalPath(aliasedExistingFile));

  const notYetCreated = path.join(realProject, 'future', 'nested', 'output.bin');
  const aliasedNotYetCreated = path.join(aliasProject, 'future', 'nested', 'output.bin');
  assert.equal(fs.existsSync(notYetCreated), false);
  assert.equal(fs.existsSync(aliasedNotYetCreated), false);
  assert.equal(canonicalPath(notYetCreated), canonicalPath(aliasedNotYetCreated));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
