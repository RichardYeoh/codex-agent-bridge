'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const file = process.env.OC_ADMISSION_TEST_STATE;
function read() { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(value) { fs.writeFileSync(file, JSON.stringify(value)); }
function record(op, fields = {}) { const state = read(); state.calls.push({ op, ...fields }); write(state); }

// Every transport is an isolated fixture; unexpected operations never reach installed services. / 所有传输均为隔离替身，未知操作不得访问已安装服务。
const herdr = require('../../lib/herdr');
herdr.agentInfo = () => read().agent;
herdr.ensureServer = async () => record('herdr.ensure');
herdr.startWatcher = () => { record('watcher.start'); return 0; };
herdr.api = (session, args) => {
  if (args[0] !== 'pane' || args[1] !== 'report-agent') throw new Error('Unexpected fixture Herdr operation');
  const state = read();
  if (args[2] !== state.task.paneId || session !== state.task.herdrSession) throw new Error('Fixture Pane mismatch');
  state.agent.agent_status = args[args.indexOf('--state') + 1];
  state.calls.push({ op: 'herdr.report', state: state.agent.agent_status }); write(state);
  return {};
};

const modulePath = require.resolve('../../lib/opencode');
const native = require(modulePath);
function request(op, params, body) {
  record(op, { params, ...(op === 'session.prompt' ? { admissionId: body.id } : {}) });
  const state = read();
  if (params?.sessionID && params.sessionID !== state.task.workerSessionId) throw new Error('Fixture session mismatch');
  if (op === 'session.get') return state.info;
  if (op === 'session.active') return state.active;
  if (op === 'session.permission.list') return state.permissions;
  if (op === 'session.form.list') return state.forms;
  if (op === 'experimental.session.instructions.entry.list') return [];
  if (['session.update', 'experimental.session.instructions.entry.put'].includes(op)) {
    if (state.occupyOnPolicyWrite) { state.active = { [state.task.workerSessionId]: {} }; write(state); }
    return {};
  }
  if (op === 'session.prompt') {
    if (state.promptError) throw new Error('Fixture acknowledgement lost');
    return { id: body.id };
  }
  throw new Error(`Unexpected fixture native operation: ${op}`);
}
require.cache[modulePath].exports = { ...native,
  snapshot: task => native.snapshot(task, request),
  prepareSubmission: task => native.prepareSubmission(task, request),
  refreshWorker: (task, options) => native.refreshWorker(task, options, request),
  submitWorker: (task, text) => native.submitWorker(task, text, request),
};

if (process.env.OC_ADMISSION_TEST_OBSERVER) {
  require('node:child_process').spawn = () => {
    record('tui.spawn.fixture');
    const child = new EventEmitter();
    setTimeout(() => process.exit(0), 30);
    return child;
  };
}
