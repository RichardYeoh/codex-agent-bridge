'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { taskDir, writeJsonAtomic, readJson, now } = require('./util');

function prepare(task) {
  const attemptId = crypto.randomUUID();
  const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-submission-${attemptId}.json`);
  const record = { protocol: 1, attemptId, taskId: task.id, round: task.round,
    agent: task.agent, herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId,
    workerSessionId: task.workerSessionId, promptSha256: crypto.createHash('sha256').update(fs.readFileSync(task.promptPath)).digest('hex'),
    status: 'prepared', createdAt: now() };
  writeJsonAtomic(file, record);
  return { attemptId, file };
}

function update(attempt, status, evidence = {}) {
  const record = readJson(attempt.file);
  if (record.attemptId !== attempt.attemptId || !['prepared', 'sending'].includes(record.status)) {
    throw new Error('Submission attempt changed or is already terminal');
  }
  writeJsonAtomic(attempt.file, { ...record, status, updatedAt: now(), ...evidence });
}

module.exports = { prepare, update };
