'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

function buildArgs(task, conversationId) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
  if (conversationId) args.push('--conversation', conversationId);
  if (task.skipPermissions) args.push('--dangerously-skip-permissions');
  else args.push('--mode', task.permissionMode === 'acceptEdits' ? 'accept-edits' : task.permissionMode);
  if (task.model) args.push('--model', task.model);
  if (task.effort) args.push('--effort', task.effort);
  if (task.stateDir) args.push('--add-dir', require('node:path').join(task.stateDir, 'tasks'));
  return args;
}

class AgyClient extends EventEmitter {
  constructor(binary, task, conversationId, { spawnFn = spawn, startupTimeoutMs = 60000 } = {}) {
    super(); this.expectedId = conversationId; this.buffer = ''; this.decoder = new StringDecoder('utf8');
    const script = /\.c?js$/i.test(binary);
    this.child = spawnFn(script ? process.execPath : binary, [...(script ? [binary] : []), ...buildArgs(task, conversationId)],
      { cwd: task.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.timer = setTimeout(() => this.fail('Antigravity initialization timeout; inspect login/connectivity'), startupTimeoutMs);
    this.child.stdout.on('data', bytes => this.receive(bytes));
    // Diagnostics may contain account information; retain only a classified reason. / 诊断可能包含账号信息，仅保留分类原因。
    this.stderrBytes = 0; this.diagnosticReason = null;
    this.child.stderr.on('data', bytes => {
      this.stderrBytes += bytes.length;
      const text = bytes.toString('utf8');
      this.diagnosticReason = require('./blocker').classifyBlocker(text)?.type || this.diagnosticReason;
      if (/soft.denied|permission.*(?:denied|required)|requires approval/i.test(text)) this.permissionDenied = true;
    });
    this.child.on('error', () => this.fail('Antigravity executable could not start'));
    this.child.on('exit', code => this.fail(`Antigravity process exited (${code})`));
    this.child.stdin.on('error', () => this.fail('Antigravity input pipe closed'));
  }

  receive(bytes) {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.fail('Antigravity frame exceeds local limit');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { this.fail('Invalid Antigravity JSON event'); return; }
      const id = event.conversation_id || event.step_update?.conversation_id || event.result?.conversation_id;
      if (id && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)
          || (this.sessionId && id !== this.sessionId) || (this.expectedId && id !== this.expectedId))) {
        this.fail('Antigravity conversation identity changed'); return;
      }
      if (event.event === 'init') {
        if (!id || this.sessionId) { this.fail('Invalid Antigravity initialization'); return; }
        this.sessionId = id; clearTimeout(this.timer); this.readyResolve(id);
      } else if (event.event === 'result') {
        if (!this.pending || !this.sessionId || !id) { this.fail('Unmatched Antigravity result'); return; }
        const pending = this.pending; this.pending = null;
        pending.resolve({ ...event.result, permissionDenied: this.permissionDenied });
      } else if (event.event === 'step_update') {
        const detail = event.step_update?.tool_info;
        if (/soft.denied|permission.*(?:denied|required)|requires approval|user denied/i.test(
          String(detail?.error?.message || '') + '\n' + String(detail?.output || ''))) this.permissionDenied = true;
        this.emit('step', event.step_update);
      }
    }
  }

  prompt(text) {
    if (this.closed || !this.sessionId || this.pending) return Promise.reject(new Error('Antigravity session is unavailable or busy'));
    this.permissionDenied = false; this.diagnosticReason = null;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n'); }
      catch (error) { this.pending = null; reject(error); }
    });
  }

  fail(message) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    const error = new Error(message); error.reason = this.diagnosticReason;
    this.readyReject(error); this.pending?.reject(error); this.pending = null;
    this.emit('fault', error);
  }

  close() { this.child.stdin.end(); }
}

module.exports = { AgyClient, buildArgs };
