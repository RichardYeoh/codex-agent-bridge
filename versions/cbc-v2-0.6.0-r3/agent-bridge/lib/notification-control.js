'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config, ensureDir, now, readJson, withLock, writeJsonAtomic } = require('./util');
const { createQueueClient } = require('./codex-client');

const MAX_WAKE_ATTEMPTS = 3;
const WAKE_RETRY_DELAY_MS = 60_000;

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
        || ['created', 'ready', 'running', 'recovering', 'accepted', 'cancelled', 'abandoned'].includes(task.status)) continue;
    if (task.notification.status === 'acknowledged'
        && (!task.notification.codexThread || task.notification.codexThread === threadId)) continue;
    tasks.push({ id: task.id, round: task.round, status: task.status,
      key: eventKey(task), notificationStatus: task.notification.status,
      notificationLastAttemptAt: task.notification.lastAttemptAt || null,
      notificationQueuedAt: task.notification.queuedAt || null,
      deliveryPath: task.deliveryPath || null });
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

function pendingSignature(pending) {
  return pending.map(task => `${task.id}:${task.key}`).join('\n');
}

function clientMessageId(current, threadId, signature, attempt) {
  // Each deliberate delivery attempt is stable across a lost response. / 每次有意补送均以稳定ID重试，避免响应丢失导致重复写入。
  const bytes = crypto.createHash('sha256')
    .update(`${current.tag}\n${threadId}\n${signature}\n${attempt}`)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function retryDue(lastAttemptAt, delayMs = WAKE_RETRY_DELAY_MS) {
  if (!lastAttemptAt) return true;
  const timestamp = Date.parse(lastAttemptAt);
  // Invalid or future timestamps fail closed so a bad clock cannot trigger a resend loop. / 时间戳无效或位于未来时保守禁止补送，避免时钟异常导致重发循环。
  return Number.isFinite(timestamp) && Date.now() - timestamp >= delayMs;
}

async function reconcileThread(threadId, { allowAdd = false, clientFactory = createQueueClient } = {}) {
  const current = scope(threadId);
  return withLock(`notify-${current.key}`, async () => {
    const control = controlState(threadId);
    const pending = pendingTasks(threadId);
    const signature = pendingSignature(pending);
    if (control.eventSignature !== signature) {
      control.eventSignature = signature;
      control.deliveryAttempts = 0;
      control.pendingAddId = null;
      control.lastAttemptAt = null;
    }
    if (!control.lastAttemptAt) {
      const hints = pending.map(task => task.notificationLastAttemptAt || task.notificationQueuedAt)
        .filter(value => Number.isFinite(Date.parse(value))).sort((left, right) => Date.parse(left) - Date.parse(right));
      if (hints.length) control.lastAttemptAt = hints[hints.length - 1];
    }
    let client;
    let addAttempted = false;
    let added = false;
    let consumed = false;
    try {
      client = await clientFactory();
      let items;
      try { items = await client.list(threadId); }
      catch (error) { error.notificationOperation = 'queue-read'; throw error; }
      const legacy = legacyMessages(threadId);
      const owned = items.filter(item => ownsItem(item, current, legacy));
      const previouslyQueued = Boolean(control.queueId);
      const pendingAddId = control.pendingAddId;
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
        control.pendingAddId = null;
      } else {
        control.queueId = null;
        consumed = Boolean(!control.paused && pending.length && (previouslyQueued
          || pending.some(task => ['queued', 'delivered', 'consumed'].includes(task.notificationStatus))));
        if (!control.paused && pending.length && allowAdd
            && control.deliveryAttempts < MAX_WAKE_ATTEMPTS && retryDue(control.lastAttemptAt)) {
          control.pendingAddId ||= clientMessageId(current, threadId, signature, control.deliveryAttempts + 1);
          control.deliveryAttempts += 1;
          control.lastAttemptAt = now();
          control.updatedAt = control.lastAttemptAt;
          control.pendingCount = pending.length;
          ensureDir(path.dirname(current.file));
          // Persist the bounded attempt and id before the write so a crash can reconcile it safely. / 写入前持久化有界尝试次数与稳定ID，进程中断后可安全对账。
          writeJsonAtomic(current.file, control);
          addAttempted = true;
          const item = await client.add(threadId, wakeMessage(current, threadId, pending), control.pendingAddId);
          control.queueId = item.id;
          control.lastQueuedAt = now();
          control.pendingAddId = null;
          added = true;
          consumed = false;
        }
      }
      control.updatedAt = now();
      control.lastError = null;
      control.pendingCount = pending.length;
      ensureDir(path.dirname(current.file));
      writeJsonAtomic(current.file, control);
      return { ...control, removed, added, consumed, queued: control.queueId ? 1 : 0 };
    } catch (error) {
      control.updatedAt = now();
      control.lastError = error.message;
      writeJsonAtomic(current.file, control);
      error.notificationDeliveryAttempts = control.deliveryAttempts || 0;
      error.notificationLastAttemptAt = control.lastAttemptAt || null;
      if (addAttempted) {
        error.notificationAddAttempted = true;
        error.notificationOperation ||= 'queue-add';
        if (error.deliveryUncertain !== true) {
          control.deliveryAttempts = Math.max(0, (control.deliveryAttempts || 1) - 1);
          control.pendingAddId = null;
          control.lastAttemptAt = null;
          control.updatedAt = now();
          writeJsonAtomic(current.file, control);
          error.notificationDeliveryAttempts = control.deliveryAttempts;
          error.notificationLastAttemptAt = null;
        }
      }
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

module.exports = { scope, eventKey, pendingTasks, controlState, reconcileThread, setPaused, ownsItem,
  MAX_WAKE_ATTEMPTS, WAKE_RETRY_DELAY_MS, retryDue };
