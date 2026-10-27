'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getAgent } = require('./agents');

function assertWorker(task, agent) {
  const expected = getAgent(task.agent).herdrAgent;
  if (!agent || agent.agent !== expected
      || (task.terminalId && agent.terminal_id !== task.terminalId)
      || (task.agentName && !task.agentNameReleased && agent.name !== task.agentName)) {
    const error = new Error(`Worker identity mismatch for ${task.herdrSession}/${task.paneId}`);
    error.code = 'WORKER_IDENTITY_MISMATCH';
    throw error;
  }
  return agent;
}

function updateWorkerSession(task) {
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
