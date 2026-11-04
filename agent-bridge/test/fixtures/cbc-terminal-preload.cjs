'use strict';

const fs = require('node:fs');
const path = require('node:path');
const file = process.env.CBC_TERMINAL_TEST_STATE;
if (!file) throw new Error('Missing isolated CBC test state path');
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = value => fs.writeFileSync(file, JSON.stringify(value));
const herdr = require('../../lib/herdr');
const processProof = require('../../lib/windows-worker-process');

herdr.ensureServer = async () => {};
herdr.agentInfo = () => read().agent;
herdr.startWatcher = () => 0;

// This fixture replaces external Herdr reads and the Windows process query only. / 此夹具只替代外部Herdr读取和Windows进程查询。
herdr.api = (_session, args) => {
  const state = read();
  state.calls.push(args);
  let response;
  if (args[0] === 'pane' && args[1] === 'get') response = { pane: state.pane };
  else if (args[0] === 'agent' && args[1] === 'get') response = { agent: state.agent };
  else if (args[0] === 'pane' && args[1] === 'list') response = { panes: state.panes };
  else if (args[0] === 'agent' && args[1] === 'list') response = { agents: [state.agent] };
  else if (args[0] === 'pane' && args[1] === 'process-info') response = { process_info: state.processInfo };
  else if (args[0] === 'pane' && args[1] === 'read') response = { text: state.visibleText };
  else if (args[0] === 'agent' && args[1] === 'rename') {
    state.agent.name = args[3]; response = {};
  } else if (args[0] === 'pane' && args[1] === 'run') {
    if (args[2] !== state.pane.pane_id || typeof args[3] !== 'string' || !args[3].trim()) {
      throw new Error('Invalid isolated Pane input request');
    }
    state.submissions += 1;
    state.paneRuns.push({ paneId: args[2], text: args[3] });
    state.agent.agent_status = 'working';
    const stateDir = process.env.AGENT_BRIDGE_STATE_DIR;
    const task = JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks', state.currentTaskId, 'task.json'), 'utf8'));
    fs.appendFileSync(path.join(stateDir, 'hook-events.ndjson'), JSON.stringify({
      timestamp: new Date().toISOString(), name: 'UserPromptSubmit', identityBound: true,
      taskId: task.id, round: task.round, sessionId: task.workerSessionId, herdrSession: task.herdrSession,
      paneId: task.paneId, terminalId: task.terminalId, submissionAttemptId: task.submission.attemptId,
      promptSha256: require('node:crypto').createHash('sha256').update(args[3]).digest('hex'),
    }) + '\n');
    if (state.finishImmediately) {
      state.agent.agent_status = 'idle';
      state.agent.state_change_seq += 2;
      fs.appendFileSync(path.join(stateDir, 'hook-events.ndjson'), JSON.stringify({
        timestamp: new Date().toISOString(), name: 'Stop', source: 'isolated-native-fixture', identityBound: true,
        taskId: task.id, round: task.round, sessionId: task.workerSessionId, herdrSession: task.herdrSession,
        paneId: task.paneId, terminalId: task.terminalId,
      }) + '\n');
    }
    response = { queued: true };
  } else {
    throw new Error(`Unexpected fixture operation ${args[0]} ${args[1]}; no real terminal accessed`);
  }
  write(state);
  return { result: response };
};

processProof.proveWorkerProcess = async input => {
  const state = read();
  if (input?.kind !== 'cbc' || input.processInfo?.shell_pid !== state.processInfo.shell_pid
      || input.executablePath !== state.nodeExecutable || input.scriptPath !== state.cbcScript) {
    throw new Error('CBC process proof input did not match the isolated native process fixture');
  }
  state.processProofCalls += 1;
  write(state);
  return { kind: 'cbc', pid: state.nodePid, parentPid: state.processInfo.shell_pid,
    shellPid: state.processInfo.shell_pid, depth: 1, processName: 'node.exe',
    processStartedAt: state.processStartedAt };
};
