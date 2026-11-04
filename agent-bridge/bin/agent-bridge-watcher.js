#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { agentInfo, api, resultPayload, startWatcher } = require('../lib/herdr');
const { event, loadTask, now, readJson, saveTask, taskDir, withLock } = require('../lib/util');
const { notifyTask } = require('../lib/notify');
const { assertWorker, updateWorkerSession } = require('../lib/worker');
const { classifyBlocker } = require('../lib/blocker');
const { getAgent } = require('../lib/agents');
const { recordContext } = require('../lib/worker-context');
const { restoredOwner } = require('../lib/worker-identity');
const { leasePath } = require('../lib/worker-lease');

function observerGeneration(task) { return task.observerGeneration || 0; }

function observerIsCurrent(task, round, generation) {
  return task.round === round && (task.status === 'running'
    || task.agent === 'cbc' && task.cbcTurnProtocol === 1 && task.status === 'submission_unknown')
    && observerGeneration(task) === generation;
}

function bindingChanged(left, right) {
  return left.herdrSession !== right.herdrSession || left.paneId !== right.paneId
    || left.terminalId !== right.terminalId || left.workerSessionId !== right.workerSessionId;
}

function bindingFailure(error) {
  return error?.code === 'WORKER_IDENTITY_MISMATCH'
    || ['pane_not_found', 'agent_not_found', 'agent_not_registered'].includes(error?.herdrCode);
}

function timeoutFailure(error) {
  return error?.code === 'ETIMEDOUT' || error?.herdrCode === 'timeout'
    || /\btimeout\b|timed out/i.test(error?.message || '');
}

function leaseAvailable(task, owner) {
  const lease = readJson(leasePath(task.stateDir, task.herdrSession, owner.pane_id), null);
  if (!lease) return;
  if (!lease.taskId || lease.herdrSession !== task.herdrSession || lease.paneId !== owner.pane_id) {
    throw new Error('Restored Pane lease is malformed; native ownership cannot be confirmed');
  }
  if (lease.workerSessionId !== task.workerSessionId) {
    throw new Error('Restored Pane lease belongs to a different native session');
  }
  if (lease.taskId === task.id) return;
  let other;
  try { other = loadTask(lease.taskId); } catch {}
  if (!other || !['accepted', 'cancelled'].includes(other.status)) {
    throw new Error('Restored Pane lease belongs to another unresolved task');
  }
}

function readTerminal(task) {
  const response = api(task.herdrSession, [
    'agent', 'read', task.paneId, '--source', 'recent-unwrapped', '--lines', '240',
  ], { timeout: 20000 });
  if (typeof response === 'string') return response;
  const payload = resultPayload(response);
  return payload?.read?.text || payload?.text || JSON.stringify(response);
}

function saveTerminal(task) {
  try {
    const text = readTerminal(task);
    const file = path.join(taskDir(task.id), `round-${String(task.round).padStart(3, '0')}-terminal.txt`);
    fs.writeFileSync(file, text);
    task.terminalPath = file;
  } catch (error) {
    event(task, 'terminal_read_failed', { message: error.message });
  }
}

async function failObservation(snapshot, round, generation, error) {
  return withLock(snapshot.id, () => {
    const task = loadTask(snapshot.id);
    if (!observerIsCurrent(task, round, generation)) return null;
    const timedOut = timeoutFailure(error);
    const type = error.code === 'CBC_TURN_SUPERSEDED' ? 'native_turn_superseded'
      : timedOut ? 'wait_timeout' : 'observer_unavailable';
    if (task.agent === 'cbc' && task.cbcTurnProtocol === 1 && task.submission?.status === 'sending') {
      // A dead sender leaves no receipt; observation failure never authorizes another send. / 发送者崩溃没有回执，观察失败绝不授权再次发送。
      task.submission.status = 'uncertain'; task.status = 'submission_unknown';
      require('../lib/submission-attempt').update(task.submission, 'uncertain', { inputWritten: 'unknown',
        errorCode: error.code || 'CBC_OBSERVATION_UNCONFIRMED' });
    } else if (task.status !== 'submission_unknown') task.status = 'blocked';
    task.blocker = { type, requiresAction: true, originalExecutionMayContinue: true };
    if (typeof error.processProofCode === 'string' && /^[a-z-]{1,64}$/.test(error.processProofCode)) {
      task.blocker.processProofCode = error.processProofCode;
    }
    task.watcherPid = null;
    task.observerGeneration = generation + 1;
    task.settlementSeq = (task.settlementSeq || 0) + 1;
    task.error = `Worker observation failed: ${error.message}; execution may continue, no prompt retransmitted`;
    task.history.push({ round, status: task.status, timestamp: now(), message: task.error,
      observerGeneration: generation });
    saveTask(task);
    event(task, 'watcher_failed', { type, message: task.error, observerGeneration: generation });
    return task;
  });
}

async function restartOnRestoredPane(snapshot, round, generation, error) {
  let owner;
  try { owner = restoredOwner(snapshot); }
  catch { return null; }
  const changed = bindingChanged(snapshot, { herdrSession: snapshot.herdrSession,
    paneId: owner.pane_id, terminalId: owner.terminal_id, workerSessionId: owner.agent_session?.value });
  if (!changed && !bindingFailure(error)) return null;

  return withLock(snapshot.id, () => {
    const task = loadTask(snapshot.id);
    if (!observerIsCurrent(task, round, generation)
        || task.workerSessionId !== snapshot.workerSessionId || task.herdrSession !== snapshot.herdrSession) {
      return { stale: true };
    }
    try {
      const verifiedOwner = restoredOwner(task);
      if (verifiedOwner.pane_id !== owner.pane_id || verifiedOwner.terminal_id !== owner.terminal_id
          || verifiedOwner.agent_session?.value !== owner.agent_session?.value
          || verifiedOwner.agent !== owner.agent || verifiedOwner.workspace_id !== owner.workspace_id
          || verifiedOwner.tab_id !== owner.tab_id || verifiedOwner.name !== owner.name) {
        throw new Error('Restored native owner changed during rebind; observation was not attached');
      }
      leaseAvailable(task, verifiedOwner);
      // Rebind only the verified native owner; this never starts an Agent or submits text. / 仅重绑定已核实的原生所有者，不启动Agent或提交文本。
      require('../lib/task-recovery').rebind(task, verifiedOwner);
      task.watcherPid = startWatcher(task.id);
      saveTask(task);
      event(task, 'observer_restarted_after_restore', { paneId: task.paneId,
        terminalId: task.terminalId, observerGeneration: task.observerGeneration });
      return { restarted: true, task };
    } catch (restoreError) {
      task.status = 'blocked';
      task.blocker = { type: 'observer_unavailable', requiresAction: true, originalExecutionMayContinue: true };
      task.error = `Restored worker observation could not be attached: ${restoreError.message}; no prompt retransmitted`;
      task.watcherPid = null;
      task.observerGeneration = observerGeneration(task) + 1;
      task.settlementSeq = (task.settlementSeq || 0) + 1;
      task.history.push({ round, status: task.status, timestamp: now(), message: task.error,
        observerGeneration: generation });
      saveTask(task);
      event(task, 'watcher_failed', { type: 'observer_unavailable', message: task.error,
        observerGeneration: generation });
      return { task };
    }
  });
}

async function notifyAfterUnlock(task) {
  if (!task) return;
  try { await notifyTask(task); }
  catch (error) {
    await withLock(task.id, () => {
      const current = loadTask(task.id);
      if (current.round === task.round && current.status === task.status) {
        event(current, 'notification_failed', { message: error.message });
      }
    });
  }
}

async function main() {
  const taskId = process.argv[2];
  const task = loadTask(taskId);
  if (!observerIsCurrent(task, task.round, observerGeneration(task))) return;
  const round = task.round;
  const generation = observerGeneration(task);
  const snapshot = { ...task };

  let response;
  try {
    const timeoutMs = task.waitTimeoutMs ?? 1800000;
    const waitArgs = [
      'agent', 'wait', task.paneId,
      '--until', 'idle', '--until', 'done', '--until', 'blocked',
    ];
    if (timeoutMs > 0) waitArgs.push('--timeout', String(timeoutMs));
    response = task.agent === 'cbc' && task.cbcTurnProtocol === 1
      ? await require('../lib/cbc-observation').waitExecution(task, {
        isActive: () => observerIsCurrent(loadTask(taskId), round, generation),
        onAdmitted: turn => withLock(taskId, () => {
          const current = loadTask(taskId);
          if (!observerIsCurrent(current, round, generation)) return;
          const freshTurn = require('../lib/cbc-turn').readTurn(current);
          if (!['active', 'stopped', 'blocked'].includes(freshTurn.state)
              || freshTurn.attemptId !== turn.attemptId || freshTurn.submittedAt !== turn.submittedAt) {
            throw new Error('CBC native input evidence changed before acknowledgement');
          }
          if (['sending', 'uncertain'].includes(current.submission?.status)) {
            current.submission = { ...current.submission, status: 'observed', reconciledFrom: current.submission.status,
              nativeTurnObserved: true, nativeReceipt: freshTurn };
            current.status = 'running'; current.error = null;
            saveTask(current);
            event(current, 'cbc_submission_reconciled', { source: 'exact-native-hook', noPromptSent: true });
          }
        }),
      })
      : task.agent === 'zcode'
      ? { agent: await require('../lib/zcode-settlement').waitExecution(task, { isActive: () => {
        const current = loadTask(taskId);
        return current.round === round && current.status === 'running'
          && observerGeneration(current) === generation;
      } }) }
      : api(task.herdrSession, waitArgs, { timeout: timeoutMs > 0 ? timeoutMs + 5000 : 0 });
  } catch (error) {
    const restored = await restartOnRestoredPane(snapshot, round, generation, error);
    if (restored?.restarted || restored?.stale) return;
    if (restored?.task) { await notifyAfterUnlock(restored.task); return; }
    await notifyAfterUnlock(await failObservation(snapshot, round, generation, error));
    return;
  }

  let current = loadTask(taskId);
  if (!observerIsCurrent(current, round, generation)) return;
  let agent;
  try {
    const waitedAgent = resultPayload(response)?.agent;
    const liveAgent = agentInfo(current.herdrSession, current.paneId);
    assertWorker(current, liveAgent);
    agent = current.agent === 'cbc' ? liveAgent : waitedAgent ? assertWorker(current, waitedAgent) : liveAgent;
    if (current.agent === 'cbc' && waitedAgent) assertWorker(current, waitedAgent);
    if (waitedAgent && waitedAgent.terminal_id !== liveAgent.terminal_id) {
      throw Object.assign(new Error('Worker Pane terminal changed after wait observation'), { code: 'WORKER_IDENTITY_MISMATCH' });
    }
    if (current.agent === 'cbc' && !['idle', 'done', 'blocked'].includes(liveAgent.agent_status)) {
      throw new Error('Live worker is still active after the wait snapshot; no completion claimed');
    }
  } catch (error) {
    const restored = await restartOnRestoredPane(current, round, generation, error);
    if (restored?.restarted || restored?.stale) return;
    if (restored?.task) { await notifyAfterUnlock(restored.task); return; }
    await notifyAfterUnlock(await failObservation(current, round, generation, error));
    return;
  }

  let notificationTask = null;
  try {
    await withLock(taskId, () => {
      current = loadTask(taskId);
      if (!observerIsCurrent(current, round, generation)) return;
      if (current.agent === 'cbc' && current.cbcTurnProtocol === 1) {
        // Fresh native turn and live state win over the earlier wait snapshot. / 最新原生回合和实时状态优先于此前等待快照。
        agent = assertWorker(current, agentInfo(current.herdrSession, current.paneId));
        if (!Number.isSafeInteger(response?.agent?.state_change_seq)
            || agent.state_change_seq !== response.agent.state_change_seq) {
          throw new Error('CBC live state sequence changed after terminal observation; no completion claimed');
        }
        const turn = require('../lib/cbc-turn').readTurn(current);
        if (turn.state === 'superseded') throw Object.assign(new Error('New native input superseded this round before settlement'), { code: 'CBC_TURN_SUPERSEDED' });
        if (!(turn.state === 'blocked' && agent.agent_status === 'blocked')
            && !(turn.state === 'stopped' && ['idle', 'done'].includes(agent.agent_status))) {
          throw new Error('CBC native terminal receipt and current idle state no longer agree; no completion claimed');
        }
        current.cbcTurnReceipt = turn;
        if (turn.state === 'stopped' && current.deliveryPath && fs.existsSync(current.deliveryPath)) {
          const stat = fs.statSync(current.deliveryPath);
          if (stat.size === 0 || stat.mtimeMs < Date.parse(turn.submittedAt)
              || stat.mtimeMs > Date.parse(turn.stopAt)) {
            throw new Error('CBC delivery is empty or outside the exact native turn; inspect before late-delivery settle');
          }
        }
      }
      assertWorker(current, agent);
      if (agent.tab_id) current.tabId = agent.tab_id;
      current.completionSeq = agent.completion_seq || null;
      const promptContext = getAgent(current.agent).readPromptContext?.(current);
      if (promptContext) current.promptContext = promptContext;
      updateWorkerSession(current);
      saveTerminal(current);

      if (agent.agent_status === 'blocked') {
        current.status = 'blocked';
        current.blocker = getAgent(current.agent).readBlocker?.(current)
          || classifyBlocker(current.terminalPath ? fs.readFileSync(current.terminalPath, 'utf8') : '');
        current.error = current.blocker?.message || `${current.agent} requires permission or user input; inspect the Herdr pane`;
      } else if (!current.deliveryPath || !fs.existsSync(current.deliveryPath)) {
        const blocker = classifyBlocker(current.terminalPath ? fs.readFileSync(current.terminalPath, 'utf8') : '');
        current.status = blocker ? 'blocked' : 'delivery_missing';
        current.blocker = blocker;
        current.error = blocker?.message || `${current.agent} became idle without writing the required delivery report`;
      } else {
        current.status = 'review_pending';
        current.error = null;
      }
      current.watcherPid = null;
      current.observerGeneration = generation + 1;
      current.settlementSeq = (current.settlementSeq || 0) + 1;
      current.history.push({ round, status: current.status, timestamp: now(), completionSeq: current.completionSeq,
        observerGeneration: generation });
      saveTask(current);
      notificationTask = current;
      recordContext(current);
      event(current, 'settled', { status: current.status, completionSeq: current.completionSeq,
        observerGeneration: generation });
    });
  } catch (error) {
    if (!notificationTask) {
      const latest = loadTask(taskId);
      if (!observerIsCurrent(latest, round, generation)) return;
      const restored = await restartOnRestoredPane(latest, round, generation, error);
      if (restored?.restarted || restored?.stale) return;
      if (restored?.task) { notificationTask = restored.task; }
      else notificationTask = await failObservation(latest, round, generation, error);
    }
  }
  await notifyAfterUnlock(notificationTask);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
