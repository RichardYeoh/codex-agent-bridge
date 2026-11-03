'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspect, inspectText } = require('../../tools/check-publication.cjs');

test('publication checks untracked candidates while preserving ignored private files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-publication-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'public example');
  git(['add', '.gitignore', 'tracked.txt']);
  // Synthetic strings have no authority and are confined to the temporary repository. / 合成字符串不具权限，仅写入临时仓库。
  const sentinel = 'sk-' + 'x'.repeat(30);
  fs.mkdirSync(path.join(root, '.local'));
  fs.writeFileSync(path.join(root, '.local', 'private.txt'), sentinel);
  fs.writeFileSync(path.join(root, 'new.txt'), sentinel);
  const pending = inspect({ cwd: root });
  assert.equal(pending.files, 3);
  assert.deepEqual(pending.problems, ['new.txt: possible secret']);
  assert.deepEqual(inspect({ cwd: root, staged: true }).problems, []);
  git(['add', 'new.txt']);
  fs.writeFileSync(path.join(root, 'new.txt'), 'working tree has been cleaned');
  assert.deepEqual(inspect({ cwd: root }).problems, []);
  assert.deepEqual(inspect({ cwd: root, staged: true }).problems, ['new.txt: possible secret']);
  git(['add', '-f', '.local/private.txt']);
  assert.ok(inspect({ cwd: root, staged: true }).problems.includes('.local/private.txt: private/generated directory'));
});

test('publication findings redact values and distinguish placeholders from native identities', () => {
  const identity = 'session_' + 'a'.repeat(32), token = 'github_pat_' + 'b'.repeat(35);
  const findings = inspectText('example.txt', identity + ' ' + token);
  assert.equal(findings.length, 2);
  assert.ok(findings.every(value => !value.includes(identity) && !value.includes(token)));
  assert.deepEqual(inspectText('example.txt', 'session-example <session-id> ${LOCALAPPDATA}'), []);
  const userPath = ['C:', 'Users', 'ExampleUser', 'settings.json'].join('\\');
  assert.deepEqual(inspectText('example.txt', userPath), ['example.txt: account-specific absolute path']);
});
