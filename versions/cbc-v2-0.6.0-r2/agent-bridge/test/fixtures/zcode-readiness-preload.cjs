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
function task() {
  return JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BRIDGE_STATE_DIR, 'tasks', process.env.AGENT_BRIDGE_TASK_ID, 'task.json'), 'utf8'));
}
herdr.agentInfo = (_session, paneId) => {
  const value = read(), current = task();
  if (value.closedPane) throw new Error('Fixture Pane is closed');
  if (value.agentAbsent) return null;
  if (value.omitNativeSession) { const agent = { ...value.agent }; delete agent.agent_session; return agent; }
  return { agent: 'zcode', pane_id: paneId, terminal_id: value.agent.terminal_id || current.terminalId,
    agent_session: { value: value.agent.agent_session?.value ?? current.workerSessionId ?? null }, ...value.agent };
};
herdr.paneInfo = (_session, paneId) => {
  const value = read(), current = task();
  if (value.closedPane) throw new Error('Fixture Pane is closed');
  return value.pane || { pane_id: paneId, terminal_id: value.agent.terminal_id || current.terminalId };
};
herdr.ensureServer = async () => record('ensure-server');
herdr.startWatcher = () => { record('watcher-start'); return 0; };
herdr.api = (session, args) => {
  const value = read();
  if (session !== 'stub') throw new Error('Unexpected fixture Herdr session');
  value.calls.push({ op: 'herdr', args });
  if (value.closedPane && args[0] === 'pane') {
    write(value);
    if (args[1] === 'get') {
      const error = new Error('Fixture Pane is closed'); error.herdrCode = 'pane_not_found'; throw error;
    }
    if (args[1] === 'list') return { result: { panes: value.livePanes || [] } };
    throw new Error('Offline cancellation fixture forbids terminal writes');
  }
  if (args[0] === 'pane' && args[1] === 'list') {
    const panes = value.panes || [value.pane || { pane_id: task().paneId, terminal_id: task().terminalId }];
    write(value); return { result: { panes } };
  }
  if (args[0] === 'agent' && args[1] === 'list') {
    const current = task();
    const registered = { agent: 'zcode', pane_id: value.agent.pane_id || current.paneId,
      terminal_id: value.agent.terminal_id || current.terminalId,
      agent_session: { value: value.agent.agent_session?.value ?? current.workerSessionId ?? null }, ...value.agent };
    if (value.omitNativeSession) delete registered.agent_session;
    const agents = value.agentAbsent ? [] : value.agents || (value.agent.agent || current.agent === 'zcode' ? [registered] : []);
    write(value); return { result: { agents } };
  }
  if (args[0] === 'pane' && args[1] === 'process-info') {
    const current = task(), receipt = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BRIDGE_STATE_DIR, 'tasks', current.id, 'zcode-state.json'), 'utf8'));
    write(value);
    return { result: { process_info: { fakeWorkerPid: receipt.workerPid, fakeWorkerStartedAt: receipt.workerProcessStartedAt } } };
  }
  if (args[0] === 'pane' && args[1] === 'run' && path.isAbsolute(args[3])) {
    fs.appendFileSync(process.env.ZCODE_READY_TEST_INBOX, JSON.stringify(args[3]) + '\n');
    write(value); return {};
  }
  if (args[0] === 'pane' && args[1] === 'report-agent') {
    value.agentAbsent = false;
    value.agent.agent = 'zcode';
    value.agent.agent_status = args[args.indexOf('--state') + 1];
    const session = args.indexOf('--agent-session-id');
    if (session >= 0 && !value.omitNativeSession) value.agent.agent_session = { value: args[session + 1] };
    value.agent.pane_id = args[2];
    value.agent.terminal_id = value.pane?.terminal_id || task().terminalId;
    if (value.agent.agent_status !== 'working') value.agent.completion_seq++;
  } else if (args[0] === 'pane' && args[1] === 'send-keys' && args[3] === 'ctrl+u') delete value.pendingText;
  else if (args[0] === 'pane' && args[1] === 'send-text') value.pendingText = args[3];
  else if (args[0] === 'pane' && args[1] === 'send-keys' && args[3] === 'enter') {
    fs.appendFileSync(process.env.ZCODE_READY_TEST_INBOX, JSON.stringify(value.pendingText) + '\n');
    delete value.pendingText;
  } else if (args[0] === 'agent' && args[1] === 'prompt' && typeof args[2] === 'string' && path.isAbsolute(args[3])) {
    fs.appendFileSync(process.env.ZCODE_READY_TEST_INBOX, JSON.stringify(args[3]) + '\n');
  } else throw new Error(`Unexpected fixture terminal operation: ${JSON.stringify(args)}`);
  write(value); return {};
};

const processProofPath = require.resolve('../../lib/windows-worker-process');
const processProof = require(processProofPath), { processAlive } = require('../../lib/util');
require.cache[processProofPath].exports = { ...processProof,
  proveWorkerProcess: async ({ kind, processInfo, expectedPid }) => {
    record('prove-worker-process', { kind, expectedPid, reportedPid: processInfo?.fakeWorkerPid });
    if (kind !== 'zcode-wrapper' || processInfo?.fakeWorkerPid !== expectedPid || !processAlive(expectedPid)
        || !Number.isFinite(Date.parse(processInfo.fakeWorkerStartedAt || ''))) {
      throw new Error('Fixture did not prove the live fake ZCode wrapper process');
    }
    return { kind, pid: expectedPid, processStartedAt: processInfo.fakeWorkerStartedAt };
  } };

const notificationControlPath = require.resolve('../../lib/notification-control');
const notificationControl = require(notificationControlPath);
notificationControl.reconcileThread = async threadId => {
  record('notification-mock', { threadId });
  return { queued: false, consumed: false, paused: false, deliveryAttempts: 0 };
};

const remotePath = require.resolve('../../lib/zcode-remote');
const original = require(remotePath);
class Remote extends EventEmitter {
  constructor() { super(); this.target = {}; }
  async connect() { record('connect'); if (read().connectionError) throw new Error(read().connectionError); }
  async attachProject(cwd, options) {
    record('attach', options); if (options.create && !process.env.ZCODE_READY_ALLOW_CREATE) throw new Error('Fixture forbids new native workspace/session');
  }
  envelope(type, sessionId, payload) {
    if (type !== 'sendText' && !(type === 'createSession' && process.env.ZCODE_READY_ALLOW_CREATE)) throw new Error('Fixture forbids create/stop');
    return { type, sessionId, commandId: type === 'createSession' ? 'fixture-create-command' : 'new-fixture-command', payload };
  }
  async command(envelope) {
    record('command', { type: envelope.type, commandId: envelope.commandId, modelSelection: envelope.payload.modelSelection });
    if (envelope.type === 'createSession' && process.env.ZCODE_READY_ALLOW_CREATE) {
      return { commandId: envelope.commandId, status: 'accepted', result: { sessionId: 'created-fixture-session' } };
    }
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
  async subscribe() { record('subscribe'); const value = read(); value.snapshot.sessionId = value.wrongSnapshotSession || value.snapshot.sessionId || this.sessionId; write(value); return this.snapshot; }
  async dispose() { record('unsubscribe'); }
  async wait() { return new Promise(() => {}); }
}
require.cache[remotePath].exports = { ...original, ZCodeRemote: Remote, Conversation, readBinding: () => ({}) };
