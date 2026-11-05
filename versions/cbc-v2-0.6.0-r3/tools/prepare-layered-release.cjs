'use strict';

// Build or verify a local, versioned runtime snapshot; this tool never deploys or contacts services. / 仅生成或核验本地版本快照，不执行部署或连接外部服务。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_NAME = 'release-manifest.json';
const EXCLUDED_DIRS = new Set(['backup', 'backups', 'node_modules', 'state', '.local', 'test-results', 'test-artifacts', 'logs']);
const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.md', '.yaml', '.yml']);
const TEST_EXTENSIONS = new Set(['.js', '.cjs', '.json', '.md', '.txt']);
const VENDOR_EXTENSIONS = new Set(['.js', '.cjs', '.json', '.md', '.txt', '.yaml', '.yml']);
const TOOL_EXTENSIONS = new Set(['.js', '.cjs', '.json', '.md', '.ps1', '.py', '.txt', '.yaml', '.yml']);
const COPY_DIR_SPECS = [
  { path: 'agent-bridge/bin', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/lib', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/hooks', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/vendor', extensions: VENDOR_EXTENSIONS },
  { path: 'agent-bridge/examples', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/scripts', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/skills', extensions: ALLOWED_EXTENSIONS },
  { path: 'agent-bridge/test', extensions: TEST_EXTENSIONS },
  { path: 'docs/layered-v2', extensions: ALLOWED_EXTENSIONS },
  { path: 'tools', extensions: TOOL_EXTENSIONS },
];
const COPY_DIRS = COPY_DIR_SPECS.map(spec => spec.path);
const COPY_FILES = [
  'package.json',
  'package-lock.json',
  'agent-bridge/package.json',
  'agent-bridge/vendor/zcode/LICENSE-zod',
  'agent-bridge/vendor/zcode/LICENSE-ZCode',
  'evidence/2026-10-27/e2e/acceptance.test.cjs',
  'evidence/2026-10-27/e2e/layout-acceptance.test.cjs',
  'evidence/2026-10-27/e2e/src/port.cjs',
  'evidence/2026-10-27/e2e/layout-proof.txt',
];
const REQUIRED_SOURCE_FILES = ['agent-bridge/vendor/zcode/remote-sdk.cjs'];
const REPARSE_FLAG = 0x400;

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathParts(absolutePath) {
  const parsed = path.parse(absolutePath);
  const parts = [parsed.root];
  let current = parsed.root;
  for (const segment of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    parts.push(current);
  }
  return parts;
}

function hasReparseAttribute(stats) {
  return stats.isSymbolicLink() || (Number.isInteger(stats.attributes) && (stats.attributes & REPARSE_FLAG) !== 0);
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function inspectAncestors(absolutePath, { requireExists = true, finalKind = 'any' } = {}) {
  const parts = pathParts(absolutePath);
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    const stats = lstatOrNull(current);
    if (!stats) {
      if (requireExists) fail(`Path component does not exist: ${current}`);
      return null;
    }
    if (hasReparseAttribute(stats)) fail(`Symbolic link or reparse point is not allowed: ${current}`);
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stats.isDirectory()) fail(`Path ancestor is not a directory: ${current}`);
    if (isFinal && finalKind === 'directory' && !stats.isDirectory()) fail(`Expected a directory: ${current}`);
    if (isFinal && finalKind === 'file' && !stats.isFile()) fail(`Expected a regular file: ${current}`);
    if (isFinal && finalKind === 'new' && stats) fail(`Output already exists; refusing to overwrite: ${current}`);
  }
  return fs.lstatSync(absolutePath);
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalProjectRoot(value) {
  const candidate = path.resolve(value);
  inspectAncestors(candidate, { finalKind: 'directory' });
  const real = fs.realpathSync(candidate);
  if (path.resolve(real) !== path.resolve(candidate)) fail('Project root must not resolve through a link or reparse point');
  return real;
}

function resolveExistingDirectory(value, projectRoot, label) {
  const candidate = path.resolve(value);
  inspectAncestors(candidate, { finalKind: 'directory' });
  const real = fs.realpathSync(candidate);
  if (!isWithin(projectRoot, real)) fail(`${label} resolves outside the maintenance project`);
  return real;
}

function resolveNewOutput(value, projectRoot) {
  const candidate = path.resolve(value);
  if (!isWithin(projectRoot, candidate)) fail('Output path must remain inside the maintenance project');
  inspectAncestors(candidate, { requireExists: false, finalKind: 'new' });
  let parent = path.dirname(candidate);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) fail('Output has no existing ancestor inside the maintenance project');
    parent = next;
  }
  inspectAncestors(parent, { finalKind: 'directory' });
  const realParent = fs.realpathSync(parent);
  if (!isWithin(projectRoot, realParent)) fail('Output ancestor resolves outside the maintenance project');
  return candidate;
}

function assertNoOutputInsideSources(sourceRoot, outputPath) {
  for (const relative of COPY_DIRS) {
    const selected = path.resolve(sourceRoot, ...relative.split('/'));
    if (isWithin(selected, outputPath)) fail(`Output cannot be placed inside a copied source directory: ${relative}`);
  }
}

function openRegularFile(filePath, containmentRoot) {
  const before = inspectAncestors(filePath, { finalKind: 'file' });
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail(`Source is not a regular file: ${filePath}`);
    if (before.dev && opened.dev && (before.dev !== opened.dev || before.ino !== opened.ino)) {
      fail(`File identity changed while opening: ${filePath}`);
    }
    const real = fs.realpathSync(filePath);
    if (!isWithin(containmentRoot, real)) fail(`File resolves outside the allowed source: ${filePath}`);
    const data = fs.readFileSync(descriptor);
    const after = inspectAncestors(filePath, { finalKind: 'file' });
    if (before.dev && after.dev && (before.dev !== after.dev || before.ino !== after.ino)) {
      fail(`File identity changed while reading: ${filePath}`);
    }
    return data;
  } finally {
    fs.closeSync(descriptor);
  }
}

function relativePosix(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function addSnapshotFile(files, sourceRoot, filePath) {
  const relative = relativePosix(sourceRoot, filePath);
  const data = openRegularFile(filePath, sourceRoot);
  if (data.includes(0) || !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) {
    fail(`Binary or non-UTF-8 file is not allowed in the release: ${relative}`);
  }
  files.set(relative, { path: relative, size: data.length, sha256: sha256(data) });
}

function walkSourceDirectory(sourceRoot, relativeDirectory, extensions, files) {
  const base = path.resolve(sourceRoot, ...relativeDirectory.split('/'));
  inspectAncestors(base, { finalKind: 'directory' });
  const visit = directory => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(directory, entry.name);
      const stats = inspectAncestors(fullPath, { finalKind: 'any' });
      if (hasReparseAttribute(stats)) fail(`Symbolic link or reparse point is not allowed in copied source: ${fullPath}`);
      if (stats.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!stats.isFile()) {
        if (extensions.has(path.extname(entry.name).toLowerCase())) {
          fail(`Non-regular file is not allowed in copied source: ${fullPath}`);
        }
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      addSnapshotFile(files, sourceRoot, fullPath);
    }
  };
  visit(base);
}

function collectSnapshot(sourceRoot) {
  const files = new Map();
  for (const relative of COPY_FILES) {
    const fullPath = path.resolve(sourceRoot, ...relative.split('/'));
    inspectAncestors(fullPath, { finalKind: 'file' });
    if (!isAllowedReleasePath(relative)) fail(`Required file is outside the release allowlist: ${relative}`);
    addSnapshotFile(files, sourceRoot, fullPath);
  }
  for (const spec of COPY_DIR_SPECS) walkSourceDirectory(sourceRoot, spec.path, spec.extensions, files);
  for (const relative of REQUIRED_SOURCE_FILES) {
    if (!files.has(relative)) fail(`Required release source is missing or excluded: ${relative}`);
  }
  const entries = [...files.values()].sort((a, b) => compareText(a.path, b.path));
  if (!entries.length) fail('No release files were selected');
  return entries;
}

function aggregateSha256(entries) {
  const canonical = entries.map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join('');
  return sha256(canonical);
}

function manifestFor(entries) {
  return {
    schemaVersion: 1,
    fileCount: entries.length,
    aggregateSha256: aggregateSha256(entries),
    files: entries,
  };
}

function isAllowedReleasePath(relative) {
  if (relative === MANIFEST_NAME || relative.startsWith('/') || relative.includes('\\')) return false;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || EXCLUDED_DIRS.has(part.toLowerCase()))) return false;
  if (COPY_FILES.includes(relative)) return true;
  const spec = COPY_DIR_SPECS.find(item => relative.startsWith(`${item.path}/`));
  return Boolean(spec && spec.extensions.has(path.posix.extname(relative).toLowerCase()));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1
      || !Number.isSafeInteger(manifest.fileCount) || !Array.isArray(manifest.files)
      || typeof manifest.aggregateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.aggregateSha256)) {
    fail('Release manifest has an invalid shape or schema version');
  }
  const seen = new Set();
  let previous = '';
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.path !== 'string' || !isAllowedReleasePath(entry.path)
        || !Number.isSafeInteger(entry.size) || entry.size < 0
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail('Release manifest contains an invalid file entry');
    }
    if (seen.has(entry.path)) fail(`Release manifest contains a duplicate path: ${entry.path}`);
    if (previous && compareText(previous, entry.path) >= 0) fail('Release manifest entries are not in strict path order');
    seen.add(entry.path);
    previous = entry.path;
  }
  if (manifest.fileCount !== manifest.files.length) fail('Release manifest file count does not match its entries');
  if (aggregateSha256(manifest.files) !== manifest.aggregateSha256) fail('Release manifest aggregate digest is invalid');
}

function collectReleaseTree(releaseRoot) {
  const files = new Set();
  const directories = new Set();
  const visit = (directory, relativeDirectory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stats = inspectAncestors(fullPath, { finalKind: 'any' });
      if (hasReparseAttribute(stats)) fail(`Release contains a symbolic link or reparse point: ${relative}`);
      if (stats.isDirectory()) {
        directories.add(relative);
        visit(fullPath, relative);
      } else if (stats.isFile()) {
        files.add(relative);
      } else {
        fail(`Release contains a non-regular entry: ${relative}`);
      }
    }
  };
  visit(releaseRoot, '');
  return { files, directories };
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const relative of files) {
    let current = path.posix.dirname(relative);
    while (current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function verifyRelease(releaseValue, projectRoot) {
  const releaseRoot = resolveExistingDirectory(releaseValue, projectRoot, 'Release');
  const manifestPath = path.join(releaseRoot, MANIFEST_NAME);
  inspectAncestors(manifestPath, { finalKind: 'file' });
  let manifest;
  try {
    manifest = JSON.parse(openRegularFile(manifestPath, releaseRoot).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`Release manifest is not valid JSON: ${error.message}`);
    throw error;
  }
  validateManifest(manifest);

  const expectedFiles = new Set(manifest.files.map(entry => entry.path));
  const expectedDirs = expectedDirectories(expectedFiles);
  const actual = collectReleaseTree(releaseRoot);
  const expectedAllFiles = new Set([...expectedFiles, MANIFEST_NAME]);
  for (const file of actual.files) if (!expectedAllFiles.has(file)) fail(`Unexpected release file: ${file}`);
  for (const file of expectedAllFiles) if (!actual.files.has(file)) fail(`Release file is missing: ${file}`);
  for (const directory of actual.directories) if (!expectedDirs.has(directory)) fail(`Unexpected release directory: ${directory}`);
  for (const directory of expectedDirs) if (!actual.directories.has(directory)) fail(`Release directory is missing: ${directory}`);

  for (const entry of manifest.files) {
    const filePath = path.resolve(releaseRoot, ...entry.path.split('/'));
    const data = openRegularFile(filePath, releaseRoot);
    if (data.length !== entry.size || sha256(data) !== entry.sha256) fail(`Release file digest mismatch: ${entry.path}`);
  }
  return { mode: 'verify', fileCount: manifest.fileCount, aggregateSha256: manifest.aggregateSha256 };
}

function ensureParents(directory, projectRoot) {
  const absolute = path.resolve(directory);
  if (!isWithin(projectRoot, absolute)) fail('Output parent must remain inside the maintenance project');
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) fail('Output parent has no existing ancestor');
    current = parent;
  }
  inspectAncestors(current, { finalKind: 'directory' });
  if (!isWithin(projectRoot, fs.realpathSync(current))) fail('Output parent resolves outside the maintenance project');
  for (const item of missing.reverse()) fs.mkdirSync(item);
  inspectAncestors(absolute, { finalKind: 'directory' });
  if (!isWithin(projectRoot, fs.realpathSync(absolute))) fail('Created output parent resolves outside the maintenance project');
}

function copySnapshot(sourceRoot, outputPath, projectRoot, entries) {
  const parent = path.dirname(outputPath);
  ensureParents(parent, projectRoot);
  inspectAncestors(outputPath, { requireExists: false, finalKind: 'new' });
  const staging = fs.mkdtempSync(path.join(parent, `.prepare-layered-release-${path.basename(outputPath)}-`));
  let targetCreated = false;
  try {
    for (const entry of entries) {
      const sourcePath = path.resolve(sourceRoot, ...entry.path.split('/'));
      const data = openRegularFile(sourcePath, sourceRoot);
      if (data.length !== entry.size || sha256(data) !== entry.sha256) fail(`Source changed after preview; refusing to prepare: ${entry.path}`);
      const destination = path.resolve(staging, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, data, { flag: 'wx' });
    }
    const manifest = manifestFor(entries);
    fs.writeFileSync(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

    // Claim the destination exclusively before moving staged entries; a partial result keeps a marker and is never reported as ready. / 先以独占方式占用目标目录；若移动中断则保留标记，不报告为已就绪。
    fs.mkdirSync(outputPath);
    targetCreated = true;
    inspectAncestors(outputPath, { finalKind: 'directory' });
    if (!isWithin(projectRoot, fs.realpathSync(outputPath))) fail('Created output resolves outside the maintenance project');
    const incompleteMarker = path.join(outputPath, '.prepare-incomplete');
    fs.writeFileSync(incompleteMarker, 'Release preparation incomplete; do not use. / 发布准备未完成，请勿使用。\n', { flag: 'wx' });
    for (const name of fs.readdirSync(staging).sort(compareText)) {
      fs.renameSync(path.join(staging, name), path.join(outputPath, name));
    }
    fs.unlinkSync(incompleteMarker);
    fs.rmdirSync(staging);
  } catch (error) {
    if (!targetCreated && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifestFor(entries);
}

function parseArguments(argv) {
  const options = { apply: false, projectRoot: DEFAULT_PROJECT_ROOT };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--apply') {
      if (seen.has(name)) fail('Option repeated: --apply');
      seen.add(name);
      options.apply = true;
      continue;
    }
    if (!['--source', '--output', '--project-root', '--verify'].includes(name)) fail(`Unknown option: ${name}`);
    if (seen.has(name)) fail(`Option repeated: ${name}`);
    seen.add(name);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${name}`);
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (options.verify) {
    if (options.source || options.output || options.apply) fail('--verify cannot be combined with --source, --output, or --apply');
  } else if (!options.source || !options.output) {
    fail('Preparation requires both --source <worktree-root> and --output <new-project-directory>');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node tools/prepare-layered-release.cjs --source <worktree-root> --output <new-project-directory> [--apply] [--project-root <maintenance-project>]',
    '  node tools/prepare-layered-release.cjs --verify <release-directory> [--project-root <maintenance-project>]',
    'Default mode prints a dry-run preview. --apply copies a new local release; it never deploys it.',
  ].join('\n');
}

function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'help', usage: usage() };
  const options = parseArguments(argv);
  const projectRoot = canonicalProjectRoot(options.projectRoot);
  if (options.verify) return verifyRelease(options.verify, projectRoot);

  const sourceRoot = resolveExistingDirectory(options.source, projectRoot, 'Source');
  const outputPath = resolveNewOutput(options.output, projectRoot);
  assertNoOutputInsideSources(sourceRoot, outputPath);
  const entries = collectSnapshot(sourceRoot);
  const manifest = manifestFor(entries);
  if (options.apply) copySnapshot(sourceRoot, outputPath, projectRoot, entries);
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    output: relativePosix(projectRoot, outputPath),
    fileCount: entries.length,
    aggregateSha256: manifest.aggregateSha256,
    files: entries,
  };
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.mode === 'help') process.stdout.write(`${result.usage}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`prepare-layered-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { aggregateSha256, collectSnapshot, manifestFor, run, verifyRelease };
