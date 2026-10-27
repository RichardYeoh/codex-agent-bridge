'use strict';

const { api, resultPayload } = require('./herdr');
const { getAgent } = require('./agents');
const path = require('node:path');

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

function createLocation(task, resumeId) {
  // Recreate a worker in its saved project workspace, not a fresh workspace. / 恢复时仍复用已保存的项目 Workspace。
  const placement = task.recoveryPlacement || (resumeId && task.workspaceId
    ? { mode: 'tab', workspaceId: task.workspaceId }
    : task.placement);
  if (!placement) throw new Error('No verified worker placement available');
  const common = ['--cwd', task.cwd, '--no-focus',
    '--env', `AGENT_BRIDGE_STATE_DIR=${task.stateDir}`,
    '--env', `AGENT_BRIDGE_TASK_ID=${task.id}`,
    '--env', `AGENT_BRIDGE_HERDR_SESSION=${task.herdrSession}`];
  let result;
  const label = getAgent(task.agent).displayName || task.agent;
  if (placement.mode === 'workspace') {
    result = resultPayload(api(task.herdrSession, ['workspace', 'create', '--label', path.basename(task.cwd), ...common]));
    return { workspaceId: result.workspace.workspace_id, tabId: result.tab.tab_id,
      pane: result.root_pane, ownsWorkspace: true, mode: 'workspace' };
  }
  if (placement.mode === 'pane') {
    const parent = resultPayload(api(task.herdrSession, ['pane', 'get', placement.anchorPaneId])).pane;
    if (placement.workspaceId && placement.workspaceId !== parent.workspace_id) {
      throw new Error('Anchor Pane does not belong to the specified project workspace');
    }
    const layout = resultPayload(api(task.herdrSession, ['pane', 'layout', '--pane', placement.anchorPaneId])).layout;
    const rect = layout.panes.find(pane => pane.pane_id === placement.anchorPaneId)?.rect;
    const direction = placement.direction || splitDirection(rect);
    if (!['right', 'down'].includes(direction)) throw new Error('Invalid split direction');
    result = resultPayload(api(task.herdrSession, ['pane', 'split', placement.anchorPaneId, '--direction', direction, ...common]));
    return { workspaceId: parent.workspace_id, tabId: parent.tab_id, pane: result.pane,
      ownsWorkspace: false, mode: 'pane' };
  }
  api(task.herdrSession, ['workspace', 'get', placement.workspaceId]);
  result = resultPayload(api(task.herdrSession, ['tab', 'create', '--workspace', placement.workspaceId,
    '--label', label, ...common]));
  return { workspaceId: placement.workspaceId, tabId: result.tab.tab_id, pane: result.root_pane,
    ownsWorkspace: false, mode: 'tab' };
}

module.exports = { placementFor, splitDirection, createLocation };
