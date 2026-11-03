'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic, saveTask, taskDir, now, processAlive, event } = require('./util');
const { ZCodeRemote, Conversation, readBinding } = require('./zcode-remote');
const { resolveTurn, queryAdmission } = require('./zcode-observation');
const { normalizeTaskSpec } = require('./worker-policy');
const { agentInfo, api, startWatcher } = require('./herdr');
const { assertWorker } = require('./worker');
const { leaseForEvent } = require('./worker-lease');

function localFile(root, file) {
  const result = path.resolve(file), relative = path.relative(root, result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Adoption files must remain inside this task directory');
  return result;
}

async function verifyNative(task, envelope) {
  const remote = new ZCodeRemote(readBinding(task.zcodeConfig)); remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd, { create: false });
    const ack = await queryAdmission(remote, envelope);
    if (!['accepted', 'duplicate'].includes(ack.status)) throw new Error('External command was not admitted');
    conversation = new Conversation(remote, task.workerSessionId);
    await conversation.subscribe();
    const prior = readJson(path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-zcode-command.json`));
    const previous = await resolveTurn(remote, conversation.snapshot, prior.envelope.commandId);
    if (!previous.terminal) throw new Error('Previous command is not authoritatively terminal; adoption refused');
    const current = await resolveTurn(remote, conversation.snapshot, envelope.commandId);
    if (!current.seen) throw new Error('External command not found in native session; no task state changed');
    return { ack, previous, current, checkedAt: now() };
  } finally {
    try { await conversation?.dispose(); } finally { remote.close(); }
  }
}

// Adopt an already sent command; this path contains no native create/send/stop operation. / 接管已经提交的命令；此路径不包含原生创建、派工或停止操作。
async function adopt(task, { commandFile, specFile, deliveryFile, round }, {
  inspect = agentInfo, call = api, verify = verifyNative, watch = startWatcher,
  lease = leaseForEvent, alive = processAlive,
} = {}) {
  if (task.agent !== 'zcode') throw new Error('Native command adoption currently supports only ZCode');
  const root = taskDir(task.id), source = localFile(root, commandFile), delivery = localFile(path.join(root, 'deliveries'), deliveryFile);
  const sourceBytes = fs.readFileSync(source), imported = JSON.parse(sourceBytes);
  const envelope = imported.envelope;
  if (envelope?.type !== 'sendText' || envelope.sessionId !== task.workerSessionId
      || !envelope.commandId || typeof envelope.payload?.text !== 'string' || !envelope.payload.text.trim()
      || imported.ack?.commandId !== envelope.commandId || !['accepted', 'duplicate'].includes(imported.ack?.status)) {
    throw new Error('External command identity or admission receipt mismatch');
  }
  if (task.round === round && task.externalCommandAdoption?.commandId === envelope.commandId) {
    if (task.externalCommandAdoption.sourceSha256 !== crypto.createHash('sha256').update(sourceBytes).digest('hex')
        || path.resolve(task.deliveryPath) !== delivery) throw new Error('Adoption replay changed its immutable source or delivery');
    if (task.status === 'running' && !alive(task.watcherPid)) { task.watcherPid = watch(task.id); saveTask(task); }
    return task;
  }
  if (round !== task.round + 1 || !['review_pending', 'blocked', 'failed', 'delivery_missing'].includes(task.status)
      || alive(task.watcherPid)) throw new Error('Adoption requires the next round and a settled coordinator observer');
  const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
  const ownership = lease(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (ownership?.taskId !== task.id || ownership.terminalId !== task.terminalId) throw new Error('Pane lease mismatch');
  if (!['idle', 'done', 'blocked'].includes(agent.agent_status)) throw new Error('Bridge observer is still active; release its Relay seat first');
  const spec = normalizeTaskSpec(readJson(path.resolve(specFile)));
  const evidence = await verify(task, envelope);
  const prefix = `round-${String(round).padStart(3, '0')}`;
  const journal = path.join(root, `${prefix}-zcode-command.json`);
  const existing = readJson(journal, null);
  if (existing && JSON.stringify(existing.envelope) !== JSON.stringify(envelope)) throw new Error('Round already belongs to another command or payload');
  const receipt = { commandId: envelope.commandId, source, sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    round, sessionId: task.workerSessionId, paneId: task.paneId, terminalId: task.terminalId, evidence, timestamp: now() };
  writeJsonAtomic(path.join(root, `${prefix}-zcode-adoption.json`), receipt);
  writeJsonAtomic(journal, { ...imported, status: 'acknowledged', adopted: true });
  task.round = round; task.taskSpec = spec; task.deliveryPath = delivery;
  task.promptPath = path.join(root, `${prefix}-prompt.md`);
  fs.writeFileSync(task.promptPath, envelope.payload.text);
  task.promptBody = envelope.payload.text; task.externalCommandAdoption = receipt;
  task.status = 'running'; task.error = null; delete task.blocker;
  task.observationRequestedAt = now();
  task.submission = { status: 'observed', adopted: true, commandId: envelope.commandId };
  task.notification = { status: 'pending', round };
  task.history.push({ round, status: 'external_command_adopted', commandId: envelope.commandId, timestamp: now() });
  saveTask(task);
  // Resume is a wrapper control line, never the technical task payload. / resume仅是桥接控制行，不是技术任务正文。
  call(task.herdrSession, ['pane', 'send-text', task.paneId, ':resume']);
  call(task.herdrSession, ['pane', 'send-keys', task.paneId, 'enter']);
  task.watcherPid = watch(task.id); saveTask(task);
  event(task, 'external_command_adopted', { commandId: envelope.commandId });
  return task;
}

module.exports = { adopt, verifyNative };
