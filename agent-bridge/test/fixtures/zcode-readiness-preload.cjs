'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const stateFile = process.env.ZCODE_READY_TEST_STATE;
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = value => fs.writeFileSync(stateFile, JSON.stringify(value));
function record(op, detail = {}) { const value = read(); value.calls.push({ op, ...detail }); write(value); }

// Only isolated file-backed transports are available in this preload. / 本预加载仅提供隔离的文件传输替身。
const herdr = require('../../lib/herdr');
herdr.agentInfo = () => read().agent;
herdr.ensureServer = async () => record('ensure-server');
herdr.startWatcher = () => { record('watcher-start'); return 0; };
herdr.api = (session, args) => {
  const value = read();
  if (session !== 'stub') throw new Error('Unexpected fixture Herdr session');
  value.calls.push({ op: 'herdr', args });
  if (args[0] === 'pane' && args[1] === 'report-agent') {
    value.agent.agent_status = args[args.indexOf('--state') + 1];
    if (value.agent.agent_status !== 'working') value.agent.completion_seq++;
  } else if (args[0] === 'pane' && args[1] === 'send-text') value.pendingText = args[3];
  else if (args[0] === 'pane' && args[1] === 'send-keys' && args[3] === 'enter') {
    fs.appendFileSync(process.env.ZCODE_READY_TEST_INBOX, JSON.stringify(value.pendingText) + '\n');
    delete value.pendingText;
  } else throw new Error('Unexpected fixture terminal operation');
  write(value); return {};
};

const remotePath = require.resolve('../../lib/zcode-remote');
const original = require(remotePath);
class Remote extends EventEmitter {
  constructor() { super(); this.target = {}; }
  async connect() { record('connect'); if (read().connectionError) throw new Error(read().connectionError); }
  async attachProject(cwd, options) {
    record('attach', options); if (options.create) throw new Error('Fixture forbids new native workspace/session');
  }
  envelope(type, sessionId, payload) {
    if (type !== 'sendText') throw new Error('Fixture forbids create/stop');
    return { type, sessionId, commandId: 'new-fixture-command', payload };
  }
  async command(envelope) {
    record('command', { type: envelope.type, commandId: envelope.commandId, modelSelection: envelope.payload.modelSelection });
    if (envelope.type !== 'sendText') throw new Error('Fixture forbids stop/create');
    const value = read(); value.snapshot.control.phase = 'completedSuccess';
    value.snapshot.rows.window = [{ kind: 'turnHeader', rowId: 1, sourceCommandId: envelope.commandId, state: 'completedSuccess' }];
    value.snapshot.seq++; write(value);
    return { commandId: envelope.commandId, status: 'accepted' };
  }
  async query(envelope) {
    record('query', { commandId: envelope.commandId });
    const ack = read().ack;
    return { results: [{ key: { sessionId: envelope.sessionId, commandId: envelope.commandId },
      result: ack === 'unknown' ? 'unknown' : { ...ack, commandId: envelope.commandId } }] };
  }
  async call(_channel, method) {
    record(method);
    if (method !== 'conversationRowsRangeV4') throw new Error('Unexpected fixture RPC');
    const snapshot = read().snapshot;
    return { rows: snapshot.rows.window, hasMore: false, atSeq: snapshot.seq, atLogEpoch: snapshot.logEpoch };
  }
  close() { this.closed = true; record('close'); }
}
class Conversation extends EventEmitter {
  constructor(remote, sessionId) { super(); this.remote = remote; this.sessionId = sessionId; }
  get snapshot() { return read().snapshot; }
  async subscribe() { record('subscribe'); return this.snapshot; }
  async dispose() { record('unsubscribe'); }
  async wait() { return new Promise(() => {}); }
}
require.cache[remotePath].exports = { ...original, ZCodeRemote: Remote, Conversation, readBinding: () => ({}) };
