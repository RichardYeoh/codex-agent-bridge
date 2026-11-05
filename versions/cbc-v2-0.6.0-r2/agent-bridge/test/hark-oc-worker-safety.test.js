'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveTask } = require('../lib/util');
const { writeLease } = require('../lib/worker-lease');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-oc-worker-'));
let counter = 0;
test.after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function runWorker(mode, { childLifetimeMs = 5200 } = {}) {
  const stateDir = path.join(root, `case-${++counter}`); fs.mkdirSync(stateDir, { recursive: true });
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir;
  const task = { id: `hark-oc-worker-${counter}`, agent: 'opencode', cwd: stateDir, stateDir,
    workerSessionId: `ses_worker${counter}`, herdrSession: 'fixture', paneId: `w1:p${counter}`,
    terminalId: `term-${counter}`, round: 1, status: 'running',
    history: [{ round: 1, status: 'submitted', timestamp: new Date(Date.now() - 60000).toISOString() }],
    createdAt: new Date(Date.now() - 120000).toISOString() };
  saveTask(task); writeLease(task);
  const transportFile = path.join(stateDir, 'transport.json');
  fs.writeFileSync(transportFile, JSON.stringify({ task,
    info: { id: task.workerSessionId, location: { directory: stateDir }, outcome: null, time: { idle: 0 } },
    active: { [task.workerSessionId]: { type: 'running' } }, permissions: [], forms: [], calls: [], published: [] }));
  const preload = path.join(stateDir, 'hark-oc-worker-preload.cjs');
  const nativePath = path.resolve(__dirname, '../lib/opencode.js');
  const code = `'use strict';
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const file = process.env.HARK_OC_WORKER_STATE;
function read(){ return JSON.parse(fs.readFileSync(file,'utf8')); }
function write(s){ fs.writeFileSync(file,JSON.stringify(s)); }
function record(op, data={}){ const s=read(); s.calls.push({op,...data}); write(s); }
const modulePath=${JSON.stringify(nativePath)};
const native=require(modulePath);
const originalSnapshot=native.snapshot;
const originalPublish=native.publish;
let snapshots=0;
function request(op, params){
  record(op,{params}); const s=read();
  if(params?.sessionID && params.sessionID!==s.task.workerSessionId) throw new Error('fixture session mismatch');
  if(op==='session.get') return s.info;
  if(op==='session.active') return s.active;
  if(op==='session.permission.list') return s.permissions;
  if(op==='session.form.list') return s.forms;
  return null;
}
native.snapshot=(task)=>{
  snapshots++; record('snapshot',{number:snapshots});
  if((${JSON.stringify(mode)}==='transient' && snapshots===2) || (${JSON.stringify(mode)}==='startup' && snapshots===1)) {
    const e=new Error('OpenCode session.get unavailable (ETIMEDOUT); inspect native CLI'); e.code='OPENCODE_API_UNAVAILABLE'; throw e;
  }
  return originalSnapshot(task,request);
};
native.publish=(task,state)=>{
  const s=read(); s.published.push({state:state.state,reason:state.reason||null}); write(s);
  return originalPublish(task,state,(session,args)=>{ record('herdr.report',{session,args}); return {}; });
};
require.cache[modulePath].exports={...native};
require('node:child_process').spawn=()=>{
  record('tui.spawn'); const child=new EventEmitter();
  setTimeout(()=>child.emit('exit',0,null),${childLifetimeMs}); return child;
};
`;
  fs.writeFileSync(preload, code, 'utf8');
  const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../bin/opencode-worker.js'), task.workerSessionId], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir,
      AGENT_BRIDGE_HERDR_SESSION: task.herdrSession, HERDR_PANE_ID: task.paneId,
      AGENT_BRIDGE_TASK_ID: task.id, HARK_OC_WORKER_STATE: transportFile },
  });
  return { result, transport: JSON.parse(fs.readFileSync(transportFile, 'utf8')) };
}

test('one transient OpenCode API failure is debounced and does not report api_unavailable', () => {
  const { result, transport } = runWorker('transient');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(transport.calls.some(call => call.op === 'tui.spawn'));
  assert.ok(transport.published.some(item => item.state === 'working'));
  assert.equal(transport.published.some(item => item.reason === 'api_unavailable'), false);
  assert.ok(transport.calls.filter(call => call.op === 'snapshot').length >= 3, 'observer retried after the single failed poll');
});

test('an API outage on observer startup still launches the native TUI for the saved session', () => {
  const { result, transport } = runWorker('startup', { childLifetimeMs: 1000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(transport.calls.some(call => call.op === 'tui.spawn'));
  assert.equal(transport.calls.filter(call => call.op === 'snapshot').length, 1);
  assert.equal(transport.published.some(item => item.reason === 'api_unavailable'), false);
});
