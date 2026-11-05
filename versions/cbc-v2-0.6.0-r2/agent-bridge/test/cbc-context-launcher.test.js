'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install, check, remove } = require('../../tools/configure-cbc-context.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-context-launcher-'));
let count = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dir = path.join(root, 'case ' + ++count), prefix = path.join(dir, 'npm'), stateDir = path.join(dir, 'private');
  fs.mkdirSync(prefix, { recursive: true });
  const preset = path.join(dir, 'preset 1m.json'); fs.writeFileSync(preset, '{"contextWindow":1000000}');
  const originals = {
    'cbc.ps1': '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& node "$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" $args\r\nexit $LASTEXITCODE\r\n',
    'cbc.cmd': '@ECHO off\r\nSET "dp0=%~dp0"\r\nnode "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n',
    cbc: '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" "$@"\n',
  };
  for (const [name, text] of Object.entries(originals)) fs.writeFileSync(path.join(prefix, name), text);
  fs.writeFileSync(path.join(prefix, 'codebuddy.cmd'), 'unrelated alias');
  const native = path.join(prefix, 'node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(Number(process.env.CBC_TEST_EXIT||0))');
  return { prefix, preset, stateDir, originals };
}

test('all CBC entries gain a default preset, remain idempotent and leave the native alias untouched', () => {
  const f = fixture(); assert.equal(check(f).installed, false);
  assert.equal(install(f).installed, true); assert.equal(install(f).installed, true);
  for (const name of Object.keys(f.originals)) {
    assert.equal(fs.readFileSync(path.join(f.prefix, name), 'utf8').split('--settings ').length - 1, 1);
  }
  assert.equal(fs.readFileSync(path.join(f.prefix, 'codebuddy.cmd'), 'utf8'), 'unrelated alias');
});

test('remove restores exact bytes and keeps recovery backups', () => {
  const f = fixture(); install(f); const manifest = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'manifest.json')));
  assert.equal(remove(f).removed, true); assert.equal(check(f).installed, false);
  for (const [name, text] of Object.entries(f.originals)) assert.equal(fs.readFileSync(path.join(f.prefix, name), 'utf8'), text);
  assert.ok(manifest.entries.every(entry => fs.existsSync(entry.backup)));
});

test('unknown entries and conflicting overrides are rejected before changing any file', () => {
  for (const text of ['custom entry', 'node native --settings other.json']) {
    const f = fixture(); fs.writeFileSync(path.join(f.prefix, 'cbc.cmd'), text);
    assert.throws(() => install(f), /Unrecognized|reviewed/);
    assert.equal(fs.readFileSync(path.join(f.prefix, 'cbc.ps1'), 'utf8'), f.originals['cbc.ps1']);
  }
});

test('restore refuses a user edit without overwriting the other entries', () => {
  const f = fixture(); install(f); const ps = fs.readFileSync(path.join(f.prefix, 'cbc.ps1'));
  fs.appendFileSync(path.join(f.prefix, 'cbc.cmd'), 'user change');
  assert.throws(() => remove(f), /refusing/);
  assert.deepEqual(fs.readFileSync(path.join(f.prefix, 'cbc.ps1')), ps);
});

test('npm-regenerated original entries can be reapplied with fresh recovery backups', () => {
  const f = fixture(); install(f);
  for (const [name, text] of Object.entries(f.originals)) fs.writeFileSync(path.join(f.prefix, name), text);
  assert.equal(check(f).installed, false); assert.equal(install(f).installed, true); assert.equal(remove(f).removed, true);
});

for (const shell of process.platform === 'win32'
  ? [path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh.exe'] : []) {
  for (const entry of ['cbc.ps1', 'cbc.cmd']) test('entry preserves caller args, cwd and child exit code: ' + path.basename(path.dirname(shell)) + '/' + entry, () => {
    const f = fixture(); install(f);
    const script = path.join(f.prefix, 'invoke.ps1');
    fs.writeFileSync(script, "& '" + path.join(f.prefix, entry).replace(/'/g, "''") + "' --resume 'saved-session' --add-dir 'path with spaces'\nexit $LASTEXITCODE\n");
    const invoke = exit => spawnSync(shell, ['-NoProfile', '-File', script], {
      cwd: f.prefix, env: { ...process.env, CBC_TEST_EXIT: String(exit) }, encoding: 'utf8', windowsHide: true,
    });
    const result = invoke(0); assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.args, ['--settings', f.preset.replace(/\\/g, '/'), '--resume', 'saved-session', '--add-dir', 'path with spaces']);
    assert.equal(payload.cwd.toLowerCase(), f.prefix.toLowerCase());
    assert.equal(invoke(7).status, 7);
  });
}
