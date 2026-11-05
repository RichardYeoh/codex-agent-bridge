'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { matchesHerdrAgent } = require('./agents');

function assertWorker(task, agent) {
  if (!agent || !matchesHerdrAgent(task.agent, agent.agent)
      || (task.terminalId && agent.terminal_id !== task.terminalId)
      || (task.workerSessionId && agent.agent_session?.value && agent.agent_session.value !== task.workerSessionId)
      || (task.agentName && !task.agentNameReleased && agent.name !== task.agentName)) {
    const error = new Error(`Worker identity mismatch for ${task.herdrSession}/${task.paneId}`);
    error.code = 'WORKER_IDENTITY_MISMATCH';
    throw error;
  }
  return agent;
}

function updateWorkerSession(task) {
  if (task.taskProtocol === 2) {
    const entries = require('./cbc-executor-evidence').read(task);
    for (const entry of entries) {
      if (entry.taskId !== task.id || entry.terminalId !== task.terminalId || entry.paneId !== task.paneId
        || entry.herdrSession !== task.herdrSession || entry.identityBound !== true
        || entry.timestamp < task.workerStartedAt) continue;
      if (task.workerSessionId && task.workerSessionId !== entry.sessionId) throw new Error('Worker session changed unexpectedly');
      task.workerSessionId = entry.sessionId;
      if (entry.source === 'compact') task.contextInvalidatedAt = entry.timestamp;
    }
    return;
  }
  const file = path.join(task.stateDir, 'hook-events.ndjson');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.taskId === task.id && entry.herdrSession === task.herdrSession && entry.paneId === task.paneId
          && entry.source === 'compact' && (!task.workerStartedAt || entry.timestamp >= task.workerStartedAt)
          && (!task.contextInvalidatedAt || entry.timestamp > task.contextInvalidatedAt)) {
        task.contextInvalidatedAt = entry.timestamp;
      }
    } catch {}
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (task.agent === 'agy' && (entry.source !== 'agy-native-hook' || entry.terminalId !== task.terminalId)) continue;
      if (entry.terminalId && task.terminalId && entry.terminalId !== task.terminalId) continue;
      // Pane IDs are local to a server, never global identities. / Pane ID 仅在所属服务内唯一。
      if (entry.taskId === task.id && entry.herdrSession === task.herdrSession
          && entry.paneId === task.paneId && entry.sessionId
          && (!task.workerStartedAt || entry.timestamp >= task.workerStartedAt)) {
        if (task.workerSessionId && task.workerSessionId !== entry.sessionId) {
          throw new Error('Worker session changed unexpectedly');
        }
        task.workerSessionId = entry.sessionId;
        if (entry.name === 'SessionStart' && entry.source === 'compact') task.contextInvalidatedAt = entry.timestamp;
        return;
      }
    } catch (error) {
      if (error.message === 'Worker session changed unexpectedly') throw error;
    }
  }
}

module.exports = { assertWorker, updateWorkerSession };
