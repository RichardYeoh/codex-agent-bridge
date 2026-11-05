'use strict';

const path = require('node:path');
const { config, loadTask, saveTask, now, event, readJson } = require('./util');
const { getAgent } = require('./agents');
const { taskList } = require('./worker-scheduling');
const { agentInfo } = require('./herdr');
const { assertWorker } = require('./worker');
const { leasePath } = require('./worker-lease');

function binding(task) {
  return { taskId: task.id, round: task.round, agent: task.agent, cwd: task.cwd, workerSessionId: task.workerSessionId,
    herdrSession: task.herdrSession, paneId: task.paneId, terminalId: task.terminalId };
}
function sameBinding(left, right) { return Object.keys(left).every(key => left[key] === right[key]); }

async function cancelNative(task, { reconcileOnly = false, worker = getAgent(task.agent), load = loadTask, save = saveTask,
  emit = event, list = taskList, inspect = agentInfo, verify = assertWorker,
  lease = value => readJson(leasePath(value.stateDir, value.herdrSession, value.paneId), null) } = {}) {
  if (['accepted', 'cancelled'].includes(task.status)) return task;
  if (typeof worker.cancellationState !== 'function') throw new Error('Agent has no native cancellation confirmation');
  if (path.resolve(task.stateDir) !== path.resolve(config().stateDir)) throw new Error('Cancellation state root mismatch');
  const expected = binding(task), pending = task.status === 'cancel_pending';
  if (pending && task.cancellation && !sameBinding(expected, task.cancellation.binding || {})) {
    throw new Error('Cancellation receipt belongs to a different task round or native session');
  }
  const current = () => {
    const value = load(task.id);
    if (!sameBinding(expected, binding(value))) throw new Error('Cancellation task binding changed; no state overwritten');
    return value;
  };
  const ownership = () => {
    for (const other of list(task.stateDir)) {
      if (other.id === task.id || ['accepted', 'cancelled'].includes(other.status) || other.workerSessionId !== task.workerSessionId) continue;
      if (getAgent(other.agent).id === worker.id) throw new Error('Native session belongs to another unresolved task; inspect ownership first');
    }
  };
  const initial = current();
  if (['accepted', 'cancelled'].includes(initial.status)) return initial;
  if (initial.status !== task.status) throw new Error('Cancellation task state changed; no state overwritten');
  const previous = task.cancellation;
  task.status = 'cancel_pending';
  task.cancellation = { binding: expected, requestedAt: previous?.requestedAt || now(), phase: 'pending',
    interruptAttempted: previous ? previous.interruptAttempted : pending ? null : false,
    interruptAttempts: previous?.interruptAttempts || [], previousWatcherPid: task.watcherPid || previous?.previousWatcherPid || null };
  // A cancelled coordinator invalidates observation, never the native worker or its jobs. / 取消协调状态只使旧观察器失效，不中断原生工作或后台任务。
  task.observerGeneration = (task.observerGeneration || 0) + 1; task.watcherPid = null;
  save(task);
  const finish = async receipt => {
    let latest = current();
    if (latest.status !== 'cancel_pending') throw new Error('Cancellation task state changed; no state overwritten');
    await worker.verifyCancellationReceipt?.(latest, receipt);
    latest = current();
    if (latest.status !== 'cancel_pending') throw new Error('Cancellation task state changed during proof validation');
    const cancellation = task.cancellation;
    Object.assign(task, latest);
    task.status = 'cancelled'; task.error = null; task.watcherPid = null;
    task.cancellation = { ...cancellation, phase: 'confirmed', confirmedAt: now(), source: 'native-api', evidence: receipt };
    task.history ||= [];
    task.history.push({ round: task.round, status: 'cancelled', timestamp: now(), source: 'native-api' });
    save(task); emit(task, 'cancelled');
    return task;
  };
  try {
    let receipt = await worker.cancellationState(task);
    if (receipt.confirmed === true) return await finish(receipt);
    // Recovery and uncertain retries only reconcile; a newer native action must not be interrupted twice. / 恢复和不确定重试只对账，不能重复中断较新的原生工作。
    const attempts = task.cancellation.interruptAttempts;
    const canRetry = typeof worker.turnFingerprint === 'function' && attempts.length < 3;
    if (!reconcileOnly && (task.cancellation.interruptAttempted === false || canRetry)) {
      ownership();
      let nativeAuthorization;
      try { verify(task, inspect(task.herdrSession, task.paneId)); }
      catch (error) {
        if (!['pane_not_found', 'agent_not_found', 'agent_not_registered'].includes(error.herdrCode)
            || !worker.authorizePaneLessInterrupt) throw error;
        nativeAuthorization = await worker.authorizePaneLessInterrupt(task);
      }
      const owner = lease(task);
      if (!owner || owner.taskId !== task.id || owner.terminalId !== task.terminalId || owner.workerSessionId !== task.workerSessionId) {
        throw new Error('Cancellation Pane lease mismatch; no native interrupt attempted');
      }
      current(); ownership();
      const fingerprint = nativeAuthorization?.turnFingerprint || await worker.turnFingerprint?.(task);
      if (attempts.length && (!fingerprint || attempts.at(-1).turnFingerprint !== fingerprint)) {
        throw new Error('Native cancellation turn changed; no repeated interrupt sent');
      }
      if (attempts.length && Date.now() - Date.parse(attempts.at(-1).at) < 1000) {
        throw new Error('Cancellation retry cooldown; reconcile without resending');
      }
      attempts.push({ at: now(), turnFingerprint: fingerprint || null, nativeAuthorization: nativeAuthorization || null });
      task.cancellation.interruptAttempted = true; task.cancellation.interruptRequestedAt = now(); save(task);
      let interruptError;
      try { await worker.cancelWorker(task, { expectedFingerprint: fingerprint }); } catch (error) { interruptError = error; }
      // A lost reply may follow a successful interrupt; inspect once without resending. / 中断已执行也可能丢失回执，只核对一次而不重发。
      receipt = await worker.cancellationState(task);
      if (receipt.confirmed === true) return await finish(receipt);
      if (interruptError) throw interruptError;
    }
    task.cancellation.evidence = receipt;
    throw new Error(`Native cancellation remains unconfirmed (${receipt.reason || 'unknown'})`);
  } catch (error) {
    const latest = current();
    if (latest.status !== 'cancel_pending') throw new Error('Cancellation task state changed; no state overwritten');
    const cancellation = task.cancellation;
    Object.assign(task, latest); task.cancellation = cancellation;
    task.error = `Cancellation not confirmed: ${error.message}`;
    save(task); emit(task, 'cancel_pending', { message: task.error });
    return task;
  }
}

module.exports = { cancelNative };
