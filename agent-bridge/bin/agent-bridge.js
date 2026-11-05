'use strict';

if (require.main !== module) {
  module.exports = require('./agent-bridge-v1');
} else {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');

  const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
  const RELEASE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  const BOOLEAN_OPTIONS = new Set([
    'json', 'force', 'retry-failed', 'trust-folder', 'no-skip-permissions', 'resend-notification',
    'new-workspace', 'new-session', 'full-context', 'parallel',
  ]);
  const TASK_COMMANDS = new Set([
    'ack', 'abandon', 'accept', 'adopt-restored', 'adopt-zcode', 'cancel', 'diagnose-zcode-admission',
    'diagnose-zcode-terminal', 'message', 'message-reconcile', 'message-retire', 'message-status',
    'observe', 'read', 'reconcile-submission', 'recover', 'resume', 'rework', 'settle', 'status',
  ]);
  const GLOBAL_COMMANDS = new Set(['agents', 'list', 'notifications', 'sessions']);

  function fail(message) {
    throw new Error(message);
  }

  function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  function isReparsePoint(stats) {
    return stats.isSymbolicLink() || (Number.isInteger(stats.attributes) && (stats.attributes & 0x400) !== 0);
  }

  function pathComponents(absolute) {
    const parsed = path.parse(absolute);
    const result = [parsed.root];
    let current = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      result.push(current);
    }
    return result;
  }

  function inspectRegularPath(file, { base = null, finalKind = 'file', allowMissing = false } = {}) {
    const absolute = path.resolve(file);
    const components = pathComponents(absolute);
    let startIndex = 0;
    if (base) {
      const absoluteBase = path.resolve(base);
      if (!isWithin(absoluteBase, absolute)) fail('Configured path escapes its allowed root');
      startIndex = components.indexOf(absoluteBase);
      if (startIndex < 0) fail('Configured path has an invalid root');
    }

    for (let index = startIndex; index < components.length; index += 1) {
      const current = components[index];
      let stats;
      try {
        stats = fs.lstatSync(current);
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') return null;
        throw error;
      }
      if (isReparsePoint(stats)) fail(`Symbolic link or reparse point is not allowed: ${current}`);
      const final = index === components.length - 1;
      if (!final && !stats.isDirectory()) fail(`Path ancestor is not a directory: ${current}`);
      if (final && finalKind === 'file' && !stats.isFile()) fail(`Expected a regular file: ${current}`);
      if (final && finalKind === 'directory' && !stats.isDirectory()) fail(`Expected a directory: ${current}`);
    }
    return absolute;
  }

  function parseArgs(args) {
    const options = { _: [] };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg.startsWith('--')) {
        options._.push(arg);
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_OPTIONS.has(key)) options[key] = true;
      else options[key] = args[++index];
    }
    return options;
  }

  function stateRoot() {
    if (process.env.AGENT_BRIDGE_STATE_DIR) return path.resolve(process.env.AGENT_BRIDGE_STATE_DIR);
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'agent-bridge');
    return null;
  }

  function taskFile(taskId) {
    if (!TASK_ID.test(taskId || '')) fail('Invalid task ID; refusing legacy fallback');
    const root = stateRoot();
    if (!root) fail('State root is unavailable; refusing legacy fallback for a task ID');
    const absoluteRoot = path.resolve(root);
    const realRoot = fs.existsSync(absoluteRoot) ? fs.realpathSync.native(absoluteRoot) : absoluteRoot;
    if (process.platform === 'win32'
        ? realRoot.toLowerCase() !== absoluteRoot.toLowerCase()
        : realRoot !== absoluteRoot) fail('State root resolves through a link; refusing legacy fallback');
    const file = path.join(absoluteRoot, 'tasks', taskId, 'task.json');
    return inspectRegularPath(file, { base: absoluteRoot, finalKind: 'file', allowMissing: true });
  }

  function readTask(taskId) {
    const file = taskFile(taskId);
    if (!file) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.id !== taskId
          || (saved.taskProtocol !== undefined && ![1, 2].includes(saved.taskProtocol))) {
        fail(`Task ${taskId} has an unknown or invalid protocol marker; refusing legacy fallback`);
      }
      return saved;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail(`Cannot safely inspect task ${taskId}; refusing legacy fallback: ${error.message}`);
    }
  }

  function anyV2TaskExists() {
    const root = stateRoot();
    if (!root) fail('State root is unavailable; refusing an unbounded recover scan');
    const absoluteRoot = path.resolve(root);
    if (!fs.existsSync(absoluteRoot)) return false;
    const tasks = inspectRegularPath(path.join(absoluteRoot, 'tasks'), { base: absoluteRoot, finalKind: 'directory', allowMissing: true });
    if (!tasks) return false;
    for (const entry of fs.readdirSync(tasks, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('Cannot safely scan mixed-version tasks; recover requires a task ID');
      if (!TASK_ID.test(entry.name)) continue;
      const saved = readTask(entry.name);
      if (saved?.taskProtocol === 2) return true;
    }
    return false;
  }

  function readConfig() {
    const file = path.join(__dirname, 'layered-release.json');
    let regular;
    try {
      regular = inspectRegularPath(file, { base: __dirname, finalKind: 'file', allowMissing: true });
    } catch (error) {
      return { state: 'invalid', error };
    }
    if (!regular) return { state: 'missing' };
    try {
      const stats = fs.statSync(regular);
      if (stats.size > 64 * 1024) fail('layered-release.json is oversized');
      const value = JSON.parse(fs.readFileSync(regular, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabledCBC !== 'boolean'
          || typeof value.currentRelease !== 'string' || !RELEASE_ID.test(value.currentRelease)
          || !value.releases || typeof value.releases !== 'object' || Array.isArray(value.releases)) {
        fail('layered-release.json has an invalid shape');
      }
      for (const [id, entry] of Object.entries(value.releases)) {
        if (!RELEASE_ID.test(id) || typeof entry !== 'string' || !entry.length || path.isAbsolute(entry)) {
          fail('layered-release.json contains an invalid release entry');
        }
      }
      return { state: 'valid', value };
    } catch (error) {
      return { state: 'invalid', error };
    }
  }

  function runtimeEntry(config, releaseId) {
    const entry = config.releases[releaseId];
    if (!entry) fail(`Runtime release is not configured: ${releaseId}`);
    const projectRoot = path.resolve(__dirname, '..', '..');
    const realRoot = fs.realpathSync.native(projectRoot);
    if (process.platform === 'win32'
        ? realRoot.toLowerCase() !== projectRoot.toLowerCase()
        : realRoot !== projectRoot) fail('Project root resolves through a link or reparse point');
    const target = path.resolve(projectRoot, entry);
    if (!isWithin(projectRoot, target)) fail('Runtime entry escapes the engineering project');
    inspectRegularPath(target, { base: projectRoot, finalKind: 'file' });
    return target;
  }

  function canonicalAgent(value) {
    const agentModule = path.join(__dirname, '..', 'lib', 'agents.js');
    const { getAgent } = require(agentModule);
    return getAgent(value || 'cbc').id;
  }

  function childExecArgv(execArgv) {
    const result = [];
    for (let index = 0; index < execArgv.length; index += 1) {
      const argument = execArgv[index];
      if (/^--inspect(?:-|=|$)/.test(argument)) {
        // Do not duplicate inspector listeners across router and child processes. / 避免路由器与子进程重复监听调试端口。
        if (['--inspect-port', '--inspect-publish-uid'].includes(argument)) index += 1;
        continue;
      }
      result.push(argument);
    }
    return result;
  }

  function invoke(entry, args, releaseId = null) {
    const env = { ...process.env };
    // The selected entry owns enrollment; inherited flags cannot bypass rollback. / 协议登记归选定入口，继承环境不能绕过回滚。
    delete env.AGENT_BRIDGE_TASK_PROTOCOL;
    if (releaseId) env.AGENT_BRIDGE_RELEASE_ID = releaseId;
    else delete env.AGENT_BRIDGE_RELEASE_ID;
    // Preserve caller preloads and other safe Node options; never inject NODE_OPTIONS globally. / 保留调用方预加载及其他安全Node参数，不全局注入NODE_OPTIONS。
    const result = spawnSync(process.execPath, [...childExecArgv(process.execArgv), entry, ...args], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) fail(`Could not start CLI entry: ${result.error.message}`);
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  }

  function route() {
    const legacy = path.join(__dirname, 'agent-bridge-v1.js');
    const args = process.argv.slice(2);
    const command = args[0] || '';
    const parsed = parseArgs(args.slice(1));

    if (GLOBAL_COMMANDS.has(command)) {
      invoke(legacy, args);
      return;
    }

    if (command === 'recover' && !parsed._[0]) {
      if (anyV2TaskExists()) fail('recover requires a task ID when V2 tasks are present; refusing a mixed-version scan');
      invoke(legacy, args);
      return;
    }

    let taskId = TASK_COMMANDS.has(command) ? parsed._[0] : null;
    if (command === 'dispatch') taskId = parsed['task-id'] || null;
    const existingTask = taskId ? readTask(taskId) : null;
    if (existingTask?.taskProtocol === 2) {
      const release = readConfig();
      if (release.state !== 'valid') fail(`V2 task routing is unavailable (${release.state}${release.error ? `: ${release.error.message}` : ''}); refusing legacy fallback`);
      const releaseId = existingTask.runtimeReleaseId || release.value.currentRelease;
      try {
        invoke(runtimeEntry(release.value, releaseId), args, releaseId);
      } catch (error) {
        fail(`V2 task runtime is unavailable: ${error.message}; refusing legacy fallback`);
      }
      return;
    }

    if (command === 'dispatch' && !existingTask) {
      let agentId = null;
      try {
        agentId = canonicalAgent(parsed.agent || 'cbc');
      } catch {
        invoke(legacy, args);
        return;
      }
      if (agentId === 'cbc') {
        const release = readConfig();
        if (release.state === 'invalid') fail(`CBC release configuration is invalid: ${release.error.message}`);
        if (release.state === 'valid' && release.value.enabledCBC) {
          const releaseId = release.value.currentRelease;
          try {
            invoke(runtimeEntry(release.value, releaseId), args, releaseId);
          } catch (error) {
            fail(`CBC runtime release is unavailable: ${error.message}`);
          }
          return;
        }
      }
    }

    invoke(legacy, args);
  }

  try {
    route();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, code: 'AGENT_BRIDGE_ROUTER_ERROR' })}\n`);
    process.exitCode = 1;
  }
}
