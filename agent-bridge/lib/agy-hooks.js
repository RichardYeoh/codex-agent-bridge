'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AgyClient } = require('./agy-client');
const { spawnSync } = require('node:child_process');
const { config, readJson, writeJsonAtomic, ensureDir, now } = require('./util');
const KEY = 'codex-agent-bridge-agy';

function hookDefinition(executable, quoted = true) {
  const hook = path.join(config().root, 'hooks', 'herdr-agy.js');
  const command = name => ({ type: 'command', command: executable
    ? `${executable} ${quoted ? '"' + hook + '"' : hook} ${name}`
    : `node codex-agent-bridge-agy.cjs ${name}`, timeout: 8 });
  return { SessionStart: [command('SessionStart')], PreInvocation: [command('PreInvocation')], Stop: [command('Stop')],
    PreToolUse: [{ matcher: 'ask_permission|notify_user|ask_user|ask_question', hooks: [command('PreToolUse')] }] };
}

function ensureHooks(task) {
  const file = path.join(task.cwd, '.agents', 'hooks.json');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  // Local hook bindings can reveal machine paths; warn without changing the business ignore policy. / 本机Hook绑定含机器路径，仅提示而不更改业务忽略策略。
  const ignored = ['.agents/hooks.json', '.agents/codex-agent-bridge-agy.cjs'].every(name => {
    const result = spawnSync('git', ['check-ignore', '--quiet', name], { cwd: task.cwd, windowsHide: true, encoding: 'utf8', timeout: 3000 });
    return !result.error && result.status === 0;
  });
  if (!ignored) {
    task.warnings ||= [];
    const warning = 'AGY local Hook binding contains machine paths; verify .agents/hooks.json and .agents/codex-agent-bridge-agy.cjs are excluded from publication';
    if (!task.warnings.includes(warning)) task.warnings.push(warning);
  }
  const value = original === null ? {} : JSON.parse(original);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project .agents/hooks.json must be an object');
  const expected = hookDefinition();
  const same = definition => JSON.stringify(value[KEY]) === JSON.stringify(definition);
  const legacy = executable => {
    const definition = hookDefinition(executable);
    definition.PreToolUse[0].matcher = 'ask_permission|notify_user|ask_user';
    return definition;
  };
  if (value[KEY] && !same(expected) && !same(legacy('node')) && !same(legacy(`"${process.execPath}"`))) {
    throw new Error('Project agent-bridge agy hook was changed; inspect before replacing it');
  }
  const shim = path.join(task.cwd, '.agents', 'codex-agent-bridge-agy.cjs');
  const source = '// Local bridge binding; do not commit. / 本机桥接绑定，不提交到业务仓库。\n'
    + `require(${JSON.stringify(path.join(config().root, 'hooks', 'herdr-agy.js'))});\n`;
  if (fs.existsSync(shim) && fs.readFileSync(shim, 'utf8') !== source) throw new Error('Project agy Hook binding was changed; inspect before replacing it');
  ensureDir(path.dirname(shim));
  if (!fs.existsSync(shim)) fs.writeFileSync(shim, source);
  if (value[KEY] && same(expected)) return;
  if (original !== null) {
    const name = crypto.createHash('sha256').update(file + original).digest('hex');
    const backup = path.join(ensureDir(path.join(task.stateDir, 'hook-backups')), name + '.json');
    fs.writeFileSync(backup, original);
  }
  if (original !== null && fs.readFileSync(file, 'utf8') !== original) throw new Error('Project hook file changed concurrently');
  writeJsonAtomic(file, { ...value, [KEY]: expected });
}

async function prepareWorker(task, resumeId) {
  ensureHooks(task);
  if (!/\.c?js$/i.test(config().agy)) {
    const version = spawnSync(config().agy, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (!version.error && version.status === 0 && version.stdout.trim() === '1.4.10') {
      // Only the validated version gets deterministic TUI delivery keys. / 仅对已验证版本设置确定的TUI投递按键。
      task.agyDeliveryProfile = { version: '1.4.10', queuedMessages: 'queue', immediateKey: 'alt+m' };
    }
  }
  const client = new AgyClient(config().agy, task, resumeId);
  try {
    const id = await client.ready;
    // Verify metadata only: no prompt or model turn is sent by the preflight. / 仅核验元数据，预检不发送提示或触发模型轮次。
    const exited = new Promise((resolve, reject) => {
      client.child.once('exit', code => code === 0 ? resolve() : reject(new Error('Antigravity preflight did not exit cleanly')));
    });
    client.close();
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Antigravity preflight exit timeout')), 5000); })]); }
    finally { clearTimeout(timer); }
    task.workerSessionId = id;
    fs.appendFileSync(path.join(task.stateDir, 'hook-events.ndjson'), JSON.stringify({
      timestamp: now(), name: 'SessionStart', source: 'agy-cli-preflight', sessionId: id,
      taskId: task.id, herdrSession: task.herdrSession, paneId: task.paneId,
    }) + '\n');
  } finally { if (client.child.exitCode === null) client.child.kill(); }
}

module.exports = { ensureHooks, hookDefinition, prepareWorker, KEY };
