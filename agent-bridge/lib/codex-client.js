'use strict';

const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const WebSocket = require('ws');
const { config } = require('./util');

class CodexRpc {
  constructor() {
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.stderr = '';
    this.child = spawn(process.execPath, [config().codexJs, 'app-server', 'proxy'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-2048); });
    // The daemon control socket speaks WebSocket, not JSONL. / 常驻服务控制通道采用 WebSocket，不是 JSONL。
    const stream = Duplex.from({ readable: this.child.stdout, writable: this.child.stdin });
    this.socket = new WebSocket('ws://localhost/', {
      createConnection: () => stream, handshakeTimeout: 10000,
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.child.once('error', reject);
      this.child.once('exit', code => reject(new Error(`Codex proxy exited ${code}`)));
    });
    this.ready.catch(() => {});
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Codex WebSocket closed')));
    this.socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const waiting = this.pending.get(message.id);
      if (!waiting || message.method) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        waiting.reject(error);
      } else waiting.resolve(message.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Codex proxy exited ${code}: ${this.stderr.trim()}`)));
    this.child.stdin.on('error', error => this.fail(error));
  }

  fail(error) {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params) {
    await this.ready;
    if (this.closed) return Promise.reject(new Error('Codex proxy connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex RPC timeout: ${method}`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.terminate();
    // Only close this proxy client, never the daemon. / 仅关闭本连接，不停止常驻服务。
    const timer = setTimeout(() => this.child.kill(), 1000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}

async function createQueueClient() {
  const rpc = new CodexRpc();
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agent_bridge', title: 'Agent bridge notifications', version: require('../package.json').version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.socket.send(JSON.stringify({ method: 'initialized' }));
  } catch (error) { rpc.close(); throw error; }
  return {
    async list(threadId) {
      const items = [];
      let cursor;
      do {
        const response = await rpc.request('thread/queue/list', { threadId, cursor: cursor || null, limit: 100 });
        items.push(...response.data);
        cursor = response.nextCursor;
      } while (cursor);
      return items;
    },
    async add(threadId, text, clientUserMessageId) {
      try {
        const response = await rpc.request('thread/queue/add', {
          threadId, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }],
        });
        return response.queuedSubmission;
      } catch (error) {
        // A lost reply does not prove the add failed. / 响应丢失不能证明入队失败。
        if (typeof error.code !== 'number') error.deliveryUncertain = true;
        throw error;
      }
    },
    async update(threadId, id, text) {
      return rpc.request('thread/queue/update', {
        threadId, queuedSubmissionId: id, input: [{ type: 'text', text, text_elements: [] }],
      });
    },
    async remove(threadId, id) {
      return rpc.request('thread/queue/delete', { threadId, queuedSubmissionId: id });
    },
    close: () => rpc.close(),
  };
}

module.exports = { createQueueClient };
