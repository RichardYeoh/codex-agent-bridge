'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config, ensureDir, now, readJson, withLock, writeJsonAtomic } = require('./util');
const { createQueueClient } = require('./codex-client');

function scope(threadId) {
  if (!threadId) throw new Error('A Codex thread ID is required');
  const root = path.resolve(config().stateDir);
  const tag = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const key = crypto.createHash('sha256').update(threadId).digest('hex').slice(0, 24);
  return { root, tag, key, file: path.join(root, 'notification-control', `${key}.json`) };
}

function eventKey(task) {
  const revision = task.settlementSeq ? `:s${task.settlementSeq}` : '';
  return `${task.round}:${task.status}:${task.completionSeq || 'none'}${revision}`;
}

function pendingTasks(threadId) {
  const root = path.join(config().stateDir, 'tasks');
  const tasks = [];
  for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const task = readJson(path.join(root, id, 'task.json'), null);
    if (!task || task.codexThread !== threadId || !task.notification
        || task.notification.round !== task.round
        || ['created', 'ready', 'running', 'recovering', 'accepted', 'cancelled'].includes(task.status)) continue;
    if (task.notification.status === 'acknowledged'
        && (!task.notification.codexThread || task.notification.codexThread === threadId)) continue;
    tasks.push({ id: task.id, round: task.round, status: task.status,
      key: eventKey(task), deliveryPath: task.deliveryPath || null });
  }
  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

function controlState(threadId) {
  const current = scope(threadId);
  return readJson(current.file, { threadId, paused: false });
}

function legacyMessages(threadId) {
  const file = path.join(config().stateDir, 'notifications.ndjson');
  const messages = new Set();
  if (!fs.existsSync(file)) return messages;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      if (entry.codexThread === threadId && typeof entry.message === 'string') messages.add(entry.message);
    } catch {}
  }
  return messages;
}

function itemText(item) {
  return item.input?.length === 1 && item.input[0].type === 'text' ? item.input[0].text : null;
}

function ownsItem(item, current, legacy) {
  const text = itemText(item);
  return typeof text === 'string' && (legacy.has(text)
    || text.startsWith(`[agent-bridge:${current.tag}]\n状态根：${current.root}\n`));
}

function wakeMessage(current, threadId, pending) {
  const bridge = path.join(config().root, 'bin', 'agent-bridge.js');
  return [
    `[agent-bridge:${current.tag}]`, `状态根：${current.root}`,
    `待审阅：${pending.map(task => `${task.id}/r${task.round}/${task.status}`).join('；')}`,
    `先设置 AGENT_BRIDGE_STATE_DIR，再运行 node "${bridge}" notifications pending --codex-thread ${threadId}。`,
    '仅处理该命令当前返回的任务和事件key，再ack并独立验收。已确认、已接受或过期事件不重复回复，不按旧提醒里的轮次重做。',
  ].join('\n');
}

async function reconcileThread(threadId, { allowAdd = false, clientFactory = createQueueClient } = {}) {
  const current = scope(threadId);
  return withLock(`notify-${current.key}`, async () => {
    const control = controlState(threadId);
    const pending = pendingTasks(threadId);
    let client;
    try {
      client = await clientFactory();
      const items = await client.list(threadId);
      const legacy = legacyMessages(threadId);
      const owned = items.filter(item => ownsItem(item, current, legacy));
      const retain = !control.paused && pending.length ? owned.shift() : null;
      let removed = 0;
      for (const item of owned) {
        const result = await client.remove(threadId, item.id);
        if (result.deleted) removed += 1;
      }
      if (retain) {
        const message = wakeMessage(current, threadId, pending);
        if (itemText(retain) !== message) await client.update(threadId, retain.id, message);
        control.queueId = retain.id;
      } else if (!control.paused && pending.length && allowAdd) {
        const item = await client.add(threadId, wakeMessage(current, threadId, pending), crypto.randomUUID());
        control.queueId = item.id;
      } else control.queueId = null;
      control.updatedAt = now();
      control.lastError = null;
      control.pendingCount = pending.length;
      ensureDir(path.dirname(current.file));
      writeJsonAtomic(current.file, control);
      return { ...control, removed, queued: control.queueId ? 1 : 0 };
    } catch (error) {
      control.updatedAt = now();
      control.lastError = error.message;
      writeJsonAtomic(current.file, control);
      throw error;
    } finally { client?.close(); }
  });
}

async function setPaused(threadId, paused, options = {}) {
  const current = scope(threadId);
  await withLock(`notify-${current.key}`, () => {
    writeJsonAtomic(current.file, { ...controlState(threadId), threadId, paused, updatedAt: now() });
  });
  try { return await reconcileThread(threadId, { ...options, allowAdd: !paused }); }
  catch (error) { return { ...controlState(threadId), purgeError: error.message }; }
}

module.exports = { scope, eventKey, pendingTasks, controlState, reconcileThread, setPaused, ownsItem };
