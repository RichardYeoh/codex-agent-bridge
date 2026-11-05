'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const names = ['cbc.ps1', 'cbc.cmd', 'cbc'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function defaults(options = {}) {
  return { prefix: path.join(process.env.APPDATA || '', 'npm'),
    preset: path.join(repo, 'agent-bridge/examples/cbc-context-1m.json'),
    stateDir: path.join(repo, '.local/cbc-context-launcher'), ...options };
}

function readShim(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('CBC entry must be a regular file: ' + file);
  return fs.readFileSync(file);
}

function transform(name, original, preset) {
  const location = path.resolve(preset).replace(/\\/g, '/');
  if (/["\r\n%!]/.test(location)) throw new Error('CBC preset path contains unsupported shell characters');
  const native = name === 'cbc.cmd'
    ? '"%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"'
    : '"$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"';
  const quoted = name === 'cbc.ps1' ? "'" + location.replace(/'/g, "''") + "'"
    : name === 'cbc.cmd' ? '"' + location + '"' : "'" + location.replace(/'/g, "'\"'\"'") + "'";
  if (!original.includes(native)) throw new Error('Unrecognized npm CBC entry; no file changed: ' + name);
  return original.split(native).join(native + ' --settings ' + quoted);
}

function atomicWrite(file, bytes) {
  const temp = file + '.cbc-context-' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function manifestFor(options) {
  const file = path.join(options.stateDir, 'manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function check(options = {}) {
  options = defaults(options);
  const manifest = manifestFor(options);
  const entries = names.map(name => {
    const file = path.join(options.prefix, name), saved = manifest?.entries?.find(item => item.name === name);
    const sha256 = digest(readShim(file));
    return { name, file, active: manifest?.status === 'installed' && saved?.installedSHA256 === sha256 };
  });
  let presetReady = false;
  try { presetReady = JSON.parse(fs.readFileSync(options.preset, 'utf8')).contextWindow === 1000000; } catch {}
  return { installed: presetReady && entries.every(item => item.active), preset: options.preset, presetReady, entries };
}

function install(options = {}) {
  options = defaults(options);
  if (JSON.parse(fs.readFileSync(options.preset, 'utf8')).contextWindow !== 1000000) throw new Error('Expected the reviewed 1M preset');
  const previous = manifestFor(options);
  if (previous?.status === 'installed' && path.resolve(previous.preset) !== path.resolve(options.preset)) {
    throw new Error('CBC preset location changed; remove the previous binding before reinstalling');
  }
  // Prepare and validate every entry before any write. / 写入前准备并校验全部入口。
  const plans = names.map(name => {
    const file = path.join(options.prefix, name), bytes = readShim(file);
    const saved = previous?.status === 'installed' && previous.entries.find(item => item.name === name);
    if (saved?.file !== undefined && path.resolve(saved.file) !== path.resolve(file)) throw new Error('CBC installation prefix changed');
    if (saved && saved.installedSHA256 === digest(bytes)) return { name, file, bytes, saved };
    if (saved && bytes.includes(Buffer.from('--settings '))) throw new Error('Managed CBC entry changed; inspect before reinstalling: ' + file);
    if (bytes.includes(Buffer.from('--settings '))) throw new Error('Existing CBC settings override must be reviewed: ' + file);
    return { name, file, bytes, updated: Buffer.from(transform(name, bytes.toString('utf8'), options.preset)) };
  });
  if (plans.every(item => item.saved)) return check(options);
  const run = path.join(options.stateDir, 'backups', crypto.randomUUID());
  fs.mkdirSync(run, { recursive: true });
  const entries = plans.map(plan => {
    if (plan.saved) return plan.saved;
    const backup = path.join(run, plan.name);
    fs.writeFileSync(backup, plan.bytes, { flag: 'wx' });
    return { name: plan.name, file: plan.file, backup, originalSHA256: digest(plan.bytes), installedSHA256: digest(plan.updated) };
  });
  if (previous) fs.writeFileSync(path.join(run, 'previous-manifest.json'), JSON.stringify(previous, null, 2));
  const changed = [];
  try {
    for (const plan of plans.filter(item => item.updated)) {
      if (digest(readShim(plan.file)) !== digest(plan.bytes)) throw new Error('CBC entry changed concurrently: ' + plan.file);
      atomicWrite(plan.file, plan.updated); changed.push(plan);
    }
    atomicWrite(path.join(options.stateDir, 'manifest.json'), JSON.stringify({ status: 'installed',
      installedAt: new Date().toISOString(), preset: options.preset, entries }, null, 2));
  } catch (error) {
    // Roll back only exact writes owned by this attempt. / 仅回滚本次写入且摘要仍一致的文件。
    for (const plan of changed.reverse()) {
      if (digest(readShim(plan.file)) === digest(plan.updated)) atomicWrite(plan.file, plan.bytes);
    }
    throw error;
  }
  return check(options);
}

function remove(options = {}) {
  options = defaults(options);
  const manifest = manifestFor(options);
  if (!manifest || manifest.status !== 'installed') return { removed: false };
  const plans = manifest.entries.map(entry => {
    if (!names.includes(entry.name) || path.resolve(entry.file) !== path.resolve(options.prefix, entry.name)) throw new Error('CBC restore target mismatch');
    if (!path.resolve(entry.backup).startsWith(path.resolve(options.stateDir, 'backups') + path.sep)) throw new Error('CBC backup path is outside the managed archive');
    const current = readShim(entry.file), backup = readShim(entry.backup);
    if (digest(current) !== entry.installedSHA256 || digest(backup) !== entry.originalSHA256) {
      throw new Error('CBC entry or backup changed; refusing to overwrite: ' + entry.file);
    }
    return { entry, current, backup };
  });
  const changed = [];
  try {
    for (const plan of plans) {
      if (digest(readShim(plan.entry.file)) !== plan.entry.installedSHA256) throw new Error('CBC entry changed concurrently: ' + plan.entry.file);
      atomicWrite(plan.entry.file, plan.backup); changed.push(plan);
    }
    atomicWrite(path.join(options.stateDir, 'manifest.json'), JSON.stringify({ ...manifest, status: 'removed', removedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    for (const plan of changed.reverse()) {
      if (digest(readShim(plan.entry.file)) === digest(plan.backup)) atomicWrite(plan.entry.file, plan.current);
    }
    throw error;
  }
  return { removed: true, backupsRetained: true };
}

if (require.main === module) {
  try {
    const action = process.argv[2] || 'check';
    if (!['install', 'check', 'remove'].includes(action)) throw new Error('Usage: configure-cbc-context.cjs <install|check|remove>');
    process.stdout.write(JSON.stringify(({ install, check, remove })[action](), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { transform, install, check, remove };
