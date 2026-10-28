'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const sdk = require('../vendor/zcode/remote-sdk.cjs');

const ORIGIN = 'https://zcode.z.ai';
const DEFAULT_MODEL = 'GLM-5.3-Flash';

function readBinding(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = new URL(value.remoteUrl);
  if (url.origin !== ORIGIN || url.pathname !== '/remote/v4' || url.username || url.password
      || !url.searchParams.get('sid') || !url.searchParams.get('mid')) {
    throw new Error('Expected an official ZCode /remote/v4 binding');
  }
  return { sid: url.searchParams.get('sid'), mid: url.searchParams.get('mid') };
}

function selectedModel(model = DEFAULT_MODEL, effort = 'max') {
  if (!['low', 'high', 'max'].includes(effort)) throw new Error('Unsupported ZCode reasoning level');
  if (!/^GLM-[A-Za-z0-9.\-]+$/.test(model)) throw new Error('Expected a Start Plan model ID');
  return { providerId: 'account:zai-start-plan', modelId: model, options: { reasoningLevel: effort } };
}

// The origin is fixed; credentials never enter arguments, state files or diagnostic output. / 固定官方域名，凭据不进入参数、状态或诊断输出。
class ZCodeRemote extends EventEmitter {
  constructor(binding, { socket = WebSocket, fetcher = fetch, credential = sdk.loadSharedZCodeCredentialSync,
    timeoutMs = 20000 } = {}) {
    super();
    Object.assign(this, { binding, Socket: socket, fetcher, credential, timeoutMs });
    this.pending = new Map();
    this.closed = false;
    this.clientId = 'codex-agent-bridge';
  }

  async connect() {
    const jwt = this.credential('zcodejwttoken');
    if (!jwt) throw new Error('ZCode Desktop login unavailable; sign in in Desktop');
    let response;
    try {
      response = await this.fetcher(`${ORIGIN}/api/v1/remote/token`, {
        method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'terminal' }), redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new Error('ZCode official authentication connection failed'); }
    if (!response.ok) throw new Error(`ZCode official authentication rejected (${response.status})`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.token) throw new Error('ZCode relay token rejected');
    this.ws = new this.Socket(`wss://zcode.z.ai/api/v1/remote/ws2?token=${encodeURIComponent(data.data.token)}&mid=${encodeURIComponent(this.binding.mid)}`);
    this.lastHeartbeat = Date.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('ZCode Desktop pairing timeout')); this.close(); }, this.timeoutMs);
      this.pairing = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
      this.ws.on('open', () => {
        this.send({ type: 'auth_init', device_sid: this.binding.sid });
        this.beat = setInterval(() => {
          if (Date.now() - this.lastHeartbeat > 15000) return this.fail('ZCode relay heartbeat lost');
          this.send({ type: 'pair_status_query' });
        }, 5000);
      });
      this.ws.on('message', raw => this.receive(raw));
      this.ws.on('error', () => this.fail('ZCode relay connection failed'));
      this.ws.on('close', () => { if (!this.closed) this.fail('ZCode relay disconnected'); });
    });
    this.bootstrap = (await this.request('bootstrap-request')).result;
    return this.bootstrap;
  }

  send(frame) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ ...frame, client_ts: Math.floor(Date.now() / 1000) }));
    return true;
  }

  sendApp(payload) { return this.send({ type: 'data', payload }); }

  receive(raw) {
    if (this.closed) return;
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return this.fail('Invalid ZCode relay frame'); }
    if (['auth_ack', 'pair_status_ack'].includes(frame.type)) this.lastHeartbeat = Date.now();
    if (frame.type === 'error') {
      // An exclusive terminal seat must never be reclaimed in a reconnect loop. / 独占远控席位被抢占后禁止循环争抢。
      const code = ['KICKED', 'AUTH_FAILED', 'DEVICE_OFFLINE', 'WRONG_PARAM'].includes(frame.code) ? frame.code : 'ERROR';
      return this.fail(`ZCode relay ${code}`);
    }
    if (['auth_ack', 'pair_status_ack'].includes(frame.type) && frame.pair_status === 'matched') {
      this.paired = true; this.pairing?.resolve();
    } else if (frame.type === 'pair_status_ack' && frame.pair_status === 'waiting' && this.paired) {
      return this.fail('ZCode Desktop disconnected');
    }
    if (frame.type !== 'data') return;
    const payload = frame.payload;
    if (payload?.zcode_type === 'rpc-frame' || payload?.zcode_type === 'rpc-frame-ack') {
      try { this.relay?.acceptPayload(payload); } catch { this.fail('ZCode RPC transport fault'); }
      return;
    }
    const pending = this.pending.get(payload?.requestId);
    if (pending) {
      this.pending.delete(payload.requestId);
      clearTimeout(pending.timer);
      if (payload.success === false || payload.zcode_type === 'workspace-bridge-error') pending.reject(new Error('ZCode workspace attachment rejected'));
      else pending.resolve(payload);
    }
    if (payload?.zcode_type === 'workspace-bridge-invalidated') this.fail('ZCode workspace bridge invalidated');
  }

  request(type, body = {}) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`ZCode ${type} timeout`)); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.sendApp({ zcode_type: type, requestId, ...body })) {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('ZCode relay is closed'));
      }
    });
  }

  async open(workspaceKey, extra = {}) {
    this.client?.dispose(); this.relay?.dispose();
    const bridgeSessionId = crypto.randomUUID();
    this.relay = sdk.createAcknowledgedWebRemoteControlRelayProtocol({ bridgeSessionId, sendFrame: p => this.sendApp(p) });
    this.degraded = this.relay.onDegraded(() => this.fail('ZCode RPC transport degraded'));
    this.client = new sdk.ChannelClient(this.relay.protocol);
    this.bridge = await this.request('workspace-bridge-open', { bridgeSessionId, workspaceKey, ...extra });
    const hello = await this.call('zcode-agent', 'helloConversationV4');
    if (hello.protocolVersion !== 3 || hello.clientMode !== 'web-remote-replayable') throw new Error('Unsupported ZCode Host protocol');
    await this.call('zcode-agent', 'initializeConversationV4', {
      kind: 'clientHello', protocolVersion: hello.protocolVersion, clientId: this.clientId,
      clientKind: 'web', appVersion: '0.3.0', capabilities: { historyFirst: true },
    });
  }

  async call(channel, method, ...args) {
    let timer;
    try {
      return await Promise.race([
        this.client.getChannel(channel).call(method, args),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`ZCode ${method} acknowledgement uncertain`)), this.timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  listen(channel, name, args, listener) { return this.client.getChannel(channel).listen(name, args)(listener); }

  async attachProject(cwd, { create = false } = {}) {
    const first = this.bootstrap?.workspaces?.find(w => w.kind === 'local');
    if (!first) throw new Error('ZCode Desktop has no available local workspace');
    await this.open(first.workspaceIdentity || first.workspacePath);
    const canonical = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    const projects = await this.call('project', 'readProjects');
    let project = projects.find(p => !p.deleted && p.roots?.some(r => canonical(r.rootPath) === canonical(cwd)));
    if (!project && create) project = await this.call('project', 'saveProject', { name: path.basename(cwd), roots: [cwd], primaryRoot: cwd });
    if (!project) throw new Error('ZCode project binding not found; explicit creation is required');
    await this.open(cwd, { project: { projectId: project.id } });
    this.target = { workspacePath: cwd };
    this.projectId = project.id;
    return project;
  }

  envelope(type, sessionId, payload, id = crypto.randomUUID()) {
    return { commandId: id, clientId: this.clientId, sessionId, type, payload, issuedAt: Date.now() };
  }

  command(envelope) {
    return this.call('zcode-agent', 'sendConversationCommandV4', { ...this.target,
      ...(envelope.type === 'createSession' ? { projectId: this.projectId } : {}), envelope });
  }

  query(envelope) {
    return this.call('zcode-agent', 'queryConversationCommandsV4', { ...this.target,
      commands: [{ sessionId: envelope.sessionId, commandId: envelope.commandId }] });
  }

  fail(message) {
    if (this.closed) return;
    const error = new Error(message);
    this.pairing?.reject(error);
    this.close();
    this.emit('fault', error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ZCode connection closed')); }
    this.pending.clear(); this.client?.dispose(); this.degraded?.dispose(); this.relay?.dispose();
    this.ws?.close();
    const socket = this.ws;
    setTimeout(() => socket?.terminate(), 500).unref();
  }
}

class Conversation extends EventEmitter {
  constructor(remote, sessionId) {
    super(); Object.assign(this, { remote, sessionId });
    this.assembler = new sdk.TopicWireFrameAssembler(sdk.conversationTopicFrameSchema);
    this.listener = remote.listen('zcode-agent', 'onDynamicConversationFrame', remote.target, wire => {
      if (wire.topic !== `conversation/${sessionId}` || (this.subscriptionId && wire.subscriptionId !== this.subscriptionId)) return;
      try {
        for (const item of this.assembler.accept(wire)) {
          if (item.kind === 'fault') { this.emit('fault', new Error('ZCode conversation assembly failed')); continue; }
          const frame = item.frame;
          if (frame.payload.kind === 'snapshot') this.snapshot = frame.payload.snapshot;
          else {
            if (!this.snapshot || frame.fromSeq !== this.snapshot.seq) {
              if (this.snapshot && frame.toSeq <= this.snapshot.seq) continue;
              this.emit('fault', new Error('ZCode conversation sequence gap; reconnect for a fresh snapshot')); continue;
            }
            this.snapshot = { ...sdk.applyConversationDeltas(this.snapshot, frame.payload.deltas), seq: frame.toSeq };
          }
          this.emit('snapshot', this.snapshot);
        }
      } catch { this.emit('fault', new Error('ZCode conversation validation failed')); }
    });
  }

  async subscribe() {
    const ack = await this.remote.call('zcode-agent', 'subscribeConversationV4', {
      ...this.remote.target, sessionId: this.sessionId, visibility: 'background',
    });
    this.subscriptionId = ack.ack.subscriptionId;
    return this.snapshot || this.wait(() => true);
  }

  wait(predicate, timeoutMs = 120000) {
    if (this.snapshot && predicate(this.snapshot)) return Promise.resolve(this.snapshot);
    return new Promise((resolve, reject) => {
      const done = (error, snapshot) => { clearTimeout(timer); this.off('snapshot', onSnapshot); this.off('fault', onFault); this.remote.off('fault', onFault); error ? reject(error) : resolve(snapshot); };
      const onSnapshot = snapshot => { if (predicate(snapshot)) done(null, snapshot); };
      const onFault = error => done(error);
      const timer = setTimeout(() => done(new Error('ZCode execution observation timeout; execution may continue')), timeoutMs);
      this.on('snapshot', onSnapshot); this.on('fault', onFault); this.remote.on('fault', onFault);
    });
  }

  async dispose() {
    this.listener.dispose();
    if (this.subscriptionId && !this.remote.closed) {
      try { await this.remote.call('zcode-agent', 'unsubscribeConversationV4', { ...this.remote.target, subscriptionId: this.subscriptionId }); } catch {}
    }
  }
}

function turnState(snapshot, commandId) {
  const header = snapshot.rows.window.find(row => row.kind === 'turnHeader' && row.sourceCommandId === commandId);
  if (!header) return { seen: false, terminal: false };
  return { seen: true, terminal: ['completedSuccess', 'completedInterrupted', 'failed'].includes(header.state), state: header.state,
    header, error: snapshot.control.lastError };
}

function needsFullContext(snapshot) {
  return snapshot.rows.totalCount > snapshot.rows.window.length || snapshot.rows.window.some(row =>
    row.kind === 'timelineMarker' && row.marker?.type === 'compact' && ['success', 'running'].includes(row.marker.status));
}

module.exports = { ZCodeRemote, Conversation, readBinding, selectedModel, turnState, needsFullContext, DEFAULT_MODEL };
