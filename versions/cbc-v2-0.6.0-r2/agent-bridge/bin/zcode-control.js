#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTask, taskDir, readJson, writeJsonAtomic, now, withLock } = require('../lib/util');
const { ZCodeRemote, Conversation, readBinding } = require('../lib/zcode-remote');
const { safeMessage } = require('../lib/zcode-errors');
const readiness = require('../lib/zcode-readiness');

function commandFile(task, interactionId) {
  const hash = crypto.createHash('sha256').update(interactionId).digest('hex');
  return path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-approval-${hash}.json`);
}

function validateApprovalContext(task, journal, state) {
  if (task.agent !== 'zcode' || !task.workerSessionId || task.status !== 'blocked'
      || task.blocker?.type !== 'interaction_required' || task.round < 1) {
    throw new Error('approve-once requires a blocked interaction_required ZCode task');
  }
  const expected = readiness.binding(task, journal);
  if (journal.status !== 'acknowledged' || !['accepted', 'duplicate'].includes(journal.ack?.status)
      || journal.ack.commandId !== expected.commandId) {
    throw new Error('approve-once requires the exact admitted current-round command');
  }
  const identity = ['taskId', 'round', 'sessionId', 'paneId', 'terminalId', 'commandId'];
  if (!state || identity.some(key => state[key] !== expected[key])
      || state.state !== 'blocked' || state.reason !== 'interaction_required') {
    throw new Error('approve-once worker status is not bound to the current interaction round');
  }
  return expected;
}

async function approveOnceLocked(taskId, interactionId, dependencies = {}) {
  const { load = loadTask, createRemote = task => new ZCodeRemote(readBinding(task.zcodeConfig)),
    createConversation = (remote, sessionId) => new Conversation(remote, sessionId) } = dependencies;
  if (!interactionId) throw new Error('approve-once requires an interaction ID');
  const task = load(taskId), journalFile = readiness.files(task).journal, journal = readJson(journalFile, null);
  const stateFile = path.join(taskDir(task.id), 'zcode-state.json'), state = readJson(stateFile, null);
  const expected = validateApprovalContext(task, journal, state);
  const file = commandFile(task, interactionId), existing = readJson(file, null);
  if (existing) {
    if (existing.taskId !== expected.taskId || existing.round !== expected.round
        || existing.sessionId !== expected.sessionId || existing.commandId !== expected.commandId
        || existing.interactionId !== interactionId) throw new Error('Existing approval receipt belongs to another command');
    if (existing.status === 'acknowledged') return existing;
    throw new Error('Approval submission is already in flight or uncertain; no duplicate resolution was sent');
  }
  const remote = createRemote(task);
  remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd);
    conversation = createConversation(remote, task.workerSessionId);
    conversation.on('fault', () => {});
    const snapshot = await conversation.subscribe();
    if (snapshot.sessionId !== expected.sessionId) throw new Error('Approval session identity mismatch');
    const interaction = snapshot.pendingInteractions?.find(item => item.interactionId === interactionId && item.kind === 'permission');
    const sourceCommandId = interaction?.sourceCommandId || interaction?.payload?.sourceCommandId;
    if (!interaction?.payload?.options?.some(option => option.optionId === 'allowOnce')
        || sourceCommandId !== expected.commandId) {
      throw new Error('No one-time permission is bound to the current task command');
    }
    const currentTask = load(taskId), currentJournal = readJson(readiness.files(currentTask).journal, null);
    const currentState = readJson(stateFile, null);
    if (currentTask.status !== 'blocked' || currentTask.round !== expected.round
        || !readiness.matches(expected, readiness.binding(currentTask, currentJournal))
        || !currentState || identityMismatch(currentState, expected) || currentState.reason !== 'interaction_required') {
      throw new Error('Approval task, command, or worker binding changed before resolution');
    }
    const envelope = remote.envelope('resolveInteraction', task.workerSessionId,
      { interactionId, answer: { optionId: 'allowOnce' } });
    const record = { taskId: task.id, round: task.round, sessionId: task.workerSessionId,
      commandId: expected.commandId, interactionId, sourceCommandId, status: 'sending', envelope, timestamp: now() };
    writeJsonAtomic(file, record);
    const ack = await remote.command(envelope);
    writeJsonAtomic(file, { ...record, status: ['accepted', 'duplicate', 'noop'].includes(ack.status) ? 'acknowledged' : 'rejected', ack });
    if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) throw new Error(`One-time approval was not accepted (${ack.reasonCode || ack.status})`);
    return { status: ack.status, reasonCode: ack.reasonCode, taskId: task.id, round: task.round,
      sessionId: task.workerSessionId, commandId: expected.commandId, interactionId };
  } finally { try { await conversation?.dispose(); } finally { await remote.close(); } }
}

function identityMismatch(value, expected) {
  return ['taskId', 'round', 'sessionId', 'paneId', 'terminalId', 'commandId'].some(key => value[key] !== expected[key]);
}

async function approveOnce(taskId, interactionId, dependencies = {}) {
  const lock = dependencies.withLock || withLock;
  return lock(taskId, () => approveOnceLocked(taskId, interactionId, dependencies));
}

async function main() {
  const [id, action, interactionId] = process.argv.slice(2);
  if (!['snapshot', 'approve-once'].includes(action)) throw new Error('zcode-control <task-id> <snapshot|approve-once [interaction-id]>');
  if (action === 'approve-once') {
    const result = await approveOnce(id, interactionId);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const task = loadTask(id);
  if (task.agent !== 'zcode' || !task.workerSessionId) throw new Error('Expected a captured ZCode task session');
  const remote = new ZCodeRemote(readBinding(task.zcodeConfig));
  remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd);
    conversation = new Conversation(remote, task.workerSessionId);
    conversation.on('fault', () => {});
    const snapshot = await conversation.subscribe();
    process.stdout.write(JSON.stringify({ control: snapshot.control, pendingInteractions: snapshot.pendingInteractions,
      queue: snapshot.queue, rows: snapshot.rows.window }, null, 2) + '\n');
  } finally { try { await conversation?.dispose(); } finally { await remote.close(); } }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`ZCode control failed: ${safeMessage(error.message)}; no automatic retry was performed.\n`);
  process.exitCode = 1;
});

module.exports = { approveOnce, approveOnceLocked, commandFile, validateApprovalContext };
