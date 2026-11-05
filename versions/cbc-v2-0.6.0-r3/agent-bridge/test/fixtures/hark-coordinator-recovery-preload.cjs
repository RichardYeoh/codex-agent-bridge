'use strict';

const fs = require('node:fs');

const fixtureFile = process.env.HARK_COORDINATION_FIXTURE;
const herdrPath = process.env.HARK_COORD_HERDR_MODULE;
const opencodePath = process.env.HARK_COORD_OPENCODE_MODULE;
const codexPath = process.env.HARK_COORD_CODEX_MODULE;
const load = () => JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const store = value => fs.writeFileSync(fixtureFile, JSON.stringify(value));

const util = require(process.env.HARK_COORD_UTIL_MODULE);
const originalWithLock = util.withLock;
const activeLocks = new Set();
util.withLock = (key, operation, timeoutMs) => {
  if (activeLocks.has(key)) {
    const state = load();
    state.reentrantLocks ||= [];
    state.reentrantLocks.push(key);
    store(state);
    throw new Error(`HARK_REENTRANT_LOCK: ${key}`);
  }
  const state = load();
  state.lockCalls ||= [];
  state.lockCalls.push(key);
  store(state);
  activeLocks.add(key);
  return originalWithLock(key, async () => {
    try { return await operation(); }
    finally { activeLocks.delete(key); }
  }, timeoutMs);
};

const herdr = require(herdrPath);
const herdrCalls = state => { state.herdrCalls ||= []; return state.herdrCalls; };
const fixtureHerdr = {
  ...herdr,
  async ensureServer() {},
  agentInfo(_session, paneId) {
    const state = load();
    herdrCalls(state).push(['agent', 'get', paneId]);
    store(state);
    return state.worker || null;
  },
  api(_session, args) {
    const state = load();
    herdrCalls(state).push(args);
    store(state);
    if (args[0] === 'pane' && args[1] === 'list') return { result: { panes: state.panes || [] } };
    if (args[0] === 'agent' && args[1] === 'list') return { result: { agents: state.agents || [] } };
    if (args[0] === 'pane' && args[1] === 'read') return { result: { text: state.terminalText || '' } };
    return { result: { ok: true } };
  },
  startWatcher(taskId) {
    const state = load();
    state.watchersStarted ||= [];
    state.watchersStarted.push(taskId);
    store(state);
    return 9382;
  },
};
require.cache[require.resolve(herdrPath)].exports = fixtureHerdr;

const opencode = require(opencodePath);
const original = { ...opencode };
function request(operation, params = {}, body) {
  const state = load();
  state.opencodeCalls ||= [];
  state.opencodeCalls.push({ operation, params, ...(body?.id ? { id: body.id } : {}) });
  store(state);
  const oc = state.opencode || {};
  if (operation === 'session.get') return oc.info;
  if (operation === 'session.active') return oc.active || {};
  if (operation === 'session.permission.list') return oc.permissions || [];
  if (operation === 'session.form.list') return oc.forms || [];
  if (operation === 'session.inbox.list') return oc.inbox || [];
  if (operation === 'session.message.list') return oc.messages || [];
  if (operation === 'session.message.get') {
    if (oc.message) return oc.message;
    throw new Error('fixture message not present');
  }
  if (operation === 'session.prompt') return { id: body?.id };
  return [];
}
opencode.confirmCompletion = (task, options = {}) => original.confirmCompletion(task, { ...options, request });
opencode.reconcileSubmission = (task, options = {}) => original.reconcileSubmission(task, { ...options, request });
opencode.confirmReconciledSubmission = (task, evidence) => original.confirmReconciledSubmission(task, evidence);
opencode.authorizeFailedRoundRetry = (task, options = {}) => original.authorizeFailedRoundRetry(task, { ...options, request });
opencode.prepareFailedRoundRetry = (task, options = {}) => original.prepareFailedRoundRetry(task, { ...options, request });
opencode.submitFailedRoundRetry = (task, text, options = {}) => original.submitFailedRoundRetry(task, text, { ...options, request });

const codex = require(codexPath);
require.cache[require.resolve(codexPath)].exports = {
  ...codex,
  async createQueueClient() {
    return {
      async list() { return load().queueItems || []; },
      async add(_threadId, _text, id) { return { id }; },
      async update() { return { updated: true }; },
      async remove() { return { deleted: true }; },
      close() {},
    };
  },
};
