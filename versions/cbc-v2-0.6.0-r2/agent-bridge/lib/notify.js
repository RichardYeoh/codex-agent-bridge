'use strict';

const path = require('node:path');
const { appendJsonl, event, now, readJson, saveTask, taskFile, withLock } = require('./util');
const { eventKey, reconcileThread, retryDue } = require('./notification-control');

function notificationMessage(task, key) {
  return `[agent-bridge] ${task.agent} ${task.id} r${task.round} ${task.status}; key=${key}`;
}

function readCurrent(task) {
  return readJson(taskFile(task.id), null) || { ...task };
}

async function commitNotification(task, key, round, update) {
  return withLock(task.id, () => {
    const current = readCurrent(task);
    if (current.round !== round || eventKey(current) !== key
        || ['accepted', 'cancelled', 'abandoned'].includes(current.status)
        || current.notification?.status === 'acknowledged') {
      return { stale: true, task: current };
    }
    update(current);
    saveTask(current);
    Object.assign(task, current);
    return { stale: false, task: current };
  });
}

async function reconcileAfterStale(current, options) {
  if (!current.codexThread) return;
  try { await reconcileThread(current.codexThread, { ...options, allowAdd: false }); }
  catch {}
}

async function notifyTask(task, options = {}) {
  const key = eventKey(task), round = task.round;
  let context;
  await withLock(task.id, () => {
    const current = readCurrent(task);
    if (current.round !== round || eventKey(current) !== key) {
      context = { stale: true, current };
      return;
    }
    Object.assign(task, current);
    if (['accepted', 'cancelled', 'abandoned'].includes(current.status)) {
      context = { terminal: true, current };
      return;
    }
    const prior = current.notification;
    const sameEvent = prior?.key === key && (!prior.codexThread || prior.codexThread === current.codexThread);
    if (!current.codexThread) {
      current.notification = { key, round, status: 'pending', error: 'Codex thread ID not configured' };
      saveTask(current);
      Object.assign(task, current);
      context = { noThread: true, current };
      return;
    }
    if (sameEvent && prior.status === 'acknowledged') {
      context = { acknowledged: true, current };
      return;
    }
    // Unknown delivery must be reconciled, never blindly resent. / 不确定投递禁止盲目重发。
    const uncertain = sameEvent && ['sending', 'uncertain'].includes(prior.status);
    let lastAttemptAt = sameEvent ? (prior.lastAttemptAt || prior.queuedAt || null) : null;
    if (uncertain && !lastAttemptAt) lastAttemptAt = now();
    // reconcileThread always lists first; it may add only after a successful absence check and within its persisted retry budget. / reconcileThread始终先查询队列，仅在成功确认缺项且仍在持久化重试额度内时补送。
    const allowAdd = !sameEvent || retryDue(lastAttemptAt);
    current.notification = { ...prior, key, round, codexThread: current.codexThread,
      status: sameEvent ? prior.status : 'pending',
      ...(sameEvent ? { lastAttemptAt } : {
        deliveryAttempts: 0, lastAttemptAt: null, queuedAt: null, queueAbsentAt: null, acknowledgedAt: null,
      }) };
    saveTask(current);
    Object.assign(task, current);
    if (!sameEvent) appendJsonl(path.join(current.stateDir, 'notifications.ndjson'), {
      timestamp: now(), key, taskId: current.id, round: current.round, status: current.status,
      codexThread: current.codexThread, message: notificationMessage(current, key),
    });
    context = { current, prior, sameEvent, uncertain, allowAdd, threadId: current.codexThread };
  });
  if (context.stale) {
    Object.assign(task, context.current);
    await reconcileAfterStale(context.current, options);
    return task;
  }
  if (context.terminal || context.noThread) return task;
  if (context.acknowledged) {
    await reconcileThread(context.threadId || task.codexThread, { ...options, allowAdd: false });
    return task;
  }
  try {
    const result = await reconcileThread(context.threadId, { ...options, allowAdd: context.allowAdd });
    const merged = await commitNotification(task, key, round, current => {
      const notification = current.notification || {};
      notification.status = result.paused ? 'paused' : result.queued ? 'queued'
        : result.consumed ? 'consumed' : context.uncertain ? 'uncertain' : 'pending';
      notification.queueId = result.queueId;
      notification.error = null;
      notification.deliveryAttempts = result.deliveryAttempts || 0;
      notification.lastAttemptAt = result.lastAttemptAt || notification.lastAttemptAt || null;
      notification.queueAbsentAt = result.consumed ? now() : null;
      if (result.queued) {
        notification.queuedAt = now();
        current.notifiedEvents ||= {};
        current.notifiedEvents[key] ||= now();
      }
      current.notification = notification;
      event(current, `notification_${notification.status}`, { key, queueId: result.queueId });
    });
    if (merged.stale) {
      Object.assign(task, merged.task);
      await reconcileAfterStale(merged.task, options);
    }
  } catch (error) {
    const merged = await commitNotification(task, key, round, current => {
      const notification = current.notification || {};
      // Read-only queue failures cannot prove that an add was written. / 只读队列查询失败不能证明发生过写入。
      notification.status = error.notificationOperation === 'queue-read' && context.sameEvent
        && ['queued', 'consumed', 'uncertain', 'sending'].includes(context.prior?.status)
        ? context.prior.status : error.deliveryUncertain === true ? 'uncertain' : 'pending';
      notification.deliveryAttempts = error.notificationDeliveryAttempts ?? notification.deliveryAttempts ?? 0;
      notification.lastAttemptAt = error.notificationLastAttemptAt || notification.lastAttemptAt || null;
      notification.error = error.message;
      current.notification = notification;
      event(current, 'notification_pending', { key, reason: error.message });
    });
    if (merged.stale) {
      Object.assign(task, merged.task);
      await reconcileAfterStale(merged.task, options);
    }
  }
  return task;
}

async function acknowledgeTask(task, key, options = {}) {
  const round = task.round;
  const accepted = await withLock(task.id, () => {
    const current = readCurrent(task);
    if (!current.notification || current.notification.key !== key || current.notification.round !== current.round
        || current.round !== round || eventKey(current) !== key) {
      throw new Error('Stale or unknown notification key; inspect current task before acknowledging');
    }
    current.notification.status = 'acknowledged';
    current.notification.acknowledgedAt = now();
    current.notifiedEvents ||= {};
    current.notifiedEvents[key] = current.notification.acknowledgedAt;
    saveTask(current);
    event(current, 'notification_acknowledged', { key, codexThread: current.codexThread });
    Object.assign(task, current);
    return current;
  });
  try { await reconcileThread(accepted.codexThread, { ...options, allowAdd: false }); }
  catch (error) {
    await withLock(task.id, () => {
      const current = readCurrent(task);
      if (current.notification?.key !== key || current.notification.status !== 'acknowledged') return;
      current.notification.cleanupError = error.message;
      saveTask(current);
      event(current, 'notification_cleanup_pending', { key, reason: error.message });
      Object.assign(task, current);
    });
  }
  return task;
}

module.exports = { notificationMessage, notifyTask, acknowledgeTask };
