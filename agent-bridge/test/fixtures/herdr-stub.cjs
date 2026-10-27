'use strict';

const fs = require('node:fs');
let args = process.argv.slice(2);
if (args[0] === '--session') args = args.slice(2);
const stateFile = process.env.BRIDGE_STUB_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
process.stdout.write(JSON.stringify({ result: { agent: state.agent } }));
