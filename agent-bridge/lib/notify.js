'use strict';

const path = require('node:path');
const { appendJsonl, event, now, saveTask } = require('./util');
const { eventKey, controlState, reconcileThread } = require('./notification-control');

function notificationMessage(task, key) {
  return `[agent-bridge] ${task.agent} ${task.id} r${task.round} ${task.status}; key=${key}`;
}

async function notifyTask(task, options = {}) {
  const key = eventKey(task);
  if (!task.codexThread) {
    task.notification = { key, round: task.round, status: 'pending', error: 'Codex thread ID not configured' };
    saveTask(task);
    return task;
  }
  const prior = task.notification;
  const sameEvent = prior?.key === key && (!prior.codexThread || prior.codexThread === task.codexThread);
  if (['accepted', 'cancelled'].includes(task.status)) return task;
  if (sameEvent && prior.status === 'acknowledged') {
    await reconcileThread(task.codexThread, options);
    return task;
  }
  // Unknown delivery must be reconciled, never blindly resent. / 不确定投递禁止盲目重发。
  const uncertain = sameEvent && ['sending', 'uncertain'].includes(prior.status);
  const allowAdd = !uncertain && !(sameEvent && ['queued', 'delivered'].includes(prior.status));
  task.notification = { ...prior, key, round: task.round, codexThread: task.codexThread,
    status: uncertain ? 'uncertain' : 'pending' };
  saveTask(task);
  if (!sameEvent) appendJsonl(path.join(task.stateDir, 'notifications.ndjson'), {
    timestamp: now(), key, taskId: task.id, round: task.round, status: task.status,
    codexThread: task.codexThread, message: notificationMessage(task, key),
  });
  try {
    const result = await reconcileThread(task.codexThread, { ...options, allowAdd });
    task.notification.status = result.paused ? 'paused' : result.queued ? 'queued'
      : uncertain ? 'uncertain' : sameEvent && prior.status === 'queued' ? 'queued' : 'pending';
    task.notification.queueId = result.queueId;
    task.notification.error = null;
    if (result.queued) {
      task.notification.queuedAt = now();
      task.notifiedEvents ||= {};
      task.notifiedEvents[key] ||= now();
    }
    saveTask(task);
    event(task, `notification_${task.notification.status}`, { key, queueId: result.queueId });
  } catch (error) {
    task.notification.status = error.deliveryUncertain || error.code === 'ETIMEDOUT' ? 'uncertain' : 'pending';
    task.notification.error = error.message;
    saveTask(task);
    event(task, 'notification_pending', { key, reason: error.message });
  }
  return task;
}

async function acknowledgeTask(task, key, options = {}) {
  if (!task.notification || task.notification.key !== key || task.notification.round !== task.round) {
    throw new Error('Stale or unknown notification key; inspect current task before acknowledging');
  }
  task.notification.status = 'acknowledged';
  task.notification.acknowledgedAt = now();
  task.notifiedEvents ||= {};
  task.notifiedEvents[key] = now();
  saveTask(task);
  event(task, 'notification_acknowledged', { key, codexThread: task.codexThread });
  try { await reconcileThread(task.codexThread, options); }
  catch (error) {
    task.notification.cleanupError = error.message;
    saveTask(task);
    event(task, 'notification_cleanup_pending', { key, reason: error.message });
  }
}

module.exports = { notificationMessage, notifyTask, acknowledgeTask };
