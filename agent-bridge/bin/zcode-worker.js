#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { api } = require('../lib/herdr');
const { loadTask, taskDir, writeJsonAtomic, readJson, now, config } = require('../lib/util');
const { leaseForEvent } = require('../lib/worker-lease');
const { ZCodeRemote, Conversation, readBinding, selectedModel, turnState, needsFullContext } = require('../lib/zcode-remote');
const { renderRoundInstructions } = require('../lib/worker-policy');
const { queryAdmission, observeExecution } = require('../lib/zcode-observation');
const { diagnostic, failureReason } = require('../lib/zcode-errors');
const readiness = require('../lib/zcode-readiness');

let sessionId = process.argv[2] || null;
let remote, conversation, activeTask, busy = true, stopping = false, sequence = Date.now();
let cancelRequested = false, activeEnvelope = null, admission = null;
let stage = 'startup', lastTransportFault = null;

function task() {
  const lease = leaseForEvent(config().stateDir, process.env.AGENT_BRIDGE_HERDR_SESSION,
    process.env.HERDR_PANE_ID, sessionId);
  const current = loadTask(lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID);
  if (current.paneId !== process.env.HERDR_PANE_ID
      || current.herdrSession !== process.env.AGENT_BRIDGE_HERDR_SESSION
      || sessionId && current.workerSessionId && current.workerSessionId !== sessionId) {
    throw new Error('ZCode worker binding identity mismatch');
  }
  return current;
}

function report(state, detail = {}) {
  const current = activeTask || task();
  const receipt = { timestamp: now(), taskId: current.id, herdrSession: current.herdrSession,
    paneId: current.paneId, sessionId, name: state === 'working' ? 'UserPromptSubmit' : state === 'blocked' ? 'Notification' : 'Stop',
    source: 'zcode-v4', round: current.round, terminalId: current.terminalId,
    commandId: activeEnvelope?.commandId || null, commandSha256: readiness.envelopeDigest(activeEnvelope),
    workerPid: process.pid, readinessProtocol: readiness.protocol,
    agent: 'zcode', cwd: current.cwd, promptContext: current.promptContext, ...detail };
  fs.appendFileSync(path.join(current.stateDir, 'hook-events.ndjson'), `${JSON.stringify(receipt)}\n`);
  writeJsonAtomic(path.join(taskDir(current.id), 'zcode-state.json'), { ...receipt, state });
  const args = ['pane', 'report-agent', current.paneId, '--source', 'custom:agent-bridge-zcode',
    '--agent', 'zcode', '--state', state, '--seq', String(++sequence)];
  if (sessionId) args.push('--agent-session-id', sessionId);
  api(current.herdrSession, args);
  process.stdout.write(`zcode: ${state}${detail.reason ? ` (${detail.reason})` : ''}\n`);
}

function journalPath(current) { return path.join(taskDir(current.id), `round-${String(current.round).padStart(3, '0')}-zcode-command.json`); }

function reportFailure(error, fallback) {
  const detail = diagnostic(error, stage, lastTransportFault);
  const current = activeTask || task();
  fs.appendFileSync(path.join(taskDir(current.id), 'zcode-errors.ndjson'), `${JSON.stringify({ timestamp: now(),
    taskId: current.id, round: current.round, paneId: current.paneId, terminalId: current.terminalId,
    sessionId, commandId: activeEnvelope?.commandId, ...detail })}\n`);
  process.stdout.write(`ZCode ${stage}: ${detail.message}\n`);
  report('blocked', { reason: failureReason(lastTransportFault, failureReason(error, fallback)), diagnostic: detail, originalExecutionMayContinue: true });
}

async function attach(current, create) {
  stage = 'connect'; lastTransportFault = null;
  remote = new ZCodeRemote(readBinding(current.zcodeConfig));
  // Faults stay observable even between awaited calls. / 等待调用之间出现故障也保持可观察。
  remote.on('fault', error => { lastTransportFault = error; });
  await remote.connect();
  stage = 'attach-project';
  await remote.attachProject(current.cwd, { create });
}

async function subscribe() {
  stage = 'subscribe';
  conversation = new Conversation(remote, sessionId);
  conversation.on('fault', () => {});
  return conversation.subscribe();
}

async function detach() {
  const previousConversation = conversation, previousRemote = remote;
  conversation = null; remote = null;
  await previousConversation?.dispose(); previousRemote?.close();
}

async function recoverAdmission(current, envelope, error) {
  if (error && /KICKED|AUTH_FAILED|WRONG_PARAM/.test(error.message)) throw error;
  return queryAdmission(() => remote, envelope, { reconnect: async () => {
    await detach(); await attach(current, false);
  } });
}

async function observe(current, envelope) {
  stage = 'observe';
  let lastCheckpoint = 0;
  const observationPath = path.join(taskDir(current.id), `round-${String(current.round).padStart(3, '0')}-zcode-observation.json`);
  const previous = readJson(observationPath, null);
  const { result, interaction, foreignWork } = await observeExecution({ getConversation: () => conversation,
    sessionId, commandId: envelope.commandId, timeoutMs: current.waitTimeoutMs || 1800000,
    initialHeaderRowId: previous?.sessionId === sessionId && previous.commandId === envelope.commandId
      ? previous.result?.headerRowId ?? previous.result?.header?.rowId : undefined,
    refresh: async () => { await conversation.dispose(); await subscribe(); stage = 'observe'; },
    reconnect: async () => { await detach(); await attach(current, false); await subscribe(); stage = 'observe'; },
    checkpoint: ({ result: observed, snapshot }) => {
      if (!observed.terminal && Date.now() - lastCheckpoint < 10000) return;
      lastCheckpoint = Date.now();
      writeJsonAtomic(observationPath, {
        taskId: current.id, round: current.round, sessionId, commandId: envelope.commandId,
        paneId: current.paneId, terminalId: current.terminalId, timestamp: now(),
        result: observed, phase: snapshot.control.phase,
      });
    },
  });
  if (interaction) {
    report('blocked', { reason: 'interaction_required', originalExecutionMayContinue: true });
    return;
  }
  if (foreignWork) {
    report('blocked', { reason: 'untracked_command_active', originalExecutionMayContinue: true });
    return;
  }
  const prior = readJson(journalPath(current), {});
  writeJsonAtomic(journalPath(current), { ...prior, envelope, status: 'terminal', turnState: result.state, timestamp: now() });
  if (result.state === 'failed') report('blocked', { reason: result.error?.code || 'runtime_failed', originalExecutionMayContinue: false });
  else if (result.state === 'completedInterrupted') report('blocked', { reason: 'execution_interrupted', originalExecutionMayContinue: false });
  else report('idle', { turnState: result.state });
}

async function initialize() {
  stage = 'initialize'; lastTransportFault = null;
  busy = true;
  activeTask = task();
  activeEnvelope = activeTask.round > 0 ? readJson(journalPath(activeTask), null)?.envelope : null;
  if (activeEnvelope && sessionId && activeEnvelope.sessionId !== sessionId) throw new Error('ZCode command session identity mismatch');
  await attach(activeTask, !sessionId);
  if (!sessionId) {
    const file = path.join(taskDir(activeTask.id), 'zcode-create.json');
    let stored = readJson(file, null);
    if (!stored) {
      stored = { envelope: remote.envelope('createSession', null, {
        workspaceId: activeTask.cwd, additionalDirectories: [taskDir(activeTask.id)],
        config: { modelSelection: selectedModel(activeTask.model || undefined, activeTask.effort || undefined), mode: 'edit' },
      }), status: 'prepared' };
      writeJsonAtomic(file, stored);
    }
    let ack = stored.ack;
    if (!ack && stored.status === 'sending') ack = await recoverAdmission(activeTask, stored.envelope);
    if (!ack) {
      stored.status = 'sending'; writeJsonAtomic(file, stored);
      try { ack = await remote.command(stored.envelope); }
      catch (error) { ack = await recoverAdmission(activeTask, stored.envelope, error); }
    }
    if (!['accepted', 'duplicate'].includes(ack.status) || !ack.result?.sessionId) throw new Error('ZCode session creation rejected');
    sessionId = ack.result.sessionId;
    writeJsonAtomic(file, { ...stored, status: 'acknowledged', ack });
  }
  await subscribe();
  const prior = activeTask.round > 0 ? readJson(journalPath(activeTask), null) : null;
  if (prior && !['accepted', 'cancelled'].includes(activeTask.status)) {
    if (prior.envelope.sessionId !== sessionId) throw new Error('ZCode command session identity mismatch');
    activeEnvelope = prior.envelope;
    if (readiness.failedAdmission(prior)) {
      stage = 'readiness';
      const proof = await readiness.verifyNativeReady(activeTask, prior, remote, conversation);
      if (['failed', 'completedInterrupted'].includes(proof.previous?.state)) {
        await detach(); activeTask = null; busy = false;
        // Ready for explicit rework is not a successful execution outcome. / 可接受明确返工不等于原执行成功。
        report('idle', { purpose: 'submission_ready', previousExecution: proof.previous, readiness: proof,
          originalExecutionMayContinue: false });
        return;
      }
    }
    report('working');
    if (cancelRequested) void stop();
    await observe(activeTask, prior.envelope);
  } else report('idle');
  await detach(); activeTask = null; busy = false;
}

async function submit(file) {
  if (busy) { process.stdout.write('zcode: busy; no input was sent\n'); return; }
  busy = true; activeTask = task();
  cancelRequested = false; activeEnvelope = null; admission = null;
  try {
    if (path.resolve(file) !== path.resolve(activeTask.promptPath || '')) throw new Error('Unexpected ZCode task file');
    const existing = readJson(journalPath(activeTask), null);
    if (existing) throw new Error('ZCode round already has a command; recover or explicitly rework');
    report('working');
    await attach(activeTask, false); await subscribe();
    if (cancelRequested) { report('idle', { stopped: true, submitted: false }); return; }
    const snapshot = conversation.snapshot;
    // Reconnected snapshots may reveal compaction missed while detached. / 重连快照可能显示离线期间发生的上下文压缩。
    if (activeTask.promptContext?.mode === 'delta' && needsFullContext(snapshot)) {
      activeTask.promptContext = { mode: 'full', reason: 'ZCode compaction or incomplete history window' };
      fs.writeFileSync(file, `${renderRoundInstructions(activeTask)}\n${activeTask.promptBody || activeTask.taskSpec.goal}\n`);
      report('working');
    }
    readiness.assertQuiescent(activeTask, snapshot);
    const mode = activeTask.skipPermissions ? 'yolo'
      : activeTask.permissionMode === 'acceptEdits' ? 'edit' : activeTask.permissionMode;
    if (!['edit', 'yolo', 'guarded', 'plan', 'build'].includes(mode)) throw new Error('Unsupported ZCode permission mode');
    const envelope = remote.envelope('sendText', sessionId, {
      text: fs.readFileSync(file, 'utf8'), mode,
      modelSelection: selectedModel(activeTask.model || undefined, activeTask.effort || undefined),
    });
    // Persist before send; never retry an ambiguous write with a new command ID. / 先落盘再发送，写入不确定时不换命令ID重发。
    writeJsonAtomic(journalPath(activeTask), { envelope, status: 'sending', timestamp: now() });
    activeEnvelope = envelope;
    report('working');
    admission = remote.command(envelope);
    let ack;
    try { ack = await admission; }
    catch (error) {
      ack = await recoverAdmission(activeTask, envelope, error);
      if (!conversation) await subscribe();
    }
    writeJsonAtomic(journalPath(activeTask), { envelope, status: 'acknowledged', ack, timestamp: now() });
    if (readiness.failedAdmission({ envelope, ack })) {
      report('blocked', { reason: ack.reasonCode, admissionRejected: true, originalExecutionMayContinue: false });
      return;
    }
    if (!['accepted', 'duplicate'].includes(ack.status)) throw new Error(`ZCode command ${ack.status}: ${ack.reasonCode || 'rejected'}`);
    await observe(activeTask, envelope);
  } catch (error) {
    reportFailure(error, 'execution_unconfirmed');
  } finally {
    busy = false;
    if (!stopping) { await detach(); activeTask = null; activeEnvelope = null; admission = null; }
  }
}

async function stop() {
  if (stopping) return;
  cancelRequested = true;
  // Admission may still be connecting; submit checks this flag before any write. / 接入可能仍在连接，提交在实际写入前检查取消标志。
  if (busy && (!conversation || !activeEnvelope)) return;
  stopping = true;
  try {
    const current = activeTask || task();
    if (!remote) { await attach(current, false); await subscribe(); }
    const envelope = activeEnvelope || readJson(journalPath(current), null)?.envelope;
    if (admission) await admission;
    if (envelope) await conversation.wait(s => turnState(s, envelope.commandId).seen, 10000);
    if (conversation.snapshot.control.canStop) {
      const stopEnvelope = remote.envelope('stop', sessionId, {});
      writeJsonAtomic(path.join(taskDir(current.id), 'zcode-stop.json'), { envelope: stopEnvelope });
      const ack = await remote.command(stopEnvelope);
      if (!['accepted', 'noop', 'duplicate'].includes(ack.status)) throw new Error('ZCode stop rejected');
      await conversation.wait(s => !s.control.canStop && s.control.activeWorks.length === 0, 10000);
    }
    report('idle', { stopped: true });
  } catch { report('blocked', { reason: 'stop_unconfirmed', originalExecutionMayContinue: true }); }
  finally { if (!busy) { await detach(); activeTask = null; activeEnvelope = null; admission = null; } stopping = false; }
}

async function initializationFailed(error, startup = false) {
  const recoverable = sessionId && activeEnvelope?.sessionId === sessionId;
  try { reportFailure(error, startup ? 'startup_failed' : 'recovery_unconfirmed'); }
  finally {
    await detach(); busy = false; activeTask = null;
    // A known session stays detached and can accept a later explicit resume. / 已知会话保持脱离，允许后续显式resume。
    if (startup && !recoverable) { process.exitCode = 1; input.close(); }
  }
}

async function prepareRetry(requestId) {
  const current = task(), target = readiness.files(current), request = readJson(target.request, null);
  const journal = readJson(target.journal, null), expected = readiness.binding(current, journal);
  if (!request || request.requestId !== requestId || request.protocol !== readiness.protocol
      || !readiness.matches(expected, request) || request.expiresAt <= Date.now()) return;
  const cached = readJson(target.receipt, null);
  if (cached?.requestId === requestId && cached.expiresAt === request.expiresAt && readiness.matches(expected, cached)) return;
  const receipt = { ...request, workerPid: process.pid, ready: false };
  if (busy || stopping) {
    writeJsonAtomic(target.receipt, { ...receipt, reason: 'worker_busy; existing execution not interrupted' }); return;
  }
  busy = true; activeTask = current; activeEnvelope = journal?.envelope || null;
  try {
    readiness.assertLocal(current, expected);
    await attach(current, false); await subscribe(); stage = 'readiness';
    const proof = await readiness.verifyNativeReady(current, journal, remote, conversation);
    readiness.assertLocal(current, expected);
    if (Date.now() >= request.expiresAt) throw new Error('readiness request expired');
    await detach(); busy = false; activeTask = null;
    report('idle', { purpose: 'submission_ready', previousExecution: proof.previous, readiness: proof,
      readinessRequestId: requestId, originalExecutionMayContinue: false });
    writeJsonAtomic(target.receipt, { ...receipt, ready: true, proof, timestamp: now() });
  } catch (error) {
    await detach(); busy = false; activeTask = null;
    writeJsonAtomic(target.receipt, { ...receipt, reason: diagnostic(error, stage, lastTransportFault).message, timestamp: now() });
  }
}

// Install Escape handling before recovery observes a still-running turn. / 恢复正在执行的轮次前先安装Escape处理。
const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const initialized = (process.argv.includes('--defer-observe') ? Promise.resolve().then(() => {
  if (!sessionId) throw new Error('Deferred observation requires the original session');
  activeTask = task();
  activeEnvelope = readJson(journalPath(activeTask), null)?.envelope;
  if (!activeEnvelope || activeEnvelope.sessionId !== sessionId) throw new Error('Deferred observation requires an exact saved command');
  report('blocked', { reason: 'observer_detached', originalExecutionMayContinue: true });
  activeTask = null; busy = false;
}) : initialize()).catch(error => initializationFailed(error, true));
input.on('line', file => {
  if (file.trim().startsWith(':prepare-retry:')) {
    void prepareRetry(file.trim().slice(':prepare-retry:'.length)).catch(() => {}); return;
  }
  if (file.trim() === ':resume' && busy) {
    try {
      const current = task();
      if (activeEnvelope && activeTask?.round === current.round
          && remote && !remote.closed && conversation && !conversation.fault
          && readJson(journalPath(current), null)?.envelope?.commandId === activeEnvelope.commandId) {
        // Reattach the local watcher to an existing observer without another Relay connection. / 本地watcher重新附着现有观察器，不另建Relay连接。
        report('working', { observerAlreadyAttached: true });
      } else process.stdout.write('zcode: busy; observation identity not yet attested\n');
    } catch { process.stdout.write('zcode: busy; observation identity mismatch\n'); }
    return;
  }
  void initialized.then(() => {
    if (file.trim() === ':resume' && !busy) {
      void initialize().catch(error => initializationFailed(error));
    } else if (file.trim()) void submit(file.trim());
  }).catch(() => {});
});
process.stdin.on('keypress', (_, key) => { if (key?.name === 'escape') void stop(); });
input.on('close', () => { void detach().finally(() => process.exit(process.exitCode || 0)); });
