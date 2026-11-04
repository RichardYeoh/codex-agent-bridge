'use strict';

const { agentInfo } = require('./herdr');
const { assertWorker } = require('./worker');
const { sleep } = require('./util');

async function verifyProcess(task, turn) {
  const attempt = require('./util').readJson(task.submission.file);
  const saved = attempt.processProof || task.submission.inputReceipt?.processProof;
  if (!saved) throw observationError('WORKER_IDENTITY_MISMATCH', 'CBC submitted process proof is unavailable; use explicit native reconciliation');
  const current = await require('./cbc-reconciliation').liveProof(task, {
    phase: 'observing',
    submissionAt: turn.submittedAt,
  });
  if (JSON.stringify(current) !== JSON.stringify(saved)) {
    throw observationError('WORKER_IDENTITY_MISMATCH', 'CBC execution process changed; no result assigned to the old turn');
  }
}

function observationError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Observe exact native input boundaries; Herdr idle alone is never a completion receipt. / 观察精确原生输入边界，Herdr空闲本身不是完成回执。
async function waitExecution(task, { inspect = agentInfo, read = value => require('./cbc-turn').readTurn(value),
  pause = sleep, clock = Date.now, pollMs = 750, admissionMs = 60000, maxReadFailures = 3,
  isActive = () => true, onAdmitted = async () => {}, verify = verifyProcess } = {}) {
  const started = clock(), windowMs = task.waitTimeoutMs ?? 1800000;
  let failures = 0, admitted = false;
  const verifyWithRetry = async turn => {
    for (let attempt = 0; ; attempt += 1) {
      try { await verify(task, turn); return; }
      catch (error) {
        // Retry bounded read failures only, never a denied query or mismatched process. / 仅有界重试读取故障，拒绝访问或进程不符不得重试放行。
        const transient = ['query-timeout', 'query-failed', 'query-unreadable'].includes(error.processProofCode)
          || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code);
        if (!transient || attempt + 1 >= maxReadFailures || !isActive()) throw error;
        await pause(pollMs);
      }
    }
  };
  for (;;) {
    if (!isActive()) return null;
    let agent, turn;
    try {
      agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
      turn = read(task);
      failures = 0;
    } catch (error) {
      if (error.code === 'WORKER_IDENTITY_MISMATCH' || error.code === 'HERDR_IPC_ACCESS_DENIED'
          || ['pane_not_found', 'agent_not_found', 'agent_not_registered'].includes(error.herdrCode)
          || ++failures >= maxReadFailures) throw error;
      await pause(pollMs);
      continue;
    }
    if (turn.state === 'superseded') {
      throw observationError('CBC_TURN_SUPERSEDED', 'A later native input owns this CBC session; the old round was not settled or replayed');
    }
    if (turn.state === 'invalid') throw observationError('CBC_EVIDENCE_INVALID', `CBC evidence is invalid: ${turn.reason || 'identity or journal mismatch'}`);
    if (['active', 'stopped', 'blocked'].includes(turn.state)) {
      if (!admitted) { await verifyWithRetry(turn); await onAdmitted(turn); admitted = true; }
      if (turn.state === 'blocked' && agent.agent_status === 'blocked') return { agent, turn };
      if (turn.state === 'stopped' && ['idle', 'done'].includes(agent.agent_status)) {
        // Re-read both boundaries before returning a terminal candidate. / 返回终态候选前重新读取两个边界。
        const fresh = assertWorker(task, inspect(task.herdrSession, task.paneId)), again = read(task);
        if (again.state === 'superseded') throw observationError('CBC_TURN_SUPERSEDED', 'CBC received another native input before settlement');
        if (again.state === 'stopped' && again.stopAt === turn.stopAt
            && ['idle', 'done'].includes(fresh.agent_status)
            && fresh.state_change_seq === agent.state_change_seq) {
          await verifyWithRetry(again);
          return { agent: fresh, turn: again };
        }
      }
    }
    if (!admitted && clock() - started >= admissionMs) {
      throw observationError('CBC_ADMISSION_UNCONFIRMED', 'No exact CBC input receipt was observed; reconcile the native transcript, never resend');
    }
    if (windowMs > 0 && clock() - started >= windowMs) {
      throw observationError('ETIMEDOUT', 'CBC observation window expired; native execution may continue, no prompt resent');
    }
    await pause(pollMs);
  }
}

module.exports = { waitExecution, verifyProcess };
