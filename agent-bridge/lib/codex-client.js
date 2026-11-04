'use strict';

const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const WebSocket = require('ws');
const { config } = require('./util');

class CodexRpc {
  constructor({ spawnProcess = spawn, Socket = WebSocket, timeoutMs = 10000 } = {}) {
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.opened = false;
    this.timeoutMs = timeoutMs;
    this.stderr = '';
    this.child = spawnProcess(process.execPath, [config().codexJs, 'app-server', 'proxy'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-2048); });
    // The daemon control socket speaks WebSocket, not JSONL. / 常驻服务控制通道采用 WebSocket，不是 JSONL。
    const stream = Duplex.from({ readable: this.child.stdout, writable: this.child.stdin });
    stream.on('error', error => this.fail(error));
    this.socket = new Socket('ws://localhost/', {
      createConnection: () => stream, handshakeTimeout: timeoutMs,
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', () => { this.opened = true; resolve(); });
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
        error.code = message.error.code; error.phase = 'rpc-response'; error.requestSent = true;
        waiting.reject(error);
      } else waiting.resolve(message.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { this.exitCode = code; this.fail(new Error('Codex proxy exited')); });
    this.child.stdin.on('error', error => this.fail(error));
  }

  describeFailure(error, phase) {
    // Keep raw proxy stderr private; only fixed diagnostic categories may leave this client. / 不透传代理原始stderr，仅输出固定诊断分类。
    const denied = /PermissionDenied|拒绝访问|access (?:is )?denied|os error 5|EACCES|EPERM/i.test(this.stderr);
    const failure = new Error(denied ? 'Codex proxy IPC access denied' : 'Codex proxy connection failed');
    failure.code = denied ? 'CODEX_PROXY_ACCESS_DENIED' : error.code || 'CODEX_PROXY_CONNECTION_FAILED';
    failure.phase = phase;
    failure.requestSent = error.requestSent === true;
    failure.diagnostic = { phase, proxyOpened: this.opened, proxyExitCode: this.exitCode ?? null,
      cause: denied ? 'permission-denied' : error.code === 'ECONNRESET' ? 'connection-reset' : 'transport-failed' };
    return failure;
  }

  fail(error) {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.describeFailure({ code: error.code, requestSent: true }, 'rpc-transport'));
    }
    this.pending.clear();
  }

  async request(method, params) {
    try { await this.ready; }
    catch (error) { throw this.describeFailure(error, 'connect'); }
    if (this.closed) throw this.describeFailure(new Error('closed'), 'before-send');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex RPC timeout: ${method}`);
        error.code = 'ETIMEDOUT';
        error.requestSent = true; error.phase = 'rpc-response';
        reject(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.fail(error); });
      } catch (error) { this.fail(error); }
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

async function createQueueClient(options) {
  const rpc = new CodexRpc(options);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agent_bridge', title: 'Agent bridge notifications', version: require('../package.json').version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.socket.send(JSON.stringify({ method: 'initialized' }));
  } catch (error) {
    // A process can report its denial just after the socket reset; wait briefly, never reconnect. / 子进程拒绝信息可能略晚于连接重置，短暂收集诊断而不重连。
    await new Promise(resolve => setTimeout(resolve, 25));
    const failure = typeof error.code === 'number' ? error : rpc.describeFailure(error, rpc.opened ? 'initialize' : 'connect');
    failure.requestSent = false;
    rpc.close(); throw failure;
  }
  return {
    async readMetadata(threadId) {
      const response = await rpc.request('thread/read', { threadId, includeTurns: false });
      return response.thread;
    },
    async list(threadId) {
      const items = [];
      let cursor;
      const seen = new Set();
      do {
        const response = await rpc.request('thread/queue/list', { threadId, cursor: cursor || null, limit: 100 });
        items.push(...response.data);
        cursor = response.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Codex queue pagination repeated a cursor or exceeded 100 pages');
        if (cursor) seen.add(cursor);
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
        if (typeof error.code !== 'number' && error.requestSent !== false) error.deliveryUncertain = true;
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

module.exports = { createQueueClient, CodexRpc };
