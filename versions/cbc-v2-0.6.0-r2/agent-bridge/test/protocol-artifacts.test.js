'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const priorStateDir = process.env.AGENT_BRIDGE_STATE_DIR;
const isolatedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-artifacts-'));
// Keep all protocol state under this test-owned temporary root. / 将协议状态限定在本测试创建的临时目录内。
process.env.AGENT_BRIDGE_STATE_DIR = isolatedStateRoot;

const protocol = require('../lib/protocol-v2');
const artifacts = require('../lib/protocol-artifacts');

const SPEC_SHA = protocol.sha('synthetic specification');
const PROMPT_SHA = protocol.sha('synthetic prompt');
const POINTER_SHA = protocol.sha('synthetic exact prompt pointer');
const ADMISSION_SHA = protocol.sha('synthetic native admission proof');
const REQUEST_CREATED_AT = '2026-11-05T00:00:00.000Z';
const ADMITTED_AT = '2026-11-05T00:10:00.000Z';

let nextFixture = 0;

function fixture(options = {}) {
  const number = ++nextFixture;
  const base = path.join(isolatedStateRoot, `fixture-${number}`);
  const cwd = path.join(base, 'workspace');
  const stateDir = options.stateInsideWorkspace ? path.join(cwd, '.bridge-state') : path.join(base, 'state');
  fs.mkdirSync(cwd, { recursive: true });

  const r = {
    schema: protocol.SCHEMA,
    taskId: `task-artifacts-${number}`,
    round: 1,
    requestId: `request-artifacts-${number}`,
    agent: 'fixture-agent',
    specSha256: SPEC_SHA,
    promptSha256: PROMPT_SHA,
    pointerSha256: POINTER_SHA,
    createdAt: REQUEST_CREATED_AT,
    cwd,
    stateDir,
    reportPath: path.join(cwd, 'report.md'),
    binding: {
      agent: 'fixture-agent',
      sessionId: `fixture-session-${number}`,
      herdrSession: `fixture-herdr-session-${number}`,
      paneId: `fixture-pane-${number}`,
      terminalId: `fixture-terminal-${number}`,
      workerStartedAt: REQUEST_CREATED_AT,
    },
    allowedArtifacts: options.allowedArtifacts || ['report.md', 'output.bin', 'large.bin', 'folder', 'linked'],
  };

  fs.writeFileSync(r.reportPath, options.report ?? 'Synthetic report v1\n', 'utf8');
  return r;
}

function admission(r) {
  return protocol.event(r, 'native.admitted', {
    sessionId: r.binding.sessionId,
    terminalId: r.binding.terminalId,
    paneId: r.binding.paneId,
    at: ADMITTED_AT,
    pointerSha256: r.pointerSha256,
    evidenceSha256: ADMISSION_SHA,
  });
}

async function prepare(r, { admitted = true } = {}) {
  await protocol.create(r);
  if (admitted) await protocol.append(r, admission(r));
  return r;
}

function resultArgs(artifactsList = []) {
  return { outcome: 'delivered', reason: 'Synthetic completion', report: 'report.md', artifacts: artifactsList };
}

function artifactProofError(error) {
  return error?.code === 'ARTIFACT_PROOF_INVALID';
}

function rejectedPathError(error) {
  return error?.code === 'ARTIFACT_PROOF_INVALID' || error?.code === 'PROTOCOL_INVALID';
}

test.after(() => {
  fs.rmSync(isolatedStateRoot, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR;
  else process.env.AGENT_BRIDGE_STATE_DIR = priorStateDir;
});

test('freezes real report and artifact bytes, reports source drift, and keeps duplicate result idempotent', async () => {
  const r = await prepare(fixture());
  const artifactPath = path.join(r.cwd, 'output.bin');
  const originalReport = Buffer.from('# Frozen report v1\n', 'utf8');
  const originalArtifact = Buffer.from([0x00, 0x01, 0x7f, 0xff]);
  fs.writeFileSync(r.reportPath, originalReport);
  fs.writeFileSync(artifactPath, originalArtifact);

  const first = await artifacts.submitResult(r, resultArgs(['output.bin']));
  assert.equal(first.review, 'not_ready');
  const manifestFile = path.join(protocol.requestDirectory(r), 'artifact-manifest.json');
  const manifestBefore = fs.readFileSync(manifestFile);
  const manifest = artifacts.readManifest(r);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files.find(item => item.role === 'report').bytes, originalReport.length);
  assert.equal(manifest.files.find(item => item.source === artifactPath).bytes, originalArtifact.length);

  for (const item of manifest.files) {
    const stored = path.join(protocol.requestDirectory(r), 'artifacts', item.stored);
    const frozenBytes = fs.readFileSync(stored);
    assert.equal(protocol.sha(frozenBytes), item.sha256);
    assert.equal(frozenBytes.length, item.bytes);
  }

  const eventsBeforeRetry = protocol.load(r).events.length;
  const retry = await artifacts.submitResult(r, resultArgs(['output.bin']));
  assert.equal(retry.eventCount, eventsBeforeRetry);
  assert.deepEqual(fs.readFileSync(manifestFile), manifestBefore);

  fs.writeFileSync(r.reportPath, '# Edited source after delivery\n', 'utf8');
  fs.writeFileSync(artifactPath, Buffer.from([0x11, 0x22, 0x33]));
  const verified = artifacts.verifyResult(r);
  assert.equal(verified.snapshotVerified, true);
  assert.deepEqual(verified.sourceDrift.sort(), [r.reportPath, artifactPath].sort());
  assert.deepEqual(fs.readFileSync(path.join(protocol.requestDirectory(r), 'artifacts', manifest.files[0].stored)), originalReport);
  assert.deepEqual(fs.readFileSync(path.join(protocol.requestDirectory(r), 'artifacts', manifest.files[1].stored)), originalArtifact);

  const driftedRetry = await artifacts.submitResult(r, resultArgs(['output.bin']));
  assert.equal(driftedRetry.eventCount, eventsBeforeRetry);
  await assert.rejects(artifacts.submitResult(r, { ...resultArgs(['output.bin']), outcome: 'failed' }), artifactProofError);
  await assert.rejects(artifacts.submitResult(r, resultArgs([])), artifactProofError);
  assert.deepEqual(fs.readFileSync(manifestFile), manifestBefore);
  assert.equal(protocol.load(r).events.filter(item => item.kind === 'worker.result').length, 1);
});

test('rejects a result before exact native admission without creating a manifest', async () => {
  const r = await prepare(fixture(), { admitted: false });
  await assert.rejects(artifacts.submitResult(r, resultArgs()), artifactProofError);
  assert.equal(protocol.inspect(r).transport, 'prepared');
  assert.equal(protocol.load(r).events.length, 0);
  assert.equal(fs.existsSync(path.join(protocol.requestDirectory(r), 'artifact-manifest.json')), false);
});

test('rejects manifests copied to another request and manifests with damaged digests', async () => {
  const first = await prepare(fixture());
  await artifacts.submitResult(first, resultArgs());
  const sourceManifest = path.join(protocol.requestDirectory(first), 'artifact-manifest.json');

  const other = await prepare(fixture());
  const otherDir = protocol.requestDirectory(other);
  fs.copyFileSync(sourceManifest, path.join(otherDir, 'artifact-manifest.json'));
  assert.throws(() => artifacts.readManifest(other), artifactProofError);

  const parsed = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
  parsed.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(sourceManifest, JSON.stringify(parsed), 'utf8');
  assert.throws(() => artifacts.verifyResult(first), artifactProofError);
});

test('rejects artifacts outside project or declared scope, directories, and symlink aliases', async t => {
  const r = fixture({ allowedArtifacts: ['report.md', '../outside.bin', 'folder', 'linked'] });
  await prepare(r);

  const outside = path.join(path.dirname(r.cwd), 'outside.bin');
  fs.writeFileSync(outside, 'outside');
  assert.throws(() => artifacts.sourceFile(r, '../outside.bin'), artifactProofError);

  const undeclared = path.join(r.cwd, 'undeclared.bin');
  fs.writeFileSync(undeclared, 'not in scope');
  assert.throws(() => artifacts.sourceFile(r, 'undeclared.bin'), artifactProofError);

  const directory = path.join(r.cwd, 'folder');
  fs.mkdirSync(directory);
  assert.throws(() => artifacts.sourceFile(r, 'folder'), artifactProofError);

  const targetDir = path.join(path.dirname(r.cwd), 'external-target');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, 'linked.bin'), 'linked content');
  const linkDir = path.join(r.cwd, 'linked');
  try {
    fs.symlinkSync(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      t.skip(`Symlink creation is unavailable in this environment (${error.code})`);
      return;
    }
    throw error;
  }
  assert.throws(() => artifacts.sourceFile(r, path.join('linked', 'linked.bin')), rejectedPathError);
});

test('rejects an empty canonical delivery report', async () => {
  const r = fixture({ report: '' });
  await prepare(r);
  await assert.rejects(artifacts.submitResult(r, resultArgs()), artifactProofError);
  assert.equal(fs.existsSync(path.join(protocol.requestDirectory(r), 'artifact-manifest.json')), false);
  assert.equal(protocol.load(r).events.some(item => item.kind === 'worker.result'), false);
});

test('rejects a source that changes while bytes are being snapshotted', async () => {
  const r = fixture();
  const file = path.join(r.cwd, 'output.bin');
  fs.writeFileSync(file, 'before mutation');
  const originalReadFileSync = fs.readFileSync;
  let injected = false;

  // Mutate after the open descriptor is read but before the second stat. / 在打开的文件描述符读完、第二次状态检查前替换源文件内容。
  fs.readFileSync = function (target, ...args) {
    const bytes = originalReadFileSync.call(this, target, ...args);
    if (Number.isInteger(target) && !injected) {
      injected = true;
      fs.writeFileSync(file, 'content changed during snapshot with a different size');
    }
    return bytes;
  };
  try {
    assert.throws(() => artifacts.snapshotBytes(file, 1024), artifactProofError);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(injected, true);
});

test('enforces the report and individual artifact byte limits before reading oversized files', async () => {
  const reportTooLarge = await prepare(fixture());
  fs.truncateSync(reportTooLarge.reportPath, 4 * 1024 * 1024 + 1);
  await assert.rejects(artifacts.submitResult(reportTooLarge, resultArgs()), artifactProofError);
  assert.equal(fs.existsSync(path.join(protocol.requestDirectory(reportTooLarge), 'artifact-manifest.json')), false);

  const artifactTooLarge = await prepare(fixture());
  const large = path.join(artifactTooLarge.cwd, 'large.bin');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 64 * 1024 * 1024 + 1);
  await assert.rejects(artifacts.submitResult(artifactTooLarge, resultArgs(['large.bin'])), artifactProofError);
  assert.equal(fs.existsSync(path.join(protocol.requestDirectory(artifactTooLarge), 'artifact-manifest.json')), false);
});

test('rejects source paths under a state directory located inside the project', async () => {
  const r = fixture({ stateInsideWorkspace: true, allowedArtifacts: ['report.md', '.bridge-state/payload.bin'] });
  await prepare(r);
  const privateArtifact = path.join(r.stateDir, 'payload.bin');
  fs.writeFileSync(privateArtifact, 'not a business artifact');
  assert.throws(() => artifacts.sourceFile(r, '.bridge-state/payload.bin'), artifactProofError);
});
