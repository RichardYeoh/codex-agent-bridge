'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { processAlive } = require('./util');

const DEFAULT_ROOT = path.resolve(__dirname, '../../.local/zcode-relay-leases');

// All bridge entry points share one lease per binding, across business state roots. / 所有桥接入口按远控绑定共享租约，不按业务状态根分割。
function acquire(binding, { root = process.env.AGENT_BRIDGE_ZCODE_LEASE_DIR || DEFAULT_ROOT, alive = processAlive } = {}) {
  const key = crypto.createHash('sha256').update(`${binding.sid}\n${binding.mid}`).digest('hex');
  const directory = path.join(path.resolve(root), `${key}.lock`), ownerFile = path.join(directory, 'owner.json');
  fs.mkdirSync(root, { recursive: true });
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(directory);
      try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: 'wx' }); }
      catch (error) { try { fs.rmdirSync(directory); } catch {} throw error; }
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (current.token !== token || current.pid !== process.pid) return;
          fs.unlinkSync(ownerFile); fs.rmdirSync(directory);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
      if (owner && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) {
        // Remove only the fixed owner file and empty directory; never recurse into computed paths. / 只移除固定归属文件及空目录，不递归删除计算路径。
        const reaper = path.join(path.resolve(root), `${key}.reap`);
        let handle;
        try {
          handle = fs.openSync(reaper, 'wx');
          const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (current.token === owner.token && current.pid === owner.pid && !alive(current.pid)) {
            fs.unlinkSync(ownerFile); fs.rmdirSync(directory);
          }
        } catch (cleanupError) {
          if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
        } finally {
          if (handle !== undefined) { fs.closeSync(handle); fs.unlinkSync(reaper); }
        }
        continue;
      }
      const busy = new Error(`ZCode Relay is already owned by a local bridge${owner?.pid ? ` (PID ${owner.pid})` : ''}; no connection attempted`);
      busy.code = 'ZCODE_RELAY_LOCAL_BUSY'; throw busy;
    }
  }
  throw new Error('ZCode Relay lease changed concurrently; no connection attempted');
}

module.exports = { acquire };
