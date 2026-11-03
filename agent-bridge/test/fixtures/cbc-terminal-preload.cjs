'use strict';

const fs = require('node:fs');
const file = process.env.CBC_TERMINAL_TEST_STATE;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const herdr = require('../../lib/herdr');
herdr.ensureServer = async () => {};
herdr.agentInfo = () => read().agent;
herdr.startWatcher = () => 0;
// No terminal process can be launched by this isolated transport. / 此隔离传输禁止启动任何终端进程。
herdr.api = (_session, args) => {
  const state = read(); state.calls.push(args);
  if (args[0] === 'agent' && args[1] === 'list') {
    fs.writeFileSync(file, JSON.stringify(state)); return { result: { agents: [] } };
  }
  if (args[0] === 'agent' && args[1] === 'rename') state.agent.name = args[3];
  else if (args[0] === 'pane' && args[1] === 'send-text') state.submissions++;
  else if (args[0] === 'pane' && args[1] === 'send-keys' && args[3] === 'enter') state.agent.agent_status = 'working';
  else throw new Error('Unexpected fixture operation; no real terminal accessed');
  fs.writeFileSync(file, JSON.stringify(state)); return {};
};
