#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { api, agentInfo, paneInfo } = require('../lib/herdr');
const { loadTask, taskDir, writeJsonAtomic, readJson, now, config, processAlive } = require('../lib/util');
const { leaseForEvent } = require('../lib/worker-lease');
const { ZCodeRemote, Conversation, readBinding, selectedModel, needsFullContext } = require('../lib/zcode-remote');
const { renderRoundInstructions } = require('../lib/worker-policy');
const { queryAdmission, observeExecution } = require('../lib/zcode-observation');
const { diagnostic, failureReason, safeMessage } = require('../lib/zcode-errors');
const readiness = require('../lib/zcode-readiness');
const { bindingError, verifyPaneAgent } = require('../lib/zcode-rebinding');
const { inventory } = require('../lib/worker-identity');
const { getAgent } = require('../lib/agents');

let sessionId = process.argv[2] || null;
let remote, conversation, activeTask, busy = true, stopping = false, sequence = Date.now();
let cancelRequested = false, activeEnvelope = null, admission = null, resumeReceiptPending = false;
let stage = 'startup', lastTransportFault = null;
let workerTaskId = process.env.AGENT_BRIDGE_TASK_ID || null;
let workerPaneId = process.env.HERDR_PANE_ID || null, workerTerminalId = null;
let rebindReceiptPending = false, rebindHandoffPending = false, retirePromise = null, bootstrapReported = false, wrapperBootstrapComplete = false, bindingMonitor = null;
const workerProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

function logWorkerError(area, error) {
  try { process.stdout.write(`zcode: ${area} reporting failed (${safeMessage(error?.message)})\n`); } catch {}
}

function reportFailureSafely(error, fallback) {
  if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED') { void retireLocalObserver(error); return; }
  try { reportFailure(error, fallback); }
  catch (reportError) {
    if (reportError?.code === 'ZCODE_LOCAL_BINDING_REPLACED') void retireLocalObserver(reportError);
    else logWorkerError('failure', reportError);
  }
}

function reportResumeReceipt() {
  if (!resumeReceiptPending || !busy || !activeTask || !activeEnvelope || !conversation || conversation.fault
      || activeEnvelope.sessionId !== sessionId || activeTask.workerSessionId !== sessionId
      || activeTask.round !== task().round) return;
  const journal = readJson(journalPath(activeTask), null);
  if (journal?.envelope?.commandId !== activeEnvelope.commandId || journal.envelope.sessionId !== sessionId) return;
  resumeReceiptPending = false;
  try { report('working', { observerAlreadyAttached: true }); } catch (error) { logWorkerError('resume receipt', error); }
}

function creationBootstrap(current) {
  if (!sessionId || current.workerSessionId) return false;
  const saved = readJson(path.join(taskDir(current.id), 'zcode-create.json'), null);
  return saved?.workerPid === process.pid && saved.workerProcessStartedAt === workerProcessStartedAt
    && saved.status === 'acknowledged' && saved.envelope?.type === 'createSession'
    && saved.ack?.commandId === saved.envelope.commandId && ['accepted', 'duplicate'].includes(saved.ack.status)
    && saved.ack.result?.sessionId === sessionId;
}

async function retireLocalObserver(error) {
  if (retirePromise) return retirePromise;
  retirePromise = (async () => {
    stopping = true; busy = true;
    if (bindingMonitor) clearInterval(bindingMonitor);
    bindingMonitor = null;
    process.stdout.write(`zcode: local observer detached (${safeMessage(error?.message || 'binding replaced')}); native execution was not stopped\n`);
    try { await detach(); } catch (detachError) { logWorkerError('local observer detach', detachError); }
    activeTask = null; activeEnvelope = null; admission = null;
    process.exitCode = 0;
    input.close();
  })();
  return retirePromise;
}

function startBindingMonitor() {
  if (bindingMonitor) return;
  bindingMonitor = setInterval(() => {
    if (!busy || !activeTask || !activeEnvelope || retirePromise) return;
    try {
      const priorPane = workerPaneId;
      const current = task();
      if (current.paneId !== priorPane || rebindReceiptPending) report('working', { observerAlreadyAttached: true });
    } catch (error) {
      if (error?.code === 'ZCODE_REBIND_PENDING') {
        if (!rebindHandoffPending) process.stdout.write('zcode: Pane ownership moved; waiting for the adopted task binding\n');
        rebindHandoffPending = true;
        return;
      }
      if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED') void retireLocalObserver(error);
      else logWorkerError('binding monitor', error);
    }
  }, 1500);
  bindingMonitor.unref?.();
}

async function waitForAdoptedBinding(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return task(); }
    catch (error) {
      if (error?.code !== 'ZCODE_REBIND_PENDING') throw error;
      if (!rebindHandoffPending) process.stdout.write('zcode: Pane ownership moved; waiting for the adopted task binding\n');
      rebindHandoffPending = true;
      if (Date.now() >= deadline) throw bindingError('ZCode adopted Pane binding was not published; local observer detached without stopping native work');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

function assertUnregisteredWrapperOwner(current, expectedSessionId, lease) {
  if (!lease || lease.taskId !== current.id || lease.paneId !== current.paneId
      || lease.terminalId !== current.terminalId
      || lease.workerSessionId !== (expectedSessionId || null) && lease.workerSessionId !== (current.workerSessionId || null)) {
    throw bindingError('ZCode first-registration Pane lease is missing or does not match this task');
  }
  let records;
  try { records = inventory(current); }
  catch (error) { throw bindingError(`ZCode first-registration inventory is incomplete: ${safeMessage(error.message)}`); }
  const here = records.find(item => item.pane_id === current.paneId);
  if (!here || here.terminal_id !== current.terminalId) throw bindingError('ZCode first-registration Pane is absent from the complete inventory');
  if (here.agent && (here.agent !== 'zcode' || here.agent_session?.value != null && here.agent_session.value !== (expectedSessionId || null))) {
    throw bindingError('ZCode first-registration Pane is already owned by another agent or native session');
  }
  if (here.agent_session?.value && here.agent_session.value !== (expectedSessionId || null)) {
    throw bindingError('ZCode first-registration Pane exposes another native session owner');
  }
  const others = records.filter(item => item.pane_id !== current.paneId
    && (expectedSessionId && item.agent_session?.value === expectedSessionId || item.terminal_id === current.terminalId));
  if (others.length) throw bindingError('ZCode first-registration inventory has another Pane owner for this terminal or native session');
}

function rebindPendingError() {
  const error = new Error('ZCode Pane ownership moved; waiting for the matching adopted task binding');
  error.code = 'ZCODE_REBIND_PENDING';
  return error;
}

function hasPendingPaneRebind(current, state, journal) {
  const commandId = activeEnvelope?.commandId;
  if (!activeTask || !commandId || activeTask.id !== current.id || activeTask.round !== current.round
      || activeTask.workerSessionId !== sessionId || current.workerSessionId !== sessionId
      || current.terminalId !== workerTerminalId || journal?.envelope?.commandId !== commandId
      || journal.envelope.sessionId !== sessionId || state?.taskId !== current.id || state.round !== current.round
      || state.sessionId !== sessionId || state.paneId !== workerPaneId || state.terminalId !== workerTerminalId
      || state.commandId !== commandId || state.state !== 'working' || state.workerPid !== process.pid
      || state.workerProcessStartedAt !== workerProcessStartedAt) return false;
  try {
    const owners = inventory(current).filter(item => item.agent_session?.value === sessionId
      && item.agent === getAgent('zcode').herdrAgent && item.terminal_id === workerTerminalId);
    return owners.length === 1 && owners[0].pane_id !== workerPaneId;
  } catch { return false; }
}

function task() {
  let taskId = workerTaskId;
  const herdrSession = process.env.AGENT_BRIDGE_HERDR_SESSION;
  let current;
  try { current = loadTask(taskId); }
  catch (error) { throw bindingError(`ZCode task binding is unavailable: ${safeMessage(error.message)}`); }
  const assignedLease = leaseForEvent(current.stateDir, current.herdrSession, workerPaneId, sessionId);
  if (assignedLease?.taskId && assignedLease.taskId !== current.id) {
    let next;
    try { next = loadTask(assignedLease.taskId); }
    catch (error) { throw bindingError(`ZCode Pane lease points to an unavailable task: ${safeMessage(error.message)}`); }
    if (busy || activeTask || activeEnvelope || !['accepted', 'cancelled'].includes(current.status)
        || next.id !== assignedLease.taskId || next.agent !== 'zcode' || next.reusedFromTaskId !== current.id
        || next.round !== 0 || next.herdrSession !== current.herdrSession || next.paneId !== workerPaneId
        || next.terminalId !== workerTerminalId && workerTerminalId !== null
        || next.workerSessionId !== sessionId || assignedLease.terminalId !== next.terminalId
        || assignedLease.workerSessionId !== sessionId) {
      throw bindingError('ZCode Pane lease cannot transfer this idle wrapper to a different task');
    }
    current = next; taskId = next.id; workerTaskId = next.id;
  }
  const bootstrap = creationBootstrap(current);
  if (!taskId || !workerPaneId || current.id !== taskId || !current.paneId
      || current.herdrSession !== herdrSession
      || (current.workerSessionId || null) !== (sessionId || null) && !bootstrap) {
    throw bindingError('ZCode worker task, Herdr session, or native session binding changed');
  }
  const state = readJson(path.join(taskDir(current.id), 'zcode-state.json'), null);
  const currentLease = leaseForEvent(current.stateDir, current.herdrSession, current.paneId, sessionId);
  if (state?.workerPid && state.workerPid !== process.pid && processAlive(state.workerPid)) {
    throw bindingError('Another live ZCode worker owns the saved local receipt; no Relay connection opened');
  }
  if (workerTerminalId === null) {
    if (current.paneId !== workerPaneId || !current.terminalId) throw bindingError('ZCode worker did not start on its captured Pane and terminal');
    workerTerminalId = current.terminalId;
  }
  if (current.terminalId !== workerTerminalId) throw bindingError('ZCode terminal was replaced; this worker will detach without stopping native work');
  // Custom Herdr sources omit native IDs; this wrapper still checks its exact task, lease and process ownership. / Herdr自定义来源不返回原生ID，本包装器仍核对精确任务、租约和进程归属。
  const expectedSessionId = sessionId || current.workerSessionId || null;
  if (!currentLease || currentLease.taskId !== current.id || currentLease.paneId !== current.paneId
      || currentLease.terminalId !== workerTerminalId) {
    throw bindingError('ZCode task has no exact Pane lease on the captured terminal');
  }
  if (!wrapperBootstrapComplete) assertUnregisteredWrapperOwner(current, expectedSessionId, currentLease);
  if (current.paneId !== workerPaneId) {
    const previous = current.workerLifecycle?.previous;
    const journal = readJson(journalPath(current), null), commandId = activeEnvelope?.commandId;
    const lease = currentLease;
    if (!activeTask || !commandId || activeTask.round !== current.round || current.observerGeneration <= (activeTask.observerGeneration || 0)
        || current.workerLifecycle?.phase !== 'adopted' || current.restoredContextSessionId !== sessionId
        || previous?.paneId !== workerPaneId || previous?.terminalId !== workerTerminalId
        || journal?.envelope?.commandId !== commandId || journal.envelope.sessionId !== sessionId
        || !state || state.taskId !== current.id || state.round !== current.round || state.sessionId !== sessionId
        || state.paneId !== workerPaneId || state.terminalId !== workerTerminalId || state.commandId !== commandId
        || state.state !== 'working' || state.workerPid !== process.pid
        || state.workerProcessStartedAt !== workerProcessStartedAt
        || !lease || lease.taskId !== current.id || lease.paneId !== current.paneId
        || lease.terminalId !== workerTerminalId || lease.workerSessionId !== sessionId) {
      throw bindingError('ZCode Pane move lacks the exact live observer, command, and adopted-session proof');
    }
    const initialBootstrap = bootstrap && !bootstrapReported;
    if (initialBootstrap && !lease) throw bindingError('ZCode create-session bootstrap lacks its exact Pane lease');
    verifyPaneAgent(bootstrap ? { ...current, workerSessionId: sessionId } : current,
      current.paneId, workerTerminalId, { inspectAgent: agentInfo, inspectPane: paneInfo,
        expectedSessionId: bootstrap ? sessionId : (current.workerSessionId || null),
        allowUnregisteredSession: Boolean(expectedSessionId), allowUnregisteredAgent: !wrapperBootstrapComplete, context: 'formal-rebind' });
    workerPaneId = current.paneId;
    process.env.HERDR_PANE_ID = workerPaneId;
    activeTask = current;
    rebindReceiptPending = true;
  } else {
    try {
      verifyPaneAgent(bootstrap ? { ...current, workerSessionId: sessionId } : current,
        current.paneId, workerTerminalId, { inspectAgent: agentInfo, inspectPane: paneInfo,
          expectedSessionId: bootstrap ? sessionId : (current.workerSessionId || null),
          allowUnregisteredSession: Boolean(expectedSessionId), allowUnregisteredAgent: !wrapperBootstrapComplete, context: 'same-pane' });
    } catch (error) {
      const journal = activeTask ? readJson(journalPath(current), null) : null;
      if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED' && hasPendingPaneRebind(current, state, journal)) throw rebindPendingError();
      throw error;
    }
    if (activeTask && (activeTask.id !== current.id || activeTask.round !== current.round
        || (activeTask.workerSessionId || sessionId || null) !== (current.workerSessionId || sessionId || null))) {
      const changed = [activeTask.id !== current.id && 'task', activeTask.round !== current.round && 'round',
        (activeTask.workerSessionId || sessionId || null) !== (current.workerSessionId || sessionId || null) && 'session'].filter(Boolean);
      throw bindingError(`ZCode active observer ownership changed: ${changed.join(', ')}`);
    }
    if (activeTask && activeEnvelope) {
      const journal = readJson(journalPath(current), null);
      if (journal?.envelope?.commandId !== activeEnvelope.commandId || journal.envelope.sessionId !== sessionId) {
        throw bindingError('ZCode active observer command binding changed');
      }
      if ((current.observerGeneration || 0) !== (activeTask.observerGeneration || 0)) {
        if (state?.workerPid !== process.pid || state.workerProcessStartedAt !== workerProcessStartedAt
            || state.commandId !== activeEnvelope.commandId
            || state.round !== current.round || state.sessionId !== sessionId) {
          throw bindingError('ZCode observer generation belongs to another local worker');
        }
        rebindReceiptPending = true;
      }
    }
    if (activeTask) activeTask = current;
  }
  const lease = leaseForEvent(current.stateDir, current.herdrSession, workerPaneId, sessionId);
  if (lease && (lease.taskId !== current.id || lease.terminalId !== workerTerminalId
      || lease.workerSessionId !== (sessionId || null) && lease.workerSessionId !== (current.workerSessionId || null))) {
    throw bindingError('ZCode Pane lease no longer belongs to this task and terminal');
  }
  rebindHandoffPending = false;
  return current;
}

function report(state, detail = {}) {
  const current = task(), bootstrap = creationBootstrap(current), firstRegistration = !wrapperBootstrapComplete;
  if (activeTask && (current.id !== activeTask.id || current.round !== activeTask.round
      || (current.workerSessionId || sessionId || null) !== (activeTask.workerSessionId || sessionId || null))) {
    throw bindingError('ZCode receipt no longer belongs to the active task round');
  }
  activeTask = current;
  if (rebindReceiptPending && state === 'working') {
    detail = { ...detail, observerAlreadyAttached: true, observerRebound: true };
    rebindReceiptPending = false;
  }
  const receipt = { timestamp: now(), taskId: current.id, herdrSession: current.herdrSession,
    paneId: current.paneId, sessionId, name: state === 'working' ? 'UserPromptSubmit' : state === 'blocked' ? 'Notification' : 'Stop',
    source: 'zcode-v4', round: current.round, terminalId: current.terminalId,
    commandId: activeEnvelope?.commandId || null, commandSha256: readiness.envelopeDigest(activeEnvelope),
    workerPid: process.pid, workerProcessStartedAt, observerGeneration: current.observerGeneration || 0,
    readinessProtocol: readiness.protocol,
    agent: 'zcode', cwd: current.cwd, promptContext: current.promptContext, ...detail };
  fs.appendFileSync(path.join(current.stateDir, 'hook-events.ndjson'), `${JSON.stringify(receipt)}\n`);
  writeJsonAtomic(path.join(taskDir(current.id), 'zcode-state.json'), { ...receipt, state });
  const args = ['pane', 'report-agent', current.paneId, '--source', 'custom:agent-bridge-zcode',
    '--agent', 'zcode', '--state', state, '--seq', String(++sequence)];
  if (sessionId) args.push('--agent-session-id', sessionId);
  api(current.herdrSession, args);
  if (firstRegistration) {
    const expectedSession = sessionId || current.workerSessionId || null;
    verifyPaneAgent({ ...current, workerSessionId: expectedSession }, current.paneId, current.terminalId,
      { inspectAgent: agentInfo, inspectPane: paneInfo, expectedSessionId: expectedSession, allowUnregisteredSession: Boolean(expectedSession), context: 'post-registration' });
    wrapperBootstrapComplete = true;
    if (bootstrap && current.workerSessionId == null && sessionId) bootstrapReported = true;
  }
  process.stdout.write(`zcode: ${state}${detail.reason ? ` (${detail.reason})` : ''}\n`);
}

function journalPath(current) { return path.join(taskDir(current.id), `round-${String(current.round).padStart(3, '0')}-zcode-command.json`); }

function reportFailure(error, fallback) {
  const detail = diagnostic(error, stage, lastTransportFault);
  const current = task();
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
  try { await previousConversation?.dispose(); } finally { await previousRemote?.close(); }
}

async function recoverAdmission(current, envelope, error) {
  if (error && /KICKED|AUTH_FAILED|WRONG_PARAM/.test(error.message)) throw error;
  return queryAdmission(() => remote, envelope, { reconnect: async () => {
    const fresh = task();
    if (fresh.id !== current.id || fresh.round !== current.round || (fresh.workerSessionId || sessionId) !== envelope.sessionId) {
      throw bindingError('ZCode admission query lost its task and command binding');
    }
    await detach(); await attach(fresh, false);
  } });
}

async function observe(current, envelope) {
  stage = 'observe';
  const bound = () => {
    const fresh = task(), journal = readJson(journalPath(fresh), null);
    if (fresh.round !== current.round || (fresh.workerSessionId || sessionId) !== sessionId
        || envelope.sessionId !== sessionId || journal?.envelope?.commandId !== envelope.commandId
        || journal.envelope.sessionId !== sessionId) throw bindingError('ZCode observer command binding changed');
    return fresh;
  };
  bound(); startBindingMonitor();
  reportResumeReceipt();
  let lastCheckpoint = 0;
  const observationPath = path.join(taskDir(current.id), `round-${String(current.round).padStart(3, '0')}-zcode-observation.json`);
  const previous = readJson(observationPath, null);
  const { result, interaction, foreignWork } = await observeExecution({ getConversation: () => conversation,
    sessionId, commandId: envelope.commandId, timeoutMs: current.waitTimeoutMs || 1800000,
    admissionConfirmed: true,
    initialHeaderRowId: previous?.sessionId === sessionId && previous.commandId === envelope.commandId
      ? previous.result?.headerRowId ?? previous.result?.header?.rowId : undefined,
    refresh: async () => { bound(); await conversation.dispose(); await subscribe(); stage = 'observe'; },
    reconnect: async () => {
      const fresh = bound();
      await detach(); await attach(fresh, false); await subscribe(); stage = 'observe';
    },
    checkpoint: ({ result: observed, snapshot }) => {
      if (!observed.terminal && Date.now() - lastCheckpoint < 10000) return;
      lastCheckpoint = Date.now();
      const fresh = bound();
      writeJsonAtomic(observationPath, {
        taskId: fresh.id, round: fresh.round, sessionId, commandId: envelope.commandId,
        paneId: fresh.paneId, terminalId: fresh.terminalId, observerGeneration: fresh.observerGeneration || 0, timestamp: now(),
        result: observed, phase: snapshot.control.phase,
      });
    },
  });
  const fresh = bound();
  if (interaction) {
    report('blocked', { reason: 'interaction_required', originalExecutionMayContinue: true });
    return;
  }
  if (foreignWork) {
    report('blocked', { reason: 'untracked_command_active', originalExecutionMayContinue: true });
    return;
  }
  const journal = readJson(journalPath(fresh), {});
  if (journal?.envelope?.commandId !== envelope.commandId || journal.envelope.sessionId !== sessionId) {
    throw bindingError('ZCode terminal result no longer owns the persisted round journal');
  }
  writeJsonAtomic(journalPath(fresh), { ...journal, envelope, status: 'terminal', turnState: result.state, timestamp: now() });
  if (result.state === 'failed') report('blocked', { reason: result.error?.code || 'runtime_failed', originalExecutionMayContinue: false });
  else if (result.state === 'completedInterrupted') report('blocked', { reason: 'execution_interrupted', originalExecutionMayContinue: false });
  else report('idle', { turnState: result.state });
}

async function observeWithRebind(current, envelope) {
  for (;;) {
    try { await observe(current, envelope); return; }
    catch (error) {
      if (error?.code !== 'ZCODE_REBIND_PENDING') throw error;
      current = await waitForAdoptedBinding();
      report('working', { observerAlreadyAttached: true });
    }
  }
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
      }), status: 'prepared', workerPid: process.pid, workerProcessStartedAt };
      writeJsonAtomic(file, stored);
    }
    let ack = stored.ack;
    if (!ack && stored.status === 'sending') ack = await recoverAdmission(activeTask, stored.envelope);
    if (!ack) {
      if (cancelRequested) {
        report('idle', { stopped: true, submitted: false });
        await detach(); activeTask = null; activeEnvelope = null; admission = null; busy = false;
        return;
      }
      stored.status = 'sending'; writeJsonAtomic(file, stored);
      try { ack = await remote.command(stored.envelope); }
      catch (error) { ack = await recoverAdmission(activeTask, stored.envelope, error); }
    }
    if (!['accepted', 'duplicate'].includes(ack.status) || !ack.result?.sessionId) throw new Error('ZCode session creation rejected');
    sessionId = ack.result.sessionId;
    writeJsonAtomic(file, { ...stored, status: 'acknowledged', ack });
  }
  const snapshot = await subscribe();
  if (snapshot?.sessionId !== sessionId) throw bindingError('ZCode subscribed native session does not match this wrapper');
  let prior = activeTask.round > 0 ? readJson(journalPath(activeTask), null) : null;
  if (prior && !['accepted', 'cancelled'].includes(activeTask.status)) {
    if (prior.envelope.sessionId !== sessionId) throw new Error('ZCode command session identity mismatch');
    if (prior.status === 'sending') {
      stage = 'admission-recovery';
      // Reconcile the original command key before observing; unknown stays unknown and is never resent. / 观察前先按原命令键只读对账；unknown保持未知，不重发。
      const ack = await recoverAdmission(activeTask, prior.envelope);
      prior = { ...prior, ack, status: 'acknowledged', timestamp: now() };
      writeJsonAtomic(journalPath(activeTask), prior);
    }
    activeEnvelope = prior.envelope;
    if (readiness.failedAdmission(prior)) {
      stage = 'readiness';
      const proof = await readiness.verifyNativeReady(activeTask, prior, remote, conversation);
      if (['failed', 'completedInterrupted'].includes(proof.previous?.state)) {
        await detach(); activeTask = null; admission = null; busy = false;
        // Ready for explicit rework is not a successful execution outcome. / 可接受明确返工不等于原执行成功。
        report('idle', { purpose: 'submission_ready', previousExecution: proof.previous, readiness: proof,
          originalExecutionMayContinue: false });
        activeTask = null; activeEnvelope = null; admission = null;
        return;
      }
    }
    report('working');
    if (cancelRequested) void stop().catch(error => logWorkerError('cancel', error));
    await observeWithRebind(activeTask, prior.envelope);
  } else report('idle');
  await detach(); activeTask = null; activeEnvelope = null; admission = null; busy = false;
}

async function submit(file) {
  if (busy) { process.stdout.write('zcode: busy; no input was sent\n'); return; }
  const current = task();
  busy = true; activeTask = current;
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
    await observeWithRebind(activeTask, envelope);
  } catch (error) {
    reportFailureSafely(error, 'execution_unconfirmed');
  } finally {
    busy = false;
    if (!stopping) {
      try { await detach(); } catch (error) { logWorkerError('detach', error); }
      activeTask = null; activeEnvelope = null; admission = null;
    }
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
    if (!envelope || envelope.type !== 'sendText' || envelope.sessionId !== sessionId
        || readJson(journalPath(current), null)?.envelope?.commandId !== envelope.commandId) {
      throw new Error('Current task command is not bound; no native stop sent');
    }
    if (admission) await admission;
    const snapshot = conversation.snapshot;
    const active = snapshot?.control?.activeWorks;
    if (snapshot?.sessionId !== sessionId || !Array.isArray(active)
        || !Array.isArray(snapshot.queue?.items) || !Array.isArray(snapshot.pendingInteractions)) {
      throw new Error('Fresh ZCode session activity snapshot is incomplete; no native stop sent');
    }
    if (active.some(work => work.sourceCommandId !== envelope.commandId)
        || snapshot.queue.items.length || snapshot.pendingInteractions.length || snapshot.workspaceHookAdmission) {
      throw new Error('Foreign work, queued input or approval is present; no native stop sent');
    }
    if (!active.some(work => work.sourceCommandId === envelope.commandId)) {
      throw new Error('Current task command is not the active stop target; no native stop sent');
    }
    if (snapshot.control.canStop !== true || snapshot.control.stopState !== 'stoppable') {
      throw new Error('ZCode stop target is not explicitly stoppable; no native stop sent');
    }
    // The audited V4 contract has no command-scoped conditional stop; a session stop can race with new manual work. / 已审计V4契约没有命令级条件stop，会话级stop可能与新人工工作竞态。
    throw new Error('V4 stop is session-wide and lacks an atomic command condition; no native stop sent');
  } catch (error) {
    if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED') { await retireLocalObserver(error); return; }
    try { report('blocked', { reason: 'stop_unconfirmed', originalExecutionMayContinue: true, diagnostic: error.message }); }
    catch (reportError) { logWorkerError('stop', reportError); }
  } finally {
    if (!busy) {
      try { await detach(); } catch (error) { logWorkerError('detach', error); }
      activeTask = null; activeEnvelope = null; admission = null;
    }
    stopping = false;
  }
}

async function initializationFailed(error, startup = false) {
  if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED') { await retireLocalObserver(error); return; }
  const recoverable = sessionId && activeEnvelope?.sessionId === sessionId;
  const fallback = startup && stage === 'admission-recovery' ? 'execution_unconfirmed'
    : startup ? 'startup_failed' : 'recovery_unconfirmed';
  reportFailureSafely(error, fallback);
  try { await detach(); } catch (detachError) { logWorkerError('detach', detachError); }
  busy = false; activeTask = null;
  // A known session stays detached and can accept a later explicit resume. / 已知会话保持脱离，允许后续显式resume。
  if (startup && !recoverable) { process.exitCode = 1; input.close(); }
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
    activeTask = null; activeEnvelope = null; admission = null;
  } catch (error) {
    if (error?.code === 'ZCODE_LOCAL_BINDING_REPLACED') { await retireLocalObserver(error); return; }
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
  const line = file.trim(), retryAt = line.lastIndexOf(':prepare-retry:');
  if (retryAt >= 0) {
    const requestId = line.slice(retryAt + ':prepare-retry:'.length);
    if (retryAt > 0) process.stdout.write('zcode: discarded stale Pane input before readiness control\n');
    void prepareRetry(requestId).catch(error => logWorkerError('readiness', error)); return;
  }
  if (line.endsWith(':resume') && busy) {
    if (line !== ':resume') process.stdout.write('zcode: discarded stale Pane input before resume control\n');
    try {
      const current = task();
      if (activeEnvelope && activeTask?.round === current.round
          && remote && !remote.closed && conversation && !conversation.fault
          && readJson(journalPath(current), null)?.envelope?.commandId === activeEnvelope.commandId) {
        // Reattach the local watcher to an existing observer without another Relay connection. / 本地watcher重新附着现有观察器，不另建Relay连接。
        report('working', { observerAlreadyAttached: true });
      } else { resumeReceiptPending = true; process.stdout.write('zcode: busy; observation identity not yet attested\n'); }
    } catch (error) { logWorkerError('resume identity', error); }
    return;
  }
  void initialized.then(() => {
    if (line.endsWith(':resume') && !busy) {
      if (line !== ':resume') process.stdout.write('zcode: discarded stale Pane input before resume control\n');
      void initialize().catch(error => initializationFailed(error).catch(logError => logWorkerError('initialization', logError)));
    } else if (line) void submit(line).catch(error => logWorkerError('submission', error));
  }).catch(error => logWorkerError('initialization gate', error));
});
process.stdin.on('keypress', (_, key) => { if (key?.name === 'escape') void stop().catch(error => logWorkerError('cancel', error)); });
input.on('close', () => {
  if (bindingMonitor) clearInterval(bindingMonitor);
  void detach().catch(error => logWorkerError('detach', error)).finally(() => process.exit(process.exitCode || 0));
});
