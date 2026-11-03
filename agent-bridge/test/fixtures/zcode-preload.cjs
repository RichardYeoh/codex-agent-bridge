'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const modulePath = require.resolve('../../lib/zcode-remote');
const original = require(modulePath);
function record(value) { fs.appendFileSync(process.env.ZCODE_TEST_CALLS, `${JSON.stringify(value)}\n`); }
class Remote extends EventEmitter {
  async connect() { if (process.env.ZCODE_TEST_FORBID_CONNECT) throw new Error('Unexpected connection'); }
  async attachProject() {
    if (process.env.ZCODE_TEST_RECOVERY_FAILURE && fs.existsSync(process.env.ZCODE_TEST_RECOVERY_FAILURE)) throw new Error('ZCode relay KICKED');
  }
  envelope(type, sessionId, payload) { return { type, sessionId, payload, commandId: 'uncertain-original-create' }; }
  async command(envelope) { record(['command', envelope.commandId]); throw new Error('acknowledgement uncertain'); }
  async query(envelope) {
    record(['query', envelope.commandId]);
    return { results: [{ key: { sessionId: envelope.sessionId, commandId: envelope.commandId },
      result: { status: 'accepted', commandId: envelope.commandId, result: { sessionId: 'recovered-original-session' } } }] };
  }
  close() { this.closed = true; }
}
class Conversation extends EventEmitter {
  constructor(remote, sessionId) {
    super(); this.remote = remote;
    this.snapshot = { ...structuredClone(require('./zcode-snapshot.json')), sessionId };
    if (process.env.ZCODE_TEST_RUNNING) this.snapshot.control.activeWorks = [{ sourceCommandId: 'already-running' }];
  }
  async subscribe() { return this.snapshot; }
  async dispose() {}
  async wait() { return new Promise(() => {}); }
}
require.cache[modulePath].exports = { ...original, ZCodeRemote: Remote, Conversation, readBinding: () => ({}) };
