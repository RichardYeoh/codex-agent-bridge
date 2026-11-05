#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, Store } = require('../lib/events/store');
const { EventService } = require('../lib/events/service');
const { createServer } = require('../lib/events/server');
const { makeGroups, merge, remove } = require('../lib/events/hook-config');
const { writeJsonAtomic } = require('../lib/util');

async function main(argv = process.argv.slice(2), runtime = {}) {
  const [action, ...args] = argv, option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const configFile = option('--config');
  if (!configFile) throw new Error('Provide --config; no global config or credentials are loaded');
  const config = loadConfig(configFile), store = new Store(config.stateDir);
  if (action === 'hooks') {
    const project = path.resolve(option('--project') || path.join(__dirname, '../..'));
    const file = path.join(project, '.codex', 'hooks.json');
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const groups = makeGroups(configFile), result = args.includes('--remove') ? remove(current, groups) : merge(current, groups);
    if (args.includes('--apply')) {
      const backup = path.join(config.stateDir, `hooks-backup-${Date.now()}.json`);
      writeJsonAtomic(backup, { path: file, existed: fs.existsSync(file), before: current });
      writeJsonAtomic(file, result);
      process.stdout.write(JSON.stringify({ applied: true, file, backup, note: 'Review in /hooks; running CLI hot reload is not assumed.' }) + '\n');
    } else process.stdout.write(JSON.stringify({ preview: true, file, config: result }, null, 2) + '\n');
    return;
  }
  if (action !== 'serve') throw new Error('Usage: codex-events <hooks|serve> --config <private-config>');
  // Serving is explicit and loopback-only; no daemon, tunnel, credential creation, or shell tools. / 服务需显式启动且仅监听回环，不创建守护进程、隧道、凭据或shell工具。
  const service = new EventService(config), server = createServer(service, {
    token: runtime.token || process.env.EVENT_BRIDGE_TOKEN, principal: runtime.principal || process.env.EVENT_BRIDGE_PRINCIPAL || 'ydot',
  });
  const owner = path.join(config.stateDir, 'event-server-owner.json');
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  let timer, draining = Promise.resolve(), stopping = false;
  const releaseOwner = () => {
    if (JSON.parse(fs.readFileSync(owner, 'utf8')).pid === process.pid) fs.unlinkSync(owner);
  };
  const close = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    const closed = new Promise(resolve => server.close(resolve));
    await Promise.all([closed, draining]); releaseOwner();
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
  };
  server.on('error', error => { clearInterval(timer); try { fs.unlinkSync(owner); } catch {} process.stderr.write(`Events server failed (${error.code || 'error'}).\n`); process.exitCode = 1; });
  const port = Number(option('--port') || 42589);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { fs.unlinkSync(owner); throw new Error('Invalid loopback port'); }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  process.stdout.write(JSON.stringify({ loopbackOnly: true, port: server.address().port, path: '/mcp' }) + '\n');
  timer = setInterval(() => { if (!service.draining) draining = service.drain().catch(() => process.stderr.write('Event drain failed; records retained.\n')); }, 1000);
  // A local supervisor may own signals and await this close explicitly. / 本地管理入口可接管信号并显式等待本服务关闭。
  if (runtime.manageSignals !== false) { process.once('SIGINT', close); process.once('SIGTERM', close); }
  return { server, service, close };
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
