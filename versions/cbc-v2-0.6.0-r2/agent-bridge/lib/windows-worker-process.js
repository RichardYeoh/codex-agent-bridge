'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_TREE_DEPTH = 8;
const MAX_TREE_PROCESSES = 128;

function processProofError(code, stage = 'process-proof') {
  const error = new Error('Worker process proof could not be confirmed');
  error.guardStage = stage;
  error.processProofCode = code;
  return error;
}

function classifyQueryError(error) {
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ETIME') return 'query-timeout';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'query-access-denied';
  if (error?.code === 'ENOENT') return 'query-unavailable';
  return 'query-failed';
}

function positivePid(value) { return Number.isSafeInteger(value) && value > 0; }
function pathFor(platform) { return platform === 'win32' ? path.win32 : path.posix; }

function normalizedPath(value, platform) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let result = pathFor(platform).normalize(value.trim()).replace(/^\\\\\?\\/, '');
  if (platform === 'win32') result = result.toLowerCase();
  return result;
}

function windowsArgv(commandLine, stopAt = null) {
  if (typeof commandLine !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(commandLine)) return null;
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++;
    if (index >= commandLine.length) break;
    let token = '', quoted = false;
    while (index < commandLine.length && (quoted || !/\s/.test(commandLine[index]))) {
      if (commandLine[index] === '\\') {
        const start = index;
        while (commandLine[index] === '\\') index++;
        const slashes = index - start;
        if (commandLine[index] === '"') {
          token += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2) { token += '"'; index++; }
          else if (quoted && commandLine[index + 1] === '"') { token += '"'; index += 2; }
          else { quoted = !quoted; index++; }
        } else token += '\\'.repeat(slashes);
        continue;
      }
      if (commandLine[index] === '"') {
        if (quoted && commandLine[index + 1] === '"') { token += '"'; index += 2; }
        else { quoted = !quoted; index++; }
        continue;
      }
      token += commandLine[index++];
    }
    if (quoted) return null;
    args.push(token);
    // Only the executable/script prefix identifies the worker; trailing task text is not process identity. / 仅可执行文件与脚本前缀用于身份核验，尾部任务文本不属于进程身份。
    if (stopAt?.(token)) return args;
  }
  return args;
}

const SAFE_NODE_BOOLEAN_FLAGS = new Set([
  '--enable-source-maps', '--no-warnings', '--preserve-symlinks', '--preserve-symlinks-main',
  '--trace-deprecation', '--trace-warnings', '--throw-deprecation',
]);
const SAFE_NODE_VALUE_FLAGS = new Set(['--diagnostic-dir', '--title', '--stack-trace-limit']);

function hasExactScriptArgument(commandLine, expectedExecutable, scriptPath, platform) {
  const executable = normalizedPath(expectedExecutable, platform), expectedScript = normalizedPath(scriptPath, platform);
  const args = windowsArgv(commandLine, token => normalizedPath(token, platform) === expectedScript);
  if (!args?.length || !executable || !expectedScript) return false;
  const argv0 = normalizedPath(args[0], platform);
  const executableName = pathFor(platform).basename(executable).toLowerCase();
  const argv0IsBareNode = !/[\\/]/.test(args[0]) && executableName === 'node.exe'
    && ['node', 'node.exe'].includes(args[0].toLowerCase());
  if (argv0 !== executable && !argv0IsBareNode) return false;
  let index = 1;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') { index++; break; }
    if (!token.startsWith('-')) break;
    const equalAt = token.indexOf('=');
    const flag = equalAt >= 0 ? token.slice(0, equalAt) : token;
    if (SAFE_NODE_BOOLEAN_FLAGS.has(flag) && equalAt < 0) { index++; continue; }
    if (SAFE_NODE_VALUE_FLAGS.has(flag)) {
      if (equalAt >= 0 && token.slice(equalAt + 1)) { index++; continue; }
      if (equalAt < 0 && args[index + 1] && !args[index + 1].startsWith('-')) { index += 2; continue; }
    }
    return false;
  }
  return index < args.length && normalizedPath(args[index], platform) === expectedScript;
}

function processName(record) { return record?.name ?? record?.Name ?? ''; }
function processPid(record) { return record?.pid ?? record?.ProcessId; }
function parentPid(record) { return record?.parentPid ?? record?.ParentProcessId; }
function executablePath(record) { return record?.executablePath ?? record?.ExecutablePath ?? record?.exe; }
function creationTime(record) { return record?.creationTime ?? record?.CreationTime ?? record?.processStartedAt; }
function validCreationTime(value) { return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)); }

function validatedTree(records, shellPid) {
  if (!Array.isArray(records) || records.length > MAX_TREE_PROCESSES) throw new Error('Worker process tree is incomplete');
  const byPid = new Map();
  for (const record of records) {
    const pid = processPid(record), parent = parentPid(record), name = processName(record);
    if (!positivePid(pid) || !positivePid(parent) || pid === shellPid || typeof name !== 'string' || !name) {
      throw new Error('Worker process tree is malformed');
    }
    if (byPid.has(pid)) throw new Error('Worker process tree contains duplicate PIDs');
    byPid.set(pid, record);
  }
  const depths = new Map();
  const depthOf = (pid, visiting = new Set()) => {
    if (pid === shellPid) return 0;
    if (depths.has(pid)) return depths.get(pid);
    if (visiting.has(pid)) throw new Error('Worker process tree contains a cycle');
    const record = byPid.get(pid);
    if (!record) throw new Error('Worker process tree contains a detached process');
    visiting.add(pid);
    const depth = depthOf(parentPid(record), visiting) + 1;
    visiting.delete(pid);
    if (depth > MAX_TREE_DEPTH) throw new Error('Worker process tree exceeds its depth limit');
    depths.set(pid, depth);
    return depth;
  };
  for (const pid of byPid.keys()) depthOf(pid);
  return [...byPid.entries()].map(([pid, record]) => ({
    pid,
    parentPid: parentPid(record),
    depth: depths.get(pid),
    name: processName(record),
    executablePath: executablePath(record),
    creationTime: creationTime(record),
  }));
}

function powershellBinary() { return process.env.AGENT_BRIDGE_POWERSHELL || 'pwsh.exe'; }

function runPowerShell(script, { spawnSyncFn = spawnSync, timeout = 4000 } = {}) {
  const utf8Script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ' + script;
  const result = spawnSyncFn(powershellBinary(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8Script], {
    encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw processProofError(classifyQueryError(result.error), 'process-query');
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '');
    const code = /access is denied|permission denied|unauthorized|access denied/i.test(diagnostic)
      ? 'query-access-denied' : /timed? out|timeout/i.test(diagnostic) ? 'query-timeout' : 'query-failed';
    throw processProofError(code, 'process-query');
  }
  if (typeof result.stdout !== 'string' || !result.stdout.trim()) {
    throw processProofError('query-unreadable', 'process-query');
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw processProofError('query-unreadable', 'process-query'); }
  return parsed;
}

function readWindowsDescendants(shellPid, deps = {}) {
  if (!positivePid(shellPid)) throw new Error('Windows shell PID is unknown');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${shellPid}`,
    '$queue = New-Object System.Collections.Queue',
    '$queue.Enqueue($rootPid)',
    '$levels = @{}; $levels[[string]$rootPid] = 0',
    '$seen = @{}; $seen[[string]$rootPid] = $true',
    '$items = @()',
    `while ($queue.Count -gt 0 -and $items.Count -lt ${MAX_TREE_PROCESSES}) {`,
    '  $parent = [int]$queue.Dequeue()',
    '  $depth = [int]$levels[[string]$parent]',
    `  if ($depth -ge ${MAX_TREE_DEPTH}) { $deeper = @(Get-CimInstance -ClassName Win32_Process -Filter ("ParentProcessId = {0}" -f $parent) -ErrorAction Stop | Select-Object -First 1 ProcessId); if ($deeper.Count -gt 0) { throw "process tree depth limit exceeded" }; continue }`,
    '  $children = @(Get-CimInstance -ClassName Win32_Process -Filter ("ParentProcessId = {0}" -f $parent) -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)',
    '  foreach ($child in $children) {',
    '    $pidValue = [int]$child.ProcessId',
    '    if (-not $seen.ContainsKey([string]$pidValue)) {',
    '      $seen[[string]$pidValue] = $true',
    '      $created = if ($child.CreationDate) { $child.CreationDate.ToUniversalTime().ToString("o") } else { "" }',
    '      $items += [pscustomobject]@{ pid = $pidValue; parentPid = [int]$child.ParentProcessId; depth = $depth + 1; name = [string]$child.Name; executablePath = [string]$child.ExecutablePath; creationTime = $created }',
    '      $levels[[string]$pidValue] = $depth + 1',
    '      $queue.Enqueue($pidValue)',
    '    }',
    '    if ($items.Count -gt ' + MAX_TREE_PROCESSES + ') { throw "process tree limit exceeded" }',
    '  }',
    '}',
    'if ($queue.Count -gt 0) { throw "process tree limit exceeded" }',
    'ConvertTo-Json -InputObject @($items) -Compress -Depth 3',
  ].join('\n');
  const value = runPowerShell(script, deps);
  const records = value == null ? [] : Array.isArray(value) ? value : [value];
  return validatedTree(records, shellPid);
}

function readWindowsCommandLine(pid, deps = {}) {
  if (!positivePid(pid)) throw new Error('Windows process PID is unknown');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$targetPid = ${pid}`,
    '$item = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $targetPid) -ErrorAction Stop | Select-Object -First 1 ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate',
    'if ($null -eq $item) { throw "target process is absent" }',
    '$created = if ($item.CreationDate) { $item.CreationDate.ToUniversalTime().ToString("o") } else { "" }',
    '$value = [pscustomobject]@{ ProcessId = [int]$item.ProcessId; ParentProcessId = [int]$item.ParentProcessId; Name = [string]$item.Name; ExecutablePath = [string]$item.ExecutablePath; CommandLine = [string]$item.CommandLine; CreationTime = $created }',
    'ConvertTo-Json -InputObject $value -Compress -Depth 3',
  ].join('\n');
  const value = runPowerShell(script, deps);
  if (!value || !positivePid(value.ProcessId) || value.ProcessId !== pid || typeof value.CommandLine !== 'string'
      || !validCreationTime(value.CreationTime)) {
    throw processProofError('process-missing-or-unreadable', 'target-process-query');
  }
  return { pid: value.ProcessId, parentPid: value.ParentProcessId, name: value.Name,
    executablePath: value.ExecutablePath, commandLine: value.CommandLine, creationTime: value.CreationTime };
}

function isPowerShell(record) { return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(processName(record)); }

function processProof(kind, pid, parent, shellPid, depth, name, startedAt) {
  return Object.freeze({ kind, pid, parentPid: parent, shellPid, depth, processName: name, processStartedAt: startedAt });
}

async function scriptProcessMatches(item, scriptPath, expectedPath, platform, deps) {
  let command;
  try {
    command = deps.readCommandLine ? await deps.readCommandLine(item.pid)
      : platform === 'win32' ? readWindowsCommandLine(item.pid, deps) : null;
  } catch (error) {
    if (error?.processProofCode) throw error;
    throw processProofError(classifyQueryError(error), 'target-process-query');
  }
  const commandLine = typeof command?.commandLine === 'string' ? command.commandLine : null;
  if (!commandLine || !validCreationTime(creationTime(command))
      || creationTime(command) !== item.creationTime || parentPid(command) !== item.parentPid
      || normalizedPath(executablePath(command), platform) !== expectedPath) {
    throw processProofError('process-identity-changed', 'target-process-query');
  }
  return hasExactScriptArgument(commandLine, expectedPath, scriptPath, platform);
}

async function proveWorkerProcessInternal({ kind, processInfo, expectedPid, executablePath: expectedExecutable,
  scriptPath } = {}, deps = {}) {
  if (!['cbc', 'zcode-wrapper'].includes(kind)) throw new Error('Unsupported guarded worker process kind');
  if (!processInfo || typeof processInfo !== 'object' || !positivePid(processInfo.shell_pid)) {
    throw new Error('Herdr process information is incomplete');
  }
  const platform = deps.platform || process.platform;
  const shellPid = processInfo.shell_pid;
  const foreground = processInfo.foreground_processes;
  if (!Array.isArray(foreground) || foreground.length === 0) throw new Error('Herdr foreground process is unknown');

  const expectedPath = normalizedPath(expectedExecutable, platform);
  if (!expectedPath) throw new Error('Expected worker executable is not configured');
  const direct = foreground.filter(item => {
    const executable = normalizedPath(executablePath(item), platform);
    return executable === expectedPath && positivePid(processPid(item));
  });
  if (kind === 'cbc' && direct.length === 1 && validCreationTime(creationTime(direct[0]))) {
    const item = direct[0];
    if (scriptPath && !await scriptProcessMatches({ pid: processPid(item), parentPid: parentPid(item) ?? shellPid,
      creationTime: creationTime(item) }, scriptPath, expectedPath, platform, deps)) {
      throw new Error('CBC foreground script identity is unconfirmed');
    }
    return processProof(kind, processPid(item), parentPid(item) ?? shellPid, shellPid, 1, processName(item), creationTime(item));
  }
  if (direct.length > 1) throw new Error('Worker foreground process is ambiguous');
  const shells = foreground.filter(isPowerShell);
  if (shells.length !== 1 || foreground.length !== 1
      || (positivePid(processPid(shells[0])) && processPid(shells[0]) !== shellPid)) {
    throw new Error('Herdr does not show the expected worker shell');
  }
  let descendants;
  try {
    descendants = deps.readDescendants
      ? await deps.readDescendants(shellPid)
      : platform === 'win32' ? readWindowsDescendants(shellPid, deps) : null;
  } catch (error) {
    if (error?.processProofCode) throw error;
    throw processProofError(classifyQueryError(error), 'process-query');
  }
  const tree = validatedTree(descendants, shellPid);

  if (kind === 'cbc') {
    const candidates = tree.filter(item => normalizedPath(item.executablePath, platform) === expectedPath
      && (expectedPid == null || item.pid === expectedPid));
    if (!candidates.length || candidates.some(item => !validCreationTime(item.creationTime))) {
      throw new Error('CBC foreground process is absent or ambiguous');
    }
    if (scriptPath) {
      const matches = [];
      for (const candidate of candidates) {
        if (await scriptProcessMatches(candidate, scriptPath, expectedPath, platform, deps)) matches.push(candidate);
      }
      if (matches.length !== 1) throw new Error('CBC foreground script identity is absent or ambiguous');
      return processProof(kind, matches[0].pid, matches[0].parentPid, shellPid, matches[0].depth,
        matches[0].name, matches[0].creationTime);
    }
    if (candidates.length !== 1) throw new Error('CBC foreground process is ambiguous');
    const match = candidates[0];
    return processProof(kind, match.pid, match.parentPid, shellPid, match.depth, match.name, match.creationTime);
  }

  if (!positivePid(expectedPid) || typeof scriptPath !== 'string' || !scriptPath.trim()) {
    throw new Error('Exact ZCode wrapper identity is required');
  }
  const matches = tree.filter(item => item.pid === expectedPid && normalizedPath(item.executablePath, platform) === expectedPath);
  if (matches.length !== 1 || !validCreationTime(matches[0]?.creationTime)
      || !/^(?:node|node\.exe)$/i.test(pathFor(platform).basename(matches[0]?.name || ''))) {
    throw new Error('Exact ZCode wrapper process is absent or ambiguous');
  }
  if (!await scriptProcessMatches(matches[0], scriptPath, expectedPath, platform, deps)) {
    throw new Error('Exact ZCode wrapper script identity is unconfirmed');
  }
  return processProof(kind, matches[0].pid, matches[0].parentPid, shellPid, matches[0].depth,
    matches[0].name, matches[0].creationTime);
}

async function proveWorkerProcess(input, deps = {}) {
  try { return await proveWorkerProcessInternal(input, deps); }
  catch (error) {
    if (!error.processProofCode) error.processProofCode = 'identity-unconfirmed';
    if (!error.guardStage) error.guardStage = 'process-proof';
    throw error;
  }
}

module.exports = { proveWorkerProcess, readWindowsDescendants };
