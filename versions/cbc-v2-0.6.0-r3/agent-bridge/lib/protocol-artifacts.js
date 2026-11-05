'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol-v2');
const { withLock, writeJsonAtomic } = require('./util');
const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
function check(ok, message) { if (!ok) throw Object.assign(new Error(message), { code: 'ARTIFACT_PROOF_INVALID' }); }
function canonical(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }
function within(file, root) {
  const rel = path.relative(canonical(root), canonical(file));
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
function sourceFile(r, input, report = false) {
  check(typeof input === 'string' && input.length > 0, 'Artifact path is missing');
  const file = path.resolve(r.cwd, input);
  protocol.safeDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'Artifacts must be regular files, not directories/links');
  const real = fs.realpathSync.native(file);
  check(canonical(real) === canonical(file), 'Artifact path contains an alias');
  if (report) check(canonical(file) === canonical(r.reportPath), 'Report is not the canonical round report');
  else {
    check(within(real, fs.realpathSync.native(r.cwd)), 'Artifact is outside the project');
    check(r.allowedArtifacts.some(item => within(real, path.resolve(r.cwd, item))), 'Artifact is outside the declared write scope');
    check(!within(real, path.resolve(r.stateDir)), 'Task state is not a business artifact');
    check(!path.relative(r.cwd, real).split(path.sep).some(x => ['.git', '.codebuddy', '.codex'].includes(x.toLowerCase())), 'Private control files are not artifacts');
  }
  return real;
}

function snapshotBytes(file, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    check(before.isFile() && before.size <= BigInt(limit), 'Artifact exceeds byte limit');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    check(!current.isSymbolicLink() && before.dev === current.dev && before.ino === current.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
      && current.size === after.size && current.mtimeNs === after.mtimeNs && BigInt(bytes.length) === after.size,
    'Artifact changed while being frozen');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function readManifest(r) {
  const dir = protocol.requestDirectory(r), file = path.join(dir, 'artifact-manifest.json');
  protocol.safeDirectory(dir);
  const m = JSON.parse(protocol.readRegular(file));
  check(m.schema === protocol.SCHEMA && m.requestSha256 === protocol.digest(r)
    && Array.isArray(m.files) && m.files.length > 0 && m.files.length <= 257, 'Invalid frozen manifest');
  let total = 0, reports = 0;
  for (const item of m.files) {
    check(/^[a-f0-9]{64}\.bin$/.test(item.stored) && /^[a-f0-9]{64}$/.test(item.sha256)
      && item.stored === item.sha256 + '.bin' && Number.isSafeInteger(item.bytes) && item.bytes >= 0, 'Invalid artifact entry');
    check(['report', 'artifact'].includes(item.role), 'Invalid artifact role');
    if (item.role === 'report') { reports++; check(item.source === r.reportPath && item.bytes > 0, 'Invalid canonical report'); }
    const bytes = protocol.readRegular(path.join(dir, 'artifacts', item.stored), MAX_FILE);
    check(bytes.length === item.bytes && protocol.sha(bytes) === item.sha256, 'Frozen artifact digest mismatch');
    total += bytes.length; check(total <= MAX_TOTAL, 'Frozen artifact set is too large');
  }
  check(reports === 1, 'Manifest requires exactly one report');
  return m;
}

async function submitResult(r, { outcome, reason = '', report = r.reportPath, artifacts = [] }) {
  protocol.validateRequest(r);
  check(['delivered', 'failed'].includes(outcome) && typeof reason === 'string' && reason.length <= 2048, 'Invalid outcome or reason');
  check(Array.isArray(artifacts) && artifacts.length <= 256 && artifacts.every(x => typeof x === 'string'), 'Invalid artifact list');
  // Declared deliverables are captured mechanically; failed work may report missing outputs. / 程序自动捕获声明交付物；失败任务允许报告缺失输出。
  const required = outcome === 'delivered' ? (r.requiredArtifacts || []) : [];
  artifacts = [...new Set([...required, ...artifacts].map(x => path.resolve(r.cwd, x)))];
  check(artifacts.length <= 256, 'Artifact set is too large');
  const dir = protocol.safeDirectory(protocol.requestDirectory(r));
  return withLock('snapshot-' + protocol.sha(canonical(dir)).slice(0, 40), async () => {
    const state = protocol.inspect(r);
    check(state.transport === 'admitted' && !state.conflicts.length, 'Result requires an unambiguous native admission');
    const file = path.join(dir, 'artifact-manifest.json');
    let m;
    if (fs.existsSync(file)) {
      m = readManifest(r);
      check(m.outcome === outcome && m.reason === reason, 'A frozen result cannot be replaced; use a new round');
      const expected = [path.resolve(r.cwd, report), ...artifacts.map(x => path.resolve(r.cwd, x))];
      check(JSON.stringify(expected) === JSON.stringify(m.files.map(x => x.source)), 'Result retry refers to different artifacts');
    } else {
      check(state.execution !== 'ended', 'Result was not frozen before native Stop; diagnose instead of backdating');
      const entries = [{ source: sourceFile(r, report, true), role: 'report' },
        ...artifacts.map(input => ({ source: sourceFile(r, input), role: 'artifact' }))];
      check(new Set(entries.map(x => canonical(x.source))).size === entries.length, 'Duplicate artifact paths');
      const out = path.join(dir, 'artifacts'); fs.mkdirSync(out, { recursive: true }); protocol.safeDirectory(out);
      let total = 0;
      const files = entries.map(item => {
        const bytes = snapshotBytes(item.source, item.role === 'report' ? 4 * 1024 * 1024 : MAX_FILE);
        check(item.role !== 'report' || bytes.length > 0, 'Delivery report is empty');
        total += bytes.length; check(total <= MAX_TOTAL, 'Artifact set exceeds byte limit');
        const sha256 = protocol.sha(bytes), stored = sha256 + '.bin', destination = path.join(out, stored);
        if (fs.existsSync(destination)) check(protocol.sha(protocol.readRegular(destination, MAX_FILE)) === sha256, 'Existing snapshot is corrupt');
        else fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
        return { ...item, stored, sha256, bytes: bytes.length };
      });
      m = { schema: protocol.SCHEMA, requestSha256: protocol.digest(r), outcome, reason, at: new Date().toISOString(), files };
      writeJsonAtomic(file, m);
    }
    const payload = { outcome, reason, at: m.at, manifestSha256: protocol.digest(m) };
    return protocol.append(r, protocol.event(r, 'worker.result', payload, 'worker-result'));
  });
}

function verifyResult(r) {
  const m = readManifest(r), events = protocol.load(r).events;
  const result = events.find(e => e.kind === 'worker.result');
  check(result && result.payload.manifestSha256 === protocol.digest(m), 'Result does not match frozen artifacts');
  const drift = m.files.filter(item => {
    try { return protocol.sha(snapshotBytes(item.source, MAX_FILE)) !== item.sha256; } catch { return true; }
  }).map(item => item.source);
  return { manifestSha256: protocol.digest(m), sourceDrift: drift, snapshotVerified: true, files: m.files };
}

module.exports = { submitResult, verifyResult, readManifest, sourceFile, snapshotBytes };
