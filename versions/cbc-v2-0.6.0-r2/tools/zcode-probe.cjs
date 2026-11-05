'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '../.local/zcode-probe');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const env = { ...process.env,
  USERPROFILE: path.join(root, 'profile'),
  APPDATA: path.join(root, 'appdata'),
  LOCALAPPDATA: path.join(root, 'local'),
  ZCODE_HOME: path.join(root, 'profile', '.zcode'),
  ZCODE_STORAGE_DIR: path.join(root, 'storage'),
  ZCODE_DATA_BASE_DIR: path.join(root, 'profile'),
  ZCODE_MODEL_TELEMETRY_ENABLED: '0',
  ELECTRON_RUN_AS_NODE: '1',
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_PROVIDER_FILE || path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/config/provider/zcode-builtin.json'),
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(root, 'profile', 'provider_config.json'),
};
for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ZCODE_HOME', 'ZCODE_STORAGE_DIR', 'ZCODE_DATA_BASE_DIR']) {
  fs.mkdirSync(env[key], { recursive: true });
}
const bundle = process.env.ZCODE_BUNDLE || path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const executable = process.env.ZCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/ZCode.exe');
const child = spawn(executable, [bundle, 'app-server', '--stdio', '--cwd', workspace], {
  env, cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const events = [];
const pending = new Map();
let nextId = 0;
const stderr = fs.createWriteStream(path.join(root, 'stderr.log'));
child.stderr.pipe(stderr);
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const frame = JSON.parse(line);
    events.push(frame);
    if (frame.method === 'session/requestRuntimePreferences' && frame.id !== undefined) {
      // Supply the documented Host callback, without credentials. / 按协议提供 Host 回调，不注入凭据。
      child.stdin.write(`${JSON.stringify({ id: frame.id, result: {
        nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      } })}\n`);
      return;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame);
      pending.delete(frame.id);
    }
  } catch { events.push({ invalidFrame: line.slice(0, 300) }); }
});
child.on('error', error => events.push({ spawnError: error.message }));
child.on('exit', (code, signal) => {
  for (const resolve of pending.values()) resolve({ error: { code, message: `Process exited: ${code}/${signal}` } });
  pending.clear();
});
async function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 18000);
    pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function main() {
  const result = { startedAt: new Date().toISOString(), bundle, executable, isolated: true };
  const resumeOnly = process.argv.includes('--resume-read');
  try {
    result.capabilities = await request('runtime/capabilities', {});
    if (result.capabilities.error) throw new Error(result.capabilities.error.message);
    const command = { commandId: randomUUID(), clientId: 'codex-audit-probe', sessionId: null,
      type: 'createSession', payload: { workspaceId: workspace }, issuedAt: Date.now() };
    let sessionId;
    if (resumeOnly) {
      sessionId = JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).create.result.result.sessionId;
      result.resumedSessionId = sessionId;
    } else {
      result.create = await request('v4/command', command);
      result.duplicate = await request('v4/command', command);
      sessionId = result.create.result?.result?.sessionId;
    }
    if (sessionId) {
      result.subscribe = await request('v4/conversation/subscribe', {
        topic: `conversation/${sessionId}`, connectionId: 'codex-audit-probe', clientMode: 'desktop-continuous',
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!resumeOnly) {
        result.sendText = await request('v4/command', { ...command, commandId: randomUUID(), sessionId,
          type: 'sendText', payload: { text: 'Reply exactly ZCODE_AUDIT_OK. Do not use tools.' } });
        result.stop = await request('v4/command', { ...command, commandId: randomUUID(), sessionId,
          type: 'stop', payload: {} });
      }
    }
  } catch (error) { result.error = error.message; }
  finally {
    child.stdin.end();
    const killer = setTimeout(() => child.kill(), 3000);
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    clearTimeout(killer);
    result.exitCode = child.exitCode;
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, resumeOnly ? 'resume-frames.json' : 'frames.json'), JSON.stringify(events, null, 2));
    fs.writeFileSync(path.join(root, resumeOnly ? 'resume-result.json' : 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
