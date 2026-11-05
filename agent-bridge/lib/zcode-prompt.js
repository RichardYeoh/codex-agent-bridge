'use strict';

const path = require('node:path');
const { agentInfo, paneInfo, api, resultPayload } = require('./herdr');
const { assertWorker } = require('./worker');
const { leaseForEvent } = require('./worker-lease');
const { config, readJson, taskDir } = require('./util');

function preflightError(message) {
  const error = new Error(message); error.code = 'ZCODE_LOCAL_INPUT_UNCONFIRMED';
  error.origin = 'bridge-preflight'; error.requestSent = false; return error;
}

function receipt(task) {
  const state = readJson(path.join(taskDir(task.id), 'zcode-state.json'), null);
  const lease = leaseForEvent(task.stateDir, task.herdrSession, task.paneId, task.workerSessionId);
  if (task.agent !== 'zcode' || !task.workerSessionId || !state || state.taskId !== task.id
      || state.sessionId !== task.workerSessionId || state.paneId !== task.paneId || state.terminalId !== task.terminalId
      || state.herdrSession !== task.herdrSession || state.state !== 'idle' || state.round !== task.round - 1
      || !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 || !Number.isFinite(Date.parse(state.workerProcessStartedAt || ''))
      || !lease || lease.taskId !== task.id || lease.terminalId !== task.terminalId || lease.workerSessionId !== task.workerSessionId) {
    throw preflightError('ZCode local wrapper lacks a bound idle input receipt; reload only a verified idle local worker before dispatch');
  }
  return state;
}

async function submit(task, _pointer, { inspect = agentInfo, inspectPane = paneInfo, call = api,
  prove = require('./windows-worker-process').proveWorkerProcess } = {}) {
  let started = false;
  try {
    const state = receipt(task);
    const verify = async () => {
      const current = receipt(task);
      if (current.workerPid !== state.workerPid || current.workerProcessStartedAt !== state.workerProcessStartedAt) {
        throw preflightError('ZCode local wrapper process changed before input');
      }
      const agent = assertWorker(task, inspect(task.herdrSession, task.paneId));
      const pane = inspectPane(task.herdrSession, task.paneId);
      // Missing custom-source metadata is covered by the bound receipt and two live process proofs below. / 自定义来源缺字段由绑定回执及下方两次实时进程证明补足。
      if (!['idle', 'done'].includes(agent.agent_status) || agent.agent_session?.value != null && agent.agent_session.value !== task.workerSessionId
          || pane?.pane_id !== task.paneId || pane.terminal_id !== task.terminalId) {
        throw preflightError('ZCode local input Pane identity or readiness is unconfirmed');
      }
      const processInfo = resultPayload(call(task.herdrSession, ['pane', 'process-info', '--pane', task.paneId]))?.process_info;
      const proof = await prove({ kind: 'zcode-wrapper', processInfo, expectedPid: state.workerPid,
        executablePath: process.execPath, scriptPath: path.join(config().root, 'bin', 'zcode-worker.js') });
      if (proof.pid !== state.workerPid || !Number.isFinite(Date.parse(proof.processStartedAt || ''))
          || Math.abs(Date.parse(proof.processStartedAt) - Date.parse(state.workerProcessStartedAt)) > 5000) {
        throw preflightError('ZCode local wrapper process lifetime does not match its receipt');
      }
      return proof;
    };
    const before = await verify();
    // The receiver is our readline wrapper, never a native approval dialog. / 接收端是本工程readline包装器，不是原生审批界面。
    call(task.herdrSession, ['pane', 'send-keys', task.paneId, 'ctrl+u']);
    const after = await verify();
    if (before.pid !== after.pid || before.processStartedAt !== after.processStartedAt) throw preflightError('ZCode wrapper changed during input preflight');
    started = true;
    const cliReceipt = call(task.herdrSession, ['pane', 'run', task.paneId, task.promptPath], { includeTransportReceipt: true });
    const typed = cliReceipt?.transport === 'herdr-cli', response = typed ? cliReceipt.response : cliReceipt;
    if (typed && (cliReceipt.exitCode !== 0 || !Object.hasOwn(cliReceipt, 'response')) || !typed && cliReceipt == null
        || response?.error || response?.result?.error || response?.ok === false || response?.result?.ok === false) {
      throw new Error('ZCode local input acknowledgment is uncertain; no automatic resend');
    }
    // An exit-zero empty response proves transport only, never native admission. / 零退出码空响应仅证明传输，不证明原生接纳。
    return { transport: 'local-wrapper-pane', status: 'text_queued', inputAccepted: true, nativeAcceptanceConfirmed: false,
      transportAcknowledgement: typed ? { transport: 'herdr-cli', exitCode: 0, emptyStdout: response == null } : null,
      processProof: after };
  } catch (error) {
    if (!started) { error.origin = 'bridge-preflight'; error.requestSent = false; }
    else error.transportDiagnostic = { phase: 'pane-run', outcome: 'uncertain', requestSent: true };
    throw error;
  }
}

module.exports = { submit, receipt };
