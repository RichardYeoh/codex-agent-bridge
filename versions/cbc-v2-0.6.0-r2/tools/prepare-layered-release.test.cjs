'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const TOOL = path.join(__dirname, 'prepare-layered-release.cjs');
const ALLOWED_DIRS = [
  'agent-bridge/bin', 'agent-bridge/lib', 'agent-bridge/hooks', 'agent-bridge/examples',
  'agent-bridge/scripts', 'agent-bridge/skills', 'agent-bridge/test', 'agent-bridge/vendor', 'docs/layered-v2',
];

// Build a disposable project tree that exercises the same allowlist as the CLI. / 构造与 CLI 白名单一致的一次性工程目录。
function makeFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-release-fixture-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot);
  const source = path.join(projectRoot, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(source, 'tools'));
  for (const file of ['layered-entry-router.cjs', 'layered-entry-router.test.cjs']) fs.writeFileSync(path.join(source, 'tools', file), 'module.exports = {};\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture-root","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.mkdirSync(path.join(source, 'agent-bridge'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'package.json'), '{"name":"fixture-agent-bridge","version":"2.0.0"}\n');
  for (const relative of ALLOWED_DIRS) {
    const directory = path.join(source, ...relative.split('/'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${path.basename(relative)}.js`), `module.exports = ${JSON.stringify(relative)};\n`);
    fs.writeFileSync(path.join(directory, 'notes.md'), `# ${relative}\n`);
  }
  fs.mkdirSync(path.join(source, 'agent-bridge', 'vendor', 'zcode'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'vendor', 'zcode', 'remote-sdk.cjs'), 'exports.request = () => "fixture";\n');
  fs.writeFileSync(path.join(source, 'agent-bridge', 'vendor', 'zcode', 'sources.json'), '{"source":"fixture"}\n');
  fs.writeFileSync(path.join(source, 'agent-bridge', 'vendor', 'zcode', 'README.md'), '# Vendor fixture\n');
  fs.writeFileSync(path.join(source, 'agent-bridge', 'vendor', 'zcode', 'LICENSE-zod'), Buffer.from('Zod license fixture\n', 'utf8'));
  fs.writeFileSync(path.join(source, 'agent-bridge', 'vendor', 'zcode', 'LICENSE-ZCode'), Buffer.from('ZCode license fixture\n', 'utf8'));
  fs.writeFileSync(path.join(source, 'agent-bridge', 'test', 'lib.test.cjs'), "require('node:test');\n");
  fs.writeFileSync(path.join(source, 'agent-bridge', 'test', 'fixture.txt'), 'source fixture\n');
  fs.mkdirSync(path.join(source, 'agent-bridge', 'lib', 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'lib', 'node_modules', 'ignored', 'package.json'), '{}\n');
  fs.mkdirSync(path.join(source, 'agent-bridge', 'scripts', '.local'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'scripts', '.local', 'private.json'), '{}\n');
  fs.mkdirSync(path.join(source, 'agent-bridge', 'bin', 'backups'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'bin', 'backups', 'old.js'), 'ignored\n');
  fs.writeFileSync(path.join(source, 'agent-bridge', 'lib', 'runtime.exe'), 'binary fixture\n');
  fs.writeFileSync(path.join(source, 'agent-bridge', 'lib', 'unlisted.txt'), 'text fixture\n');
  fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
  for (const name of [
    'run-e2e.cjs', 'prepare-layered-release.cjs', 'prepare-layered-release.test.cjs',
    'configure-cbc-context.cjs', 'check-publication.cjs', 'ydot-tunnel-runtime.cjs',
    'layered-entry-router.cjs', 'layered-entry-router.test.cjs',
  ]) {
    fs.writeFileSync(path.join(source, 'tools', name), `// ${name}\n`);
  }
  fs.writeFileSync(path.join(source, 'tools', 'start-ydot-tunnel.ps1'), '# PowerShell fixture\n');
  fs.writeFileSync(path.join(source, 'tools', 'release-helper.py'), 'print("fixture")\n');
  fs.writeFileSync(path.join(source, 'tools', 'release-config.yaml'), 'enabled: true\n');
  fs.writeFileSync(path.join(source, 'tools', 'release-notes.txt'), 'fixture source text\n');
  const e2e = path.join(source, 'evidence', '2026-10-27', 'e2e');
  fs.mkdirSync(path.join(e2e, 'src'), { recursive: true });
  fs.writeFileSync(path.join(e2e, 'acceptance.test.cjs'), "require('./src/port.cjs');\n");
  fs.writeFileSync(path.join(e2e, 'layout-acceptance.test.cjs'), "require('node:fs');\n");
  fs.writeFileSync(path.join(e2e, 'src', 'port.cjs'), 'exports.parsePort = value => Number(value);\n');
  fs.writeFileSync(path.join(e2e, 'layout-proof.txt'), 'cbc|workspace-reuse|resumed\n');
  fs.writeFileSync(path.join(e2e, 'round1.md'), 'historical log excluded\n');
  fs.mkdirSync(path.join(source, 'agent-bridge', 'test', 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent-bridge', 'test', 'test-results', 'summary.json'), '{}\n');
  return { tempRoot, projectRoot, source, output: path.join(projectRoot, 'releases', 'layered-v2-test') };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
}

function runTool(fixture, args) {
  return spawnSync(process.execPath, [TOOL, ...args, '--project-root', fixture.projectRoot], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

function parseStdout(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('default mode previews a whitelist snapshot without writing output', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));

  const preview = parseStdout(runTool(fixture, ['--source', fixture.source, '--output', fixture.output]));
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.output, 'releases/layered-v2-test');
  assert.equal(fs.existsSync(fixture.output), false);
  assert.ok(preview.files.some(file => file.path === 'package.json'));
  assert.ok(preview.files.some(file => file.path === 'package-lock.json'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/package.json'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/test/lib.test.cjs'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/test/fixture.txt'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/vendor/zcode/remote-sdk.cjs'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/vendor/zcode/LICENSE-zod'));
  assert.ok(preview.files.some(file => file.path === 'agent-bridge/vendor/zcode/LICENSE-ZCode'));
  for (const relative of [
    'tools/run-e2e.cjs', 'tools/configure-cbc-context.cjs', 'tools/check-publication.cjs',
    'tools/ydot-tunnel-runtime.cjs', 'tools/start-ydot-tunnel.ps1', 'tools/release-helper.py',
    'tools/release-config.yaml', 'tools/release-notes.txt',
  ]) assert.ok(preview.files.some(file => file.path === relative), `missing ${relative}`);
  assert.ok(preview.files.some(file => file.path === 'evidence/2026-10-27/e2e/src/port.cjs'));
  assert.ok(preview.files.some(file => file.path === 'evidence/2026-10-27/e2e/layout-proof.txt'));
  assert.ok(!preview.files.some(file => file.path === 'evidence/2026-10-27/e2e/round1.md'));
  assert.ok(!preview.files.some(file => file.path.includes('test-results')));
  assert.ok(preview.files.some(file => file.path === 'docs/layered-v2/layered-v2.js'));
  assert.ok(preview.files.every(file => !/node_modules|\.local|backups|runtime\.exe|unlisted\.txt/.test(file.path)));
  assert.equal(new Set(preview.files.map(file => file.path)).size, preview.files.length);
  assert.equal(preview.aggregateSha256.length, 64);
});

test('--apply creates a version directory and --verify confirms its manifest', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));

  const applied = parseStdout(runTool(fixture, ['--source', fixture.source, '--output', fixture.output, '--apply']));
  assert.equal(applied.mode, 'apply');
  assert.equal(fs.existsSync(path.join(fixture.output, 'agent-bridge', 'lib', 'lib.js')), true);
  assert.equal(fs.existsSync(path.join(fixture.output, 'agent-bridge', 'lib', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(fixture.output, 'agent-bridge', 'scripts', '.local')), false);
  assert.equal(fs.existsSync(path.join(fixture.output, 'agent-bridge', 'vendor', 'zcode', 'remote-sdk.cjs')), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.output, 'release-manifest.json'), 'utf8'));
  for (const licenseName of ['LICENSE-zod', 'LICENSE-ZCode']) {
    const relative = `agent-bridge/vendor/zcode/${licenseName}`;
    const sourceBytes = fs.readFileSync(path.join(fixture.source, ...relative.split('/')));
    const outputBytes = fs.readFileSync(path.join(fixture.output, ...relative.split('/')));
    const entry = manifest.files.find(file => file.path === relative);
    assert.deepEqual(outputBytes, sourceBytes);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(sourceBytes).digest('hex'));
  }
  assert.equal(fs.existsSync(path.join(fixture.output, 'tools', 'configure-cbc-context.cjs')), true);
  assert.equal(fs.existsSync(path.join(fixture.output, 'tools', 'check-publication.cjs')), true);
  assert.equal(fs.existsSync(path.join(fixture.output, 'tools', 'ydot-tunnel-runtime.cjs')), true);
  assert.equal(manifest.fileCount, applied.fileCount);
  const verified = parseStdout(runTool(fixture, ['--verify', fixture.output]));
  assert.deepEqual(verified, {
    mode: 'verify', fileCount: applied.fileCount, aggregateSha256: applied.aggregateSha256,
  });
});

test('preparation fails when the required vendored SDK source is absent', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  fs.unlinkSync(path.join(fixture.source, 'agent-bridge', 'vendor', 'zcode', 'remote-sdk.cjs'));

  const result = runTool(fixture, ['--source', fixture.source, '--output', fixture.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required release source is missing or excluded: agent-bridge\/vendor\/zcode\/remote-sdk\.cjs/);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('binary payloads are rejected even when their filename has an allowed source extension', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  fs.writeFileSync(path.join(fixture.source, 'tools', 'looks-like-source.cjs'), Buffer.from([0, 1, 2]));

  const result = runTool(fixture, ['--source', fixture.source, '--output', fixture.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Binary or non-UTF-8 file is not allowed/);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('existing output is rejected without replacing its contents', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  fs.mkdirSync(fixture.output, { recursive: true });
  const sentinel = path.join(fixture.output, 'keep.txt');
  fs.writeFileSync(sentinel, 'preserve\n');

  const result = runTool(fixture, ['--source', fixture.source, '--output', fixture.output, '--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists|overwrite/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve\n');
});

test('source and destination must remain inside the selected project root', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const outside = path.join(fixture.tempRoot, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'package.json'), '{}\n');

  const sourceResult = runTool(fixture, ['--source', outside, '--output', fixture.output]);
  assert.notEqual(sourceResult.status, 0);
  assert.match(sourceResult.stderr, /outside the maintenance project/i);
  const outputResult = runTool(fixture, ['--source', fixture.source, '--output', path.join(outside, 'release'), '--apply']);
  assert.notEqual(outputResult.status, 0);
  assert.match(outputResult.stderr, /inside the maintenance project/i);
  assert.equal(fs.existsSync(path.join(outside, 'release')), false);
});

test('verification rejects altered, missing, and extra files', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  parseStdout(runTool(fixture, ['--source', fixture.source, '--output', fixture.output, '--apply']));

  const altered = path.join(fixture.output, 'agent-bridge', 'hooks', 'hooks.js');
  fs.appendFileSync(altered, '// changed\n');
  const alteredResult = runTool(fixture, ['--verify', fixture.output]);
  assert.notEqual(alteredResult.status, 0);
  assert.match(alteredResult.stderr, /digest mismatch/i);

  fs.writeFileSync(altered, 'module.exports = "agent-bridge/hooks";\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.output, 'release-manifest.json'), 'utf8'));
  const expected = manifest.files.find(file => file.path === 'agent-bridge/hooks/hooks.js');
  const original = fs.readFileSync(path.join(fixture.source, 'agent-bridge', 'hooks', 'hooks.js'));
  fs.writeFileSync(altered, original);
  assert.equal(expected.sha256.length, 64);
  const extra = path.join(fixture.output, 'extra.json');
  fs.writeFileSync(extra, '{}\n');
  const extraResult = runTool(fixture, ['--verify', fixture.output]);
  assert.notEqual(extraResult.status, 0);
  assert.match(extraResult.stderr, /unexpected release file/i);
  fs.unlinkSync(extra);

  fs.unlinkSync(path.join(fixture.output, 'docs', 'layered-v2', 'notes.md'));
  const missingResult = runTool(fixture, ['--verify', fixture.output]);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /missing/i);
});

test('symlinks in selected source trees are rejected when the host permits creating them', t => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const target = path.join(fixture.source, 'agent-bridge', 'lib', 'lib.js');
  const link = path.join(fixture.source, 'agent-bridge', 'lib', 'linked.js');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Host does not permit symlink fixtures: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = runTool(fixture, ['--source', fixture.source, '--output', fixture.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link or reparse point/i);
  assert.equal(fs.existsSync(fixture.output), false);
});
