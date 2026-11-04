'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { agentInfo, paneInfo } = require('./herdr');
const { getAgent } = require('./agents');
const { readJson, processAlive, taskDir } = require('./util');

function bindingError(message) {
  const error = new Error(message);
  error.code = 'ZCODE_LOCAL_BINDING_REPLACED';
  return error;
}

function verifyPaneAgent(task, paneId, terminalId, { inspectAgent = agentInfo, inspectPane = paneInfo,
  expectedSessionId = task.workerSessionId || null, allowUnregisteredSession = false,
  allowUnregisteredAgent = false, context = 'current-pane' } = {}) {
  let pane, agent;
  try {
    pane = inspectPane(task.herdrSession, paneId);
    try { agent = inspectAgent(task.herdrSession, paneId); }
    catch (error) {
      if (!allowUnregisteredAgent || !['agent_not_found', 'agent_not_registered'].includes(error.herdrCode || error.code)) throw error;
      agent = null;
    }
  } catch (error) {
    throw bindingError(`ZCode Pane/agent identity cannot be verified: ${error.message}`);
  }
  if (!agent && allowUnregisteredAgent) {
    if (!pane || pane.pane_id !== paneId || pane.terminal_id !== terminalId) {
      throw bindingError('Unregistered ZCode wrapper Pane or terminal identity changed');
    }
    return { pane, agent: null };
  }
  const expectedAgent = getAgent(task.agent).herdrAgent;
  const nativeSessionId = agent?.agent_session?.value ?? null;
  const mismatches = [];
  if (!pane || pane.pane_id !== paneId) mismatches.push('pane-id');
  if (!pane || pane.terminal_id !== terminalId || !agent || agent.terminal_id !== terminalId) mismatches.push('terminal');
  if (!agent || agent.pane_id !== paneId || agent.agent !== expectedAgent) mismatches.push('agent-reference');
  if (!(allowUnregisteredSession && expectedSessionId && nativeSessionId === null)
      && nativeSessionId !== expectedSessionId) mismatches.push('native-session');
  if (mismatches.length) throw bindingError(`ZCode Pane/agent identity mismatch (${context}): ${mismatches.join(', ')}`);
  return { pane, agent };
}

function assertRebindableObserver(task, owner, { alive = processAlive } = {}) {
  if (task.agent !== 'zcode' || !task.workerSessionId || task.round < 1
      || task.submission?.status !== 'observed' || owner?.agent_session?.value !== task.workerSessionId
      || owner.agent !== getAgent('zcode').herdrAgent || owner.terminal_id !== task.terminalId
      || !owner.pane_id || owner.pane_id === task.paneId) {
    throw new Error('Restored ZCode owner is not the original terminal and native session');
  }
  // The automatic watcher may rebind itself while holding the root coordinator lock. / 自动watcher可在持有根协调锁时重绑定自身。
  // A different live watcher remains an owner and blocks public CLI adoption. / 其他存活watcher仍是当前所有者，阻止公开CLI并发接管。
  if (task.watcherPid && task.watcherPid !== process.pid && alive(task.watcherPid)) {
    throw new Error('Previous ZCode watcher is still active');
  }
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json'), state = readJson(stateFile, null);
  const journalFile = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-command.json`);
  const journal = readJson(journalFile, null), commandId = journal?.envelope?.commandId;
  if (!state || state.taskId !== task.id || state.round !== task.round || state.sessionId !== task.workerSessionId
      || state.paneId !== task.paneId || state.terminalId !== task.terminalId || state.commandId !== commandId
      || state.state !== 'working' || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0
      || !alive(state.workerPid) || journal?.envelope?.type !== 'sendText'
      || journal.envelope.sessionId !== task.workerSessionId || journal.ack?.commandId !== commandId
      || !['accepted', 'duplicate'].includes(journal.ack.status)) {
    throw new Error('Restored ZCode observer lacks an exact live worker and admitted command receipt');
  }
  return { taskId: task.id, round: task.round, sessionId: task.workerSessionId, commandId,
    workerPid: state.workerPid, watcherPid: task.watcherPid || null,
    paneId: owner.pane_id, terminalId: owner.terminal_id,
    observerGeneration: task.observerGeneration || 0,
    workerStateSha256: crypto.createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex'),
    journalSha256: crypto.createHash('sha256').update(fs.readFileSync(journalFile)).digest('hex') };
}

module.exports = { assertRebindableObserver, bindingError, verifyPaneAgent };
