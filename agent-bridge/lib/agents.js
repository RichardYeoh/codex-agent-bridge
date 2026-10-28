'use strict';

const path = require('node:path');
const { config, psQuote, taskDir, readJson } = require('./util');

// Worker launch metadata; the pane lifecycle contract is documented separately. / 执行端启动元数据，Pane 生命周期契约见工程说明。
const agents = {
  opencode: {
    id: 'opencode', aliases: ['oc'], label: 'OpenCode CLI V2', displayName: 'oc', herdrAgent: 'opencode',
    transport: 'herdr-pane', promptMode: 'api', trustPrompt: /(?!) /,
    capabilities: { resume: true, followup: true, events: true }, replayOnRelaunch: false,
    prepareWorker: (task, resumeId) => require('./opencode').prepareWorker(task, resumeId),
    prepareSubmission: task => require('./opencode').configure(task),
    submitWorker: (task, text) => require('./opencode').submitWorker(task, text),
    refreshWorker: task => { const worker = require('./opencode'); worker.publish(task, worker.snapshot(task)); },
    cancelWorker: task => require('./opencode').interrupt(task),
    buildCommand(task, resumeId) {
      const id = resumeId || task.workerSessionId;
      if (!id) throw new Error('OpenCode requires a verified session ID');
      // Herdr's server may not inherit the coordinator's executable override. / Herdr服务可能未继承协调器的执行文件覆盖配置。
      return [`$env:AGENT_BRIDGE_OPENCODE=${psQuote(config().opencode)};`, '&', psQuote(process.execPath),
        psQuote(path.join(config().root, 'bin', 'opencode-worker.js')), psQuote(id)].join(' ');
    },
    readBlocker(task) {
      const state = readJson(path.join(taskDir(task.id), 'opencode-state.json'), null);
      return state?.state === 'blocked' && state.sessionId === task.workerSessionId && state.round === task.round
        ? { type: state.reason, requiresAction: true, originalExecutionMayContinue: state.originalExecutionMayContinue ?? true,
          message: `OpenCode blocked: ${state.reason}` } : null;
    },
  },
  cbc: {
    id: 'cbc',
    label: 'CodeBuddy CLI',
    displayName: 'cbc',
    herdrAgent: 'codebuddy',
    transport: 'herdr-pane',
    promptMode: 'pane-input',
    trustPrompt: /Do you trust the files in this folder/,
    capabilities: { resume: true, followup: true, events: true },
    binary: () => config().cbc,
    hook: 'hooks/herdr-codebuddy.js',
    // CBC flags preserve explicit permissions and session identity. / CBC 参数保留权限选择及会话身份。
    buildCommand(task, resumeId) {
      const args = ['&', psQuote(config().cbc)];
      if (task.skipPermissions) args.push('-y');
      else args.push('--permission-mode', psQuote(task.permissionMode));
      if (resumeId) args.push('--resume', psQuote(resumeId));
      if (task.model) args.push('--model', psQuote(task.model));
      if (task.effort) args.push('--effort', psQuote(task.effort));
      if (task.workerPolicyPath) args.push('--append-system-prompt', `(Get-Content -Raw -Encoding utf8 -LiteralPath ${psQuote(task.workerPolicyPath)})`);
      args.push('--add-dir', psQuote(taskDir(task.id)));
      return args.join(' ');
    },
  },
  zcode: {
    id: 'zcode', label: 'ZCode Desktop (Start Plan)', displayName: 'zcode', herdrAgent: 'zcode',
    transport: 'herdr-pane', promptMode: 'file-input', trustPrompt: /(?!) /,
    capabilities: { resume: true, followup: true, events: true }, replayOnRelaunch: false, resumeInput: ':resume',
    buildCommand(task, resumeId) {
      return ['&', psQuote(process.execPath), psQuote(path.join(config().root, 'bin', 'zcode-worker.js')),
        ...(resumeId ? [psQuote(resumeId)] : [])].join(' ');
    },
    readBlocker(task) {
      const state = readJson(path.join(taskDir(task.id), 'zcode-state.json'), null);
      return state?.state === 'blocked' ? { type: state.reason, requiresAction: true,
        originalExecutionMayContinue: state.originalExecutionMayContinue ?? true,
        message: `ZCode blocked: ${state.reason}` } : null;
    },
    readPromptContext(task) {
      const state = readJson(path.join(taskDir(task.id), 'zcode-state.json'), null);
      return state?.round === task.round ? state.promptContext : null;
    },
  },
  agy: {
    id: 'agy', label: 'Antigravity CLI', displayName: 'agy', herdrAgent: 'agy',
    transport: 'herdr-pane', promptMode: 'pane-input', trustPrompt: /Do you trust the contents of this project\?|Yes, I trust this folder/,
    capabilities: { resume: true, followup: true, events: true },
    replayOnRelaunch: false,
    prepareWorker: (task, resumeId) => require('./agy-hooks').prepareWorker(task, resumeId),
    buildCommand(task, resumeId) {
      if (!resumeId && !task.workerSessionId) throw new Error('Agy requires a verified conversation ID before launch');
      const args = ['&', psQuote(config().agy), '--conversation', psQuote(resumeId || task.workerSessionId)];
      if (task.skipPermissions) args.push('--dangerously-skip-permissions');
      else args.push('--mode', psQuote(task.permissionMode === 'acceptEdits' ? 'accept-edits' : task.permissionMode));
      if (task.model) args.push('--model', psQuote(task.model));
      if (task.effort) args.push('--effort', psQuote(task.effort));
      args.push('--add-dir', psQuote(taskDir(task.id)));
      return args.join(' ');
    },
    readBlocker(task) {
      const state = readJson(path.join(taskDir(task.id), 'agy-state.json'), null);
      return state?.state === 'blocked' ? { type: state.reason, requiresAction: true,
        originalExecutionMayContinue: state.originalExecutionMayContinue ?? true,
        message: `Antigravity blocked: ${state.reason}` } : null;
    },
  },
};

function getAgent(name) {
  const key = name || 'cbc';
  const agent = Object.hasOwn(agents, key) ? agents[key]
    : Object.values(agents).find(entry => entry.aliases?.includes(key));
  if (!agent) {
    throw new Error(`Unsupported agent: ${name}. Registered: ${Object.keys(agents).join(', ')}`);
  }
  return agent;
}

function listAgents() {
  return Object.values(agents).map(agent => ({ id: agent.id, label: agent.label,
    ...(agent.aliases ? { aliases: [...agent.aliases] } : {}) }));
}

function chooseAgentName(id, liveAgents, ownPaneId) {
  const descriptor = getAgent(id);
  const base = descriptor.displayName || descriptor.id;
  const occupied = new Set(liveAgents.filter(agent => agent.pane_id !== ownPaneId).map(agent => agent.name));
  if (!occupied.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const name = `${base}-${index}`;
    if (!occupied.has(name)) return name;
  }
  throw new Error(`No available Herdr name for ${base}`);
}

module.exports = { agents, getAgent, listAgents, chooseAgentName };
