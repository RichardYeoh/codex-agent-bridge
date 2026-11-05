'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const secret = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
function inspectText(file, text) {
  const problems = [];
  if (secret.test(text)) problems.push(`${file}: possible secret`);
  if (/remote\/v4\?[^\s"'<>]*\bsid=d_[A-Za-z0-9]{8,}/.test(text)) problems.push(`${file}: private remote binding`);
  if (/[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|$)|Default(?:[\\/]|$)|<|\$|%)[A-Za-z0-9_.-]+[\\/]/.test(text)) {
    problems.push(`${file}: account-specific absolute path`);
  }
  if (/(?:session_|term_)[A-Za-z0-9]{12,}/.test(text)
      || /01a[0-9a-f]{5}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text)) {
    problems.push(`${file}: native session or owner identity`);
  }
  return problems;
}

function inspect({ cwd = root, staged = false } = {}) {
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const args = staged ? ['ls-files', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const files = [...new Set(git(args).toString('utf8').split('\0').filter(Boolean))];
  if (!files.length) throw new Error('No publication candidates to inspect');
  const problems = [];
  for (const file of files) {
    if (/(?:^|\/)(?:\.local|\.codex|\.herdr|node_modules|backups|test-artifacts)(?:\/|$)/.test(file)) {
      problems.push(`${file}: private/generated directory`);
    }
    if (!staged && !fs.existsSync(path.join(cwd, file))) continue;
    if (!staged && fs.lstatSync(path.join(cwd, file)).isSymbolicLink()) {
      problems.push(`${file}: symbolic link requires review`); continue;
    }
    // Inspect the exact Git index before publishing; untracked candidates are checked by default. / 发布前检查准确暂存内容；默认还检查未跟踪候选。
    const data = staged ? git(['show', ':' + file]) : fs.readFileSync(path.join(cwd, file));
    if (!data.includes(0)) problems.push(...inspectText(file, data.toString('utf8')));
  }
  return { files: files.length, problems };
}

if (require.main === module) {
  const result = inspect({ staged: process.argv.includes('--staged') });
  // Report locations, never matching secrets. / 只输出问题位置，不输出匹配到的凭据。
  for (const problem of result.problems) process.stderr.write(`${problem}\n`);
  process.stdout.write(`Inspected ${result.files} publication files; findings: ${result.problems.length}\n`);
  process.exitCode = result.problems.length ? 1 : 0;
}

module.exports = { inspect, inspectText };
