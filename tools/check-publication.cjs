'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked files to inspect');
const problems = [];
const secret = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
for (const file of files) {
  if (/(?:^|\/)(?:\.local|node_modules|backups)(?:\/|$)/.test(file)) problems.push(`${file}: private/generated directory`);
  const data = fs.readFileSync(path.join(root, file));
  if (data.includes(0)) continue;
  const text = data.toString('utf8');
  if (secret.test(text)) problems.push(`${file}: possible secret`);
  if (/remote\/v4\?[^\s"'<>]*\bsid=d_[A-Za-z0-9]{8,}/.test(text)) problems.push(`${file}: private remote binding`);
  if (/[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|$)|Default(?:[\\/]|$)|<|\$|%)[A-Za-z0-9_.-]+[\\/]/.test(text)) {
    problems.push(`${file}: account-specific absolute path`);
  }
}
// Report locations, never matching secrets. / 只输出问题位置，不输出匹配到的凭据。
for (const problem of problems) process.stderr.write(`${problem}\n`);
process.stdout.write(`Inspected ${files.length} tracked files; findings: ${problems.length}\n`);
process.exitCode = problems.length ? 1 : 0;
