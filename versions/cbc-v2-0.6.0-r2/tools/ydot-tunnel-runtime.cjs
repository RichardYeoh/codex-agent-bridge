'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { loadConfig, canonical, digest } = require('../agent-bridge/lib/events/store');

function readBinding(root) {
  const base = fs.realpathSync(root);
  const within = relative => {
    const resolved = fs.realpathSync(path.resolve(base, relative));
    if (!resolved.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw new Error('Binding path outside this project');
    return resolved;
  };
  const file = within('.local/ydot-secure-tunnel-20261031/binding.json');
  const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (binding.version !== 1) throw new Error('Unsupported binding');
  for (const name of ['client', 'profile', 'bridgeConfig']) {
    const entry = binding[name];
    entry.file = within(entry.relativePath);
    if (digest(fs.readFileSync(entry.file)) !== entry.sha256) throw new Error(`Changed ${name}; review and rebind before starting`);
  }
  const config = loadConfig(binding.bridgeConfig.file);
  if (config.targets.length !== 1 || canonical(config.targets.map(({ directoryKey, ...target }) => target)) !== canonical(binding.targets)) {
    throw new Error('Target allowlist differs from the approved single-owner binding');
  }
  const state = fs.realpathSync(config.stateDir);
  if (!state.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw new Error('Bridge state outside this project');
  return { ...binding, config, localDir: path.dirname(file) };
}

function runtimeEnvironment(source, key, tunnelId, bridgeToken, profiles) {
  const env = {};
  // Do not inherit existing API keys, tool configs, or unsafe logging overrides. / 不继承既有API密钥、工具配置或不安全日志覆盖。
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']) if (source[name]) env[name] = source[name];
  return { ...env, CONTROL_PLANE_API_KEY: key, CONTROL_PLANE_TUNNEL_ID: tunnelId,
    EVENT_BRIDGE_AUTHORIZATION: `Bearer ${bridgeToken}`, TUNNEL_CLIENT_PROFILE_DIR: profiles,
    LOG_HTTP_RAW_UNSAFE: 'false' };
}

const REASONS = new Set(['activation_paused', 'doctor_output_invalid', 'doctor_failed', 'client_failed', 'credential_input_invalid',
  'credential_input_too_large', 'credential_input_required', 'startup_unconfirmed']);
class RuntimeFailure extends Error {
  constructor(reason) { super('Tunnel runtime failed'); this.reason = REASONS.has(reason) ? reason : 'runtime_failed'; }
}
function failureStatus(error) {
  const codes = new Map([['EEXIST', 'owner_or_file_exists'], ['EACCES', 'access_denied'], ['EPERM', 'access_denied'], ['EADDRINUSE', 'port_in_use'], ['ENOENT', 'required_file_missing']]);
  return { phase: 'runtime-error', reason: error instanceof RuntimeFailure && REASONS.has(error.reason) ? error.reason : codes.get(error?.code) || 'runtime_failed' };
}
function discardClientOutput(stream) {
  // Never decode, reconstruct, relay, or persist raw client logs, including stderr. / 原始客户端日志包含stderr，一律不解码、拼接、转发或落盘。
  stream.on('error', () => {}); stream.resume();
}
const CHECK_IDS = new Set(['config_source', 'profile_load', 'control_plane_api_key', 'tunnel_id', 'tunnels_management_url', 'runtime_api_keys_url',
  'admin_api_keys_url', 'chatgpt_connector_settings_url', 'mcp_target', 'mcp_server_reachable', 'oauth_metadata', 'health_listener', 'ui', 'codex_plugin', 'config_validation']);
function doctorStatus(report) {
  const statuses = new Set(['PASS', 'FAIL', 'SKIP', 'WARN']);
  return { phase: 'doctor', result: ['ok', 'fail'].includes(report?.result) ? report.result : 'unknown',
    checks: Array.isArray(report?.checks) ? report.checks.slice(0, 32).map(c => ({
      id: CHECK_IDS.has(c?.id) ? c.id : 'other_check', status: statuses.has(c?.status) ? c.status : 'UNKNOWN',
    })) : [] };
}

function doctorSucceeded(code, report) {
  // The official 0.0.19 success value is "ok", not "pass". / 官方0.0.19成功值为ok，不是pass。
  return code === 0 && report?.result === 'ok' && Array.isArray(report.checks) && !report.checks.some(c => c?.status === 'FAIL');
}

async function start(root, credentials, { bridgePort = 42589, fixtureToken, spawnClient = spawn } = {}) {
  const binding = readBinding(root);
  if (binding.activationApproved !== true) throw new RuntimeFailure('activation_paused');
  const { tunnelId, runtimeKey } = credentials;
  if (!/^tunnel_[A-Za-z0-9_-]{16,128}$/.test(tunnelId || '')) throw new Error('Enter the real Tunnel ID from Platform');
  if (binding.tunnelId && binding.tunnelId !== tunnelId) throw new Error('Tunnel ID differs from the user-selected dedicated binding');
  if (typeof runtimeKey !== 'string' || runtimeKey.length < 20 || runtimeKey.length > 4096 || /\s/.test(runtimeKey) || runtimeKey.startsWith('sk-admin-')) throw new Error('Provide a dedicated runtime key, never an admin key');
  const owner = path.join(binding.localDir, 'runtime-owner.json');
  const ownerFd = fs.openSync(owner, 'wx', 0o600);
  fs.writeFileSync(ownerFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tunnelId })); fs.closeSync(ownerFd);
  const bridgeToken = fixtureToken || crypto.randomBytes(48).toString('base64url');
  const env = runtimeEnvironment(process.env, runtimeKey, tunnelId, bridgeToken, path.join(binding.localDir, 'profiles'));
  let bridge, client, timer, stopping = false, readyConfirmed = false, shutdown;
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true; clearInterval(timer);
    shutdown = (async () => {
      // Kill only the exact child created here; never touch the owner Codex or shared daemon. / 只停止本入口创建的精确子进程，不动主控Codex或共享服务。
      if (client?.pid && client.exitCode === null && client.signalCode === null) {
        const exited = once(client, 'exit'); client.kill(); await exited.catch(() => {});
      }
      if (bridge) await bridge.close();
    })();
    return shutdown;
  };
  const report = value => process.stdout.write(JSON.stringify(value) + '\n');
  const onSignal = () => { stop().catch(() => { process.stderr.write('Local runtime cleanup failed; inspect its ownership files.\n'); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    bridge = await require('../agent-bridge/bin/codex-events').main(['serve', '--config', binding.bridgeConfig.file, '--port', String(bridgePort)], { token: bridgeToken, manageSignals: false });
    if (stopping) { await bridge.close(); return; }
    const doctor = spawnClient(binding.client.file, ['doctor', '--profile-file', binding.profile.file, '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    client = doctor;
    let output = '';
    doctor.stdout.on('data', chunk => { output = (output + chunk).slice(-1048576); });
    discardClientOutput(doctor.stderr);
    const deadline = setTimeout(() => doctor.kill(), 20000);
    let code;
    try { [code] = await once(doctor, 'exit'); } finally { clearTimeout(deadline); }
    if (stopping) return;
    let checks;
    try { checks = JSON.parse(output); } catch { throw new RuntimeFailure('doctor_output_invalid'); }
    report(doctorStatus(checks));
    if (!doctorSucceeded(code, checks)) throw new RuntimeFailure('doctor_failed');
    client = spawnClient(binding.client.file, ['run', '--profile-file', binding.profile.file, '--log.http-raw-unsafe=false'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const currentClient = client;
    fs.writeFileSync(path.join(binding.localDir, 'runtime-status.json'), JSON.stringify({ pid: process.pid, clientPid: client.pid, tunnelId, ready: false, startedAt: new Date().toISOString() }));
    for (const stream of [client.stdout, client.stderr]) discardClientOutput(stream);
    const deadlineAt = Date.now() + 60000;
    let checking = false;
    timer = setInterval(async () => {
      if (checking || stopping) return; checking = true;
      try {
        const response = await fetch('http://127.0.0.1:42590/readyz', { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (response.status === 200 && !stopping) {
          readyConfirmed = true; clearInterval(timer);
          fs.writeFileSync(path.join(binding.localDir, 'runtime-status.json'), JSON.stringify({ pid: process.pid, clientPid: currentClient.pid, tunnelId, ready: true, readyAt: new Date().toISOString() }));
          report({ phase: 'tunnel-ready', tunnelId, localMcp: 'http://127.0.0.1:42589/mcp', health: 'http://127.0.0.1:42590/readyz', cloudSubscription: 'not established by this launcher' });
        }
      } catch {}
      finally { checking = false; }
      if (!stopping && !readyConfirmed && Date.now() > deadlineAt) {
        report({ phase: 'startup-unconfirmed', reason: 'readiness not confirmed within 60 seconds; stopping only this runtime' }); await stop();
      }
    }, 2000);
    [code] = await once(client, 'exit');
    if (!stopping && code !== 0) throw new RuntimeFailure('client_failed');
  } finally {
    await stop(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    if (JSON.parse(fs.readFileSync(owner, 'utf8')).pid === process.pid) fs.unlinkSync(owner);
    report({ phase: 'local-runtime-stopped', note: 'Disconnect the plugin and revoke its subscription/Tunnel/key separately when retiring this channel.' });
  }
}

async function main({ root = path.resolve(__dirname, '..'), argv = process.argv.slice(2), input = process.stdin } = {}) {
  if (argv.includes('--check')) {
    const binding = readBinding(root);
    process.stdout.write(JSON.stringify({ bindingValid: true, targets: binding.config.targets.length, clientHashVerified: true, profileHashVerified: true,
      activationApproved: binding.activationApproved === true, startsServices: false, requiresSecrets: false }) + '\n'); return;
  }
  if (input.isTTY) throw new RuntimeFailure('credential_input_required');
  const chunks = []; let size = 0;
  for await (const chunk of input) { size += chunk.length; if (size > 16384) throw new RuntimeFailure('credential_input_too_large'); chunks.push(chunk); }
  let credentials;
  try { credentials = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RuntimeFailure('credential_input_invalid'); }
  await start(root, credentials);
}
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify(failureStatus(error)) + '\n'); process.exitCode = 1; });
module.exports = { readBinding, runtimeEnvironment, discardClientOutput, failureStatus, doctorStatus, doctorSucceeded, RuntimeFailure, main, start };
