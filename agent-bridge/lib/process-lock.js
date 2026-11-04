'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

async function acquire(key, timeoutMs = 180000) {
  const canonical = path.resolve(key), hash = crypto.createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Native coordination locks require Windows or Linux');
  // Atomic kernel binding is owned by this Node process; crash releases it without reaping PID files. / 内核原子绑定由当前Node进程持有，崩溃即释放，无须按PID删锁。
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\codex-agent-bridge-' + hash : '\0codex-agent-bridge-' + hash;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen({ path: address, exclusive: true }, resolve);
      });
      server.unref();
      let released = false;
      return () => new Promise((resolve, reject) => {
        if (released) return resolve(); released = true;
        server.close(error => error ? reject(error) : resolve());
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new Error('Timed out acquiring native coordination lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

module.exports = { acquire };
