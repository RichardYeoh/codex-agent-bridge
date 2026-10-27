'use strict';

const { api, resultPayload } = require('./herdr');
const path = require('node:path');
const { taskList } = require('./worker-scheduling');

function placementFor(options, env = process.env) {
  if (options['new-workspace']) {
    if (options.workspace || options.pane) throw new Error('--new-workspace conflicts with --workspace/--pane');
    return { mode: 'workspace', reason: options['isolation-reason'] || 'explicit isolation request' };
  }
  // Never reuse pane IDs from a different server. / 不继承其他命名服务的 Pane ID。
  const inherit = !options.session || options.session === (env.HERDR_SESSION || 'default');
  const sameWorkspace = !options.workspace || options.workspace === env.HERDR_WORKSPACE_ID;
  const paneId = options.pane || (inherit && sameWorkspace ? env.HERDR_PANE_ID : null);
  const workspaceId = options.workspace || (inherit ? env.HERDR_WORKSPACE_ID : null);
  if (paneId) return { mode: 'pane', anchorPaneId: paneId, workspaceId, direction: options['split-direction'] || null };
  if (workspaceId) return { mode: 'tab', workspaceId };
  throw new Error('No caller workspace context: specify --workspace or --pane; use --new-workspace only for explicit isolation');
}

function splitDirection(rect) {
  return rect && rect.width >= 120 && rect.width >= rect.height * 2.5 ? 'right' : 'down';
}

function planInTab(layout, owned, mainPaneId) {
  const panes = layout.panes;
  if (panes.some(pane => pane.pane_id !== mainPaneId && !owned.has(pane.pane_id))) return null;
  if (mainPaneId) {
    const main = panes.find(pane => pane.pane_id === mainPaneId);
    if (!main) return null;
    if (panes.length === 1) return { paneId: mainPaneId, direction: 'right' };
    if (panes.length !== 2) return null;
    const right = panes.find(pane => pane.pane_id !== mainPaneId);
    // The primary Codex pane is never split again after allocating its right half. / 主控右半屏分配后，绝不再次拆分Codex主Pane。
    return right.rect.x > main.rect.x && main.rect.height === layout.area.height
      && main.rect.width >= Math.floor(layout.area.width / 2) - 1
      ? { paneId: right.pane_id, direction: 'down' } : null;
  }
  if (panes.length < 1 || panes.length >= 4) return null;
  const ordered = [...panes].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  if (panes.length === 1) return { paneId: ordered[0].pane_id, direction: 'right' };
  if (panes.length === 2) {
    return ordered[1].rect.x > ordered[0].rect.x ? { paneId: ordered[1].pane_id, direction: 'down' } : null;
  }
  const tall = ordered.find(pane => pane.rect.height === layout.area.height);
  return tall ? { paneId: tall.pane_id, direction: 'down' } : null;
}

function createLocation(task, resumeId, { call = api, records = taskList(task.stateDir) } = {}) {
  // Pane recreation follows the same packing policy while preserving native session identity. / 重建Pane沿用同一布局策略，并保留原生会话身份。
  const placement = task.recoveryPlacement || task.placement || (resumeId && task.workspaceId
    ? { mode: 'tab', workspaceId: task.workspaceId } : null);
  if (!placement) throw new Error('No verified worker placement available');
  const common = ['--cwd', task.cwd, '--no-focus',
    '--env', `AGENT_BRIDGE_STATE_DIR=${task.stateDir}`,
    '--env', `AGENT_BRIDGE_TASK_ID=${task.id}`,
    '--env', `AGENT_BRIDGE_HERDR_SESSION=${task.herdrSession}`];
  let result;
  if (placement.mode === 'workspace') {
    result = resultPayload(call(task.herdrSession, ['workspace', 'create', '--label', path.basename(task.cwd), ...common]));
    return { workspaceId: result.workspace.workspace_id, tabId: result.tab.tab_id,
      pane: result.root_pane, ownsWorkspace: true, mode: 'workspace' };
  }
  const rootId = placement.anchorPaneId || task.mainPaneId;
  let main;
  if (rootId) main = resultPayload(call(task.herdrSession, ['pane', 'get', rootId])).pane;
  else {
    const candidates = resultPayload(call(task.herdrSession, ['agent', 'list'])).agents
      .filter(agent => agent.agent === 'codex' && agent.workspace_id === placement.workspaceId);
    if (candidates.length !== 1) throw new Error('Specify --pane for the verified main Codex Pane; no unique anchor in this workspace');
    main = resultPayload(call(task.herdrSession, ['pane', 'get', candidates[0].pane_id])).pane;
  }
  if (placement.workspaceId && placement.workspaceId !== main.workspace_id) throw new Error('Anchor Pane does not belong to the specified project workspace');
  const workspaceId = main.workspace_id;
  const live = resultPayload(call(task.herdrSession, ['pane', 'list', '--workspace', workspaceId])).panes;
  const owned = new Set(records.filter(record => record.herdrSession === task.herdrSession && record.workspaceId === workspaceId
    && live.some(pane => pane.pane_id === record.paneId && pane.terminal_id === record.terminalId)).map(record => record.paneId));
  const layout = pane => resultPayload(call(task.herdrSession, ['pane', 'layout', '--pane', pane])).layout;
  const primary = layout(main.pane_id);
  let plan = planInTab(primary, owned, main.pane_id);
  let targetTab = main.tab_id;
  const tabs = resultPayload(call(task.herdrSession, ['tab', 'list', '--workspace', workspaceId])).tabs;
  if (!plan) {
    for (const tab of tabs.filter(tab => tab.tab_id !== main.tab_id)) {
      const member = live.find(pane => pane.tab_id === tab.tab_id && owned.has(pane.pane_id));
      if (!member) continue;
      plan = planInTab(layout(member.pane_id), owned);
      if (plan) { targetTab = tab.tab_id; break; }
    }
  }
  if (placement.direction && placement.direction !== plan?.direction) {
    throw new Error('Requested split direction conflicts with the reserved Codex half or tab packing policy');
  }
  if (plan) {
    if (!['right', 'down'].includes(plan.direction)) throw new Error('Invalid split direction');
    result = resultPayload(call(task.herdrSession, ['pane', 'split', plan.paneId, '--direction', plan.direction, '--ratio', '0.5', ...common]));
    return { workspaceId, tabId: targetTab, pane: result.pane, mainPaneId: main.pane_id,
      ownsWorkspace: false, mode: 'pane' };
  }
  result = resultPayload(call(task.herdrSession, ['tab', 'create', '--workspace', workspaceId,
    '--label', `agents-${tabs.filter(tab => tab.tab_id !== main.tab_id).length + 1}`, ...common]));
  return { workspaceId, tabId: result.tab.tab_id, pane: result.root_pane, mainPaneId: main.pane_id,
    ownsWorkspace: false, mode: 'tab' };
}

module.exports = { placementFor, splitDirection, planInTab, createLocation };
