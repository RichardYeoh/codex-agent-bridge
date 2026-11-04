'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config } = require('../agent-bridge/lib/util');
const { createQueueClient } = require('../agent-bridge/lib/codex-client');

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { exitCode: result.status, code: result.error?.code || null,
    stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

async function diagnose(target) {
  const cfg = config(), environment = {};
  // Read only allowlisted non-credential environment fields. / 仅读取允许列出的非凭据环境字段。
  for (const key of ['CODEX_HOME', 'CODEX_THREAD_ID', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME',
    'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) environment[key] = process.env[key] || null;
  const report = { schemaVersion: 1, timestamp: new Date().toISOString(), cwd: process.cwd(),
    node: { executable: process.execPath, version: process.version }, environment,
    commands: { herdr: cfg.herdr, codexJs: cfg.codexJs }, sideEffects: 'read-only; no queue/add, resume, server start or business operation' };
  report.token = command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]::new($i); "
      + "[pscustomobject]@{userSid=$i.User.Value;administrator=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);"
      + "groupSids=@($i.Groups|ForEach-Object Value|Sort-Object)}|ConvertTo-Json -Compress"]);
  report.herdr = command(cfg.herdr, ['--session', process.env.HERDR_SESSION || 'default', 'pane', 'current', '--current']);
  report.codexVersion = command(process.execPath, [cfg.codexJs, '--version']);
  let client;
  try {
    client = await createQueueClient(); report.codexProxy = { connected: true };
    try {
      const thread = await client.readMetadata(target);
      report.threadRead = { ok: true, idMatches: thread.id === target, cwd: thread.cwd, status: thread.status };
    } catch (error) { report.threadRead = { ok: false, code: error.code, message: error.message }; }
    try { report.queueList = { ok: true, count: (await client.list(target)).length }; }
    catch (error) { report.queueList = { ok: false, code: error.code, message: error.message }; }
  } catch (error) {
    report.codexProxy = { connected: false, code: error.code, message: error.message, diagnostic: error.diagnostic };
  } finally { client?.close(); }
  return report;
}

async function main() {
  const args = process.argv.slice(2), target = args[args.indexOf('--target') + 1];
  if (!args.includes('--target') || !/^[0-9a-f-]{36}$/i.test(target)) throw new Error('Provide --target <thread UUID>');
  const output = args.includes('--output') ? path.resolve(args[args.indexOf('--output') + 1]) : null;
  if (output) {
    const relative = path.relative(process.cwd(), output);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Diagnostic output must remain inside the caller working directory');
    }
    const realRelative = path.relative(fs.realpathSync(process.cwd()), fs.realpathSync(path.dirname(output)));
    if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
      throw new Error('Diagnostic output parent resolves outside the caller working directory');
    }
  }
  const report = await diagnose(target), json = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(output, json, { flag: 'wx', mode: 0o600 });
  process.stdout.write(output ? JSON.stringify({ output, herdrExit: report.herdr.exitCode, codexProxy: report.codexProxy }) + '\n' : json);
}

if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { diagnose };
