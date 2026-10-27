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

let sessionId = process.argv[2] || null;
let remote, conversation, activeTask, busy = true, stopping = false, sequence = Date.now();
let cancelRequested = false, activeEnvelope = null, admission = null;

function task() {
  const lease = leaseForEvent(config().stateDir, process.env.AGENT_BRIDGE_HERDR_SESSION,
    process.env.HERDR_PANE_ID, sessionId);
  return loadTask(lease?.taskId || process.env.AGENT_BRIDGE_TASK_ID);
}

function report(state, detail = {}) {
  const current = activeTask || task();
  const receipt = { timestamp: now(), taskId: current.id, herdrSession: current.herdrSession,
    paneId: current.paneId, sessionId, name: state === 'working' ? 'UserPromptSubmit' : state === 'blocked' ? 'Notification' : 'Stop',
    source: 'zcode-v4', round: current.round, promptContext: current.promptContext, ...detail };
  fs.appendFileSync(path.join(current.stateDir, 'hook-events.ndjson'), `${JSON.stringify(receipt)}\n`);
  writeJsonAtomic(path.join(taskDir(current.id), 'zcode-state.json'), { ...receipt, state });
  const args = ['pane', 'report-agent', current.paneId, '--source', 'custom:agent-bridge-zcode',
    '--agent', 'zcode', '--state', state, '--seq', String(++sequence)];
  if (sessionId) args.push('--agent-session-id', sessionId);
  api(current.herdrSession, args);
  process.stdout.write(`zcode: ${state}${detail.reason ? ` (${detail.reason})` : ''}\n`);
}

function journalPath(current) { return path.join(taskDir(current.id), `round-${String(current.round).padStart(3, '0')}-zcode-command.json`); }

async function attach(current, create) {
  remote = new ZCodeRemote(readBinding(current.zcodeConfig));
  // Faults stay observable even between awaited calls. / 等待调用之间出现故障也保持可观察。
  remote.on('fault', () => {});
  await remote.connect();
  await remote.attachProject(current.cwd, { create });
}

async function subscribe() {
  conversation = new Conversation(remote, sessionId);
  conversation.on('fault', () => {});
  return conversation.subscribe();
}

async function detach() {
  const previousConversation = conversation, previousRemote = remote;
  conversation = null; remote = null;
  await previousConversation?.dispose(); previousRemote?.close();
}

function saveDelivery(current, snapshot, commandId) {
  const state = turnState(snapshot, commandId);
  if (state.state !== 'completedSuccess') return;
  if (!fs.existsSync(current.deliveryPath)) {
    const text = snapshot.rows.window.filter(row => row.kind === 'assistantText' && row.turnId === state.header.turnId)
      .map(row => row.text).join('\n');
    // Transport collection is evidence, never independent acceptance. / 传输采集仅作为交付证据，不代表独立验收。
    fs.writeFileSync(current.deliveryPath,
      `# ZCode 第 ${current.round} 轮交付\n\n由适配器采集最终回复；以下内容尚未经 Codex 验收。\n\n${text}\n`);
  }
}

async function observe(current, envelope) {
  const timeout = current.waitTimeoutMs || 1800000;
  const snapshot = await conversation.wait(s => turnState(s, envelope.commandId).terminal
    || s.pendingInteractions.length > 0 || Boolean(s.workspaceHookAdmission), timeout);
  const result = turnState(snapshot, envelope.commandId);
  if (!result.terminal) {
    report('blocked', { reason: 'interaction_required', originalExecutionMayContinue: true });
    return;
  }
  writeJsonAtomic(journalPath(current), { envelope, status: 'terminal', turnState: result.state, timestamp: now() });
  saveDelivery(current, snapshot, envelope.commandId);
  if (result.state === 'failed') report('blocked', { reason: result.error?.code || 'runtime_failed', originalExecutionMayContinue: false });
  else report('idle', { stopped: result.state === 'completedInterrupted' });
}

async function initialize() {
  busy = true;
  activeTask = task();
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
    if (!ack && stored.status === 'sending') {
      const query = await remote.query(stored.envelope);
      ack = query.results[0].result;
      if (ack === 'unknown') throw new Error('ZCode creation uncertain; inspect Desktop before any new creation');
    }
    if (!ack) {
      stored.status = 'sending'; writeJsonAtomic(file, stored);
      ack = await remote.command(stored.envelope);
    }
    if (!['accepted', 'duplicate'].includes(ack.status) || !ack.result?.sessionId) throw new Error('ZCode session creation rejected');
    sessionId = ack.result.sessionId;
    writeJsonAtomic(file, { ...stored, status: 'acknowledged', ack });
  }
  const snapshot = await subscribe();
  const prior = activeTask.round > 0 ? readJson(journalPath(activeTask), null) : null;
  if (prior && !['accepted', 'cancelled'].includes(activeTask.status)) {
    const result = turnState(snapshot, prior.envelope.commandId);
    if (result.seen && !result.terminal) {
      activeEnvelope = prior.envelope;
      report('working');
      if (cancelRequested) void stop();
      await observe(activeTask, prior.envelope);
    } else if (result.terminal) {
      saveDelivery(activeTask, snapshot, prior.envelope.commandId);
      report(result.state === 'failed' ? 'blocked' : 'idle', { reason: result.error?.code });
    } else report('blocked', { reason: 'submission_unconfirmed', originalExecutionMayContinue: true });
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
    if (snapshot.control.canStop || snapshot.pendingInteractions.length || snapshot.queue.items.length) {
      throw new Error('ZCode session has active work or pending interaction; inspect before submitting');
    }
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
    admission = remote.command(envelope);
    const ack = await admission;
    writeJsonAtomic(journalPath(activeTask), { envelope, status: 'acknowledged', ack, timestamp: now() });
    if (!['accepted', 'duplicate'].includes(ack.status)) throw new Error(`ZCode command ${ack.status}: ${ack.reasonCode || 'rejected'}`);
    await observe(activeTask, envelope);
  } catch (error) {
    process.stdout.write(`${error.message}\n`);
    report('blocked', { reason: 'execution_unconfirmed', originalExecutionMayContinue: true });
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

// Install Escape handling before recovery observes a still-running turn. / 恢复正在执行的轮次前先安装Escape处理。
const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const initialized = initialize();
input.on('line', file => {
  void initialized.then(() => {
    if (file.trim() === ':resume' && !busy) {
      void initialize().catch(async () => { report('blocked', { reason: 'recovery_unconfirmed', originalExecutionMayContinue: true }); await detach(); busy = false; activeTask = null; });
    } else if (file.trim()) void submit(file.trim());
  }).catch(() => {});
});
process.stdin.on('keypress', (_, key) => { if (key?.name === 'escape') void stop(); });
input.on('close', () => { void detach().finally(() => process.exit(process.exitCode || 0)); });
initialized.catch(async error => {
  process.stdout.write(`zcode startup failed: ${error.message}\n`);
  try { report('blocked', { reason: 'startup_failed' }); } catch {}
  await detach(); process.exitCode = 1; input.close();
});
