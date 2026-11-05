'use strict';

const path = require('node:path');
const { readJson, taskDir, sleep, processAlive } = require('./util');
const { agentInfo } = require('./herdr');
const { assertWorker } = require('./worker');

function readExecution(task) {
  const root = taskDir(task.id), prefix = `round-${String(task.round).padStart(3, '0')}-zcode-`;
  const command = readJson(path.join(root, `${prefix}command.json`), null);
  const state = readJson(path.join(root, 'zcode-state.json'), null);
  const matches = receipt => receipt?.taskId === task.id && receipt.round === task.round
    && receipt.sessionId === task.workerSessionId && receipt.paneId === task.paneId
    && receipt.terminalId === task.terminalId && receipt.commandId === command?.envelope?.commandId;
  if (!command?.envelope?.commandId || command.envelope.sessionId !== task.workerSessionId
      || !matches(state) || task.observationRequestedAt && state.timestamp < task.observationRequestedAt) return null;
  if (state.purpose === 'submission_ready') {
    const readiness = require('./zcode-readiness');
    if (state.readinessProtocol !== readiness.protocol || state.commandSha256 !== readiness.envelopeDigest(command.envelope)) return null;
    try { readiness.validateProof(task, state.readiness); } catch { return null; }
    const previous = state.readiness.previous;
    if (['failed', 'completedInterrupted'].includes(previous?.state)) return { ...state, state: 'blocked',
      reason: previous.reason, originalExecutionMayContinue: false };
    return null;
  }
  if (state.state === 'idle') {
    const observation = readJson(path.join(root, `${prefix}observation.json`), null);
    if (!matches(observation) || !observation.result?.terminal
        || observation.result.state !== 'completedSuccess' || command.status !== 'terminal') return null;
  }
  return state;
}

// Wait on bound native receipts, not a stale Herdr idle/blocked projection. / 等待绑定的原生回执，不依赖Herdr中滞后的空闲或阻塞投影。
async function waitExecution(task, { inspect = agentInfo, read = readExecution, pause = sleep,
  clock = Date.now, startupMs = 60000, pollMs = 1000, isActive = () => true } = {}) {
  const started = clock();
  let lastInspection = -Infinity, agent, observed = false;
  for (;;) {
    if (!isActive()) return null;
    if (clock() - lastInspection >= 5000) {
      agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
      lastInspection = clock();
    }
    const receipt = read(task);
    if (receipt) {
      observed = true;
      if (receipt.state === 'working' && receipt.workerPid && !processAlive(receipt.workerPid)) {
        throw new Error('ZCode observer process exited; original execution may continue');
      }
      if (['idle', 'blocked'].includes(receipt.state)) return { ...agent, agent_status: receipt.state };
    }
    if (!observed && clock() - started >= startupMs) {
      const error = new Error('ZCode observer has not attested this recovery; no prompt retransmitted');
      error.code = 'ETIMEDOUT'; throw error;
    }
    await pause(pollMs);
  }
}

module.exports = { readExecution, waitExecution };
