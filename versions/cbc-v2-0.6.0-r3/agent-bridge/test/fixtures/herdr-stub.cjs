'use strict';

const fs = require('node:fs');
let args = process.argv.slice(2);
if (args[0] === '--session') args = args.slice(2);
const stateFile = process.env.BRIDGE_STUB_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let task = null;
try { task = JSON.parse(fs.readFileSync(`${process.env.AGENT_BRIDGE_STATE_DIR}/tasks/${process.env.AGENT_BRIDGE_TASK_ID}/task.json`, 'utf8')); } catch {}
state.calls.push(args);
if (((args[0] === 'agent' && args[1] === 'prompt')
    || (args[0] === 'pane' && args[1] === 'send-keys')) && state.mode === 'fast') {
  state.agent.agent_status = 'done';
  state.agent.completion_seq += 1;
}
fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[0] === 'agent' && args[1] === 'wait' && state.mode === 'timeout') {
  process.stderr.write(JSON.stringify({ error: { code: 'timeout', message: 'wait timeout' } }));
  process.exit(1);
}
if (args[0] === 'agent' && args[1] === 'read') {
  process.stdout.write(JSON.stringify({ result: { text: state.terminal || '' } }));
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'report-agent') {
  const session = args.indexOf('--agent-session-id'), status = args.indexOf('--state');
  state.agent.agent = 'zcode'; state.agent.pane_id = args[2];
  state.agent.terminal_id = state.agent.terminal_id || task?.terminalId;
  if (session >= 0) state.agent.agent_session = { value: args[session + 1] };
  if (status >= 0) state.agent.agent_status = args[status + 1];
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
if (args[0] === 'agent' && args[1] === 'get') {
  state.agent.agent ||= 'zcode'; state.agent.pane_id ||= args[2];
  state.agent.terminal_id ||= task?.terminalId;
  state.agent.agent_session ||= { value: task?.workerSessionId || null };
}
if (args[0] === 'pane' && args[1] === 'get') {
  process.stdout.write(JSON.stringify({ result: { pane: state.pane || { pane_id: args[2], terminal_id: state.agent.terminal_id || task?.terminalId } } }));
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ result: { panes: state.panes || (task ? [state.pane || { pane_id: task.paneId,
    terminal_id: task.terminalId }] : []) } }));
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ result: { agents: state.agents || (state.agent?.agent ? [state.agent] : []) } }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ result: { agent: state.agent } }));
