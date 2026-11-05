'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.local/layout-smoke');
const cwd = path.join(output, 'project');
fs.mkdirSync(cwd, { recursive: true });
process.env.AGENT_BRIDGE_STATE_DIR = path.join(output, 'state');
const { api, resultPayload } = require('../agent-bridge/lib/herdr');
const { createLocation } = require('../agent-bridge/lib/location');
const session = process.argv[2];
if (!session) throw new Error('Provide the explicitly authorized Herdr service name');

// Isolated empty shells test geometry without using model credits or touching the real main Pane. / 隔离空终端验证几何，不使用模型额度，也不改真实主Pane。
const created = resultPayload(api(session, ['workspace', 'create', '--label', 'bridge-layout-validation', '--cwd', cwd, '--no-focus']));
const workspaceId = created.workspace.workspace_id, mainId = created.root_pane.pane_id;
const records = [], checkpoints = [];
let passed = false;
try {
  for (let count = 1; count <= 10; count++) {
    const task = { id: `layout-slot-${count}`, cwd, stateDir: process.env.AGENT_BRIDGE_STATE_DIR,
      herdrSession: session, agent: 'cbc', placement: { mode: 'pane', anchorPaneId: mainId, workspaceId } };
    const location = createLocation(task, null, { records });
    records.push({ ...task, paneId: location.pane.pane_id, terminalId: location.pane.terminal_id,
      workspaceId, tabId: location.tabId });
    const layout = resultPayload(api(session, ['pane', 'layout', '--pane', mainId])).layout;
    const main = layout.panes.find(pane => pane.pane_id === mainId);
    assert.equal(main.rect.x, layout.area.x); assert.equal(main.rect.y, layout.area.y);
    assert.equal(main.rect.height, layout.area.height);
    assert.ok(Math.abs(main.rect.width - layout.area.width / 2) <= 1, 'Codex keeps the left half');
    assert.equal(layout.panes.length, Math.min(count, 2) + 1);
    const tabs = resultPayload(api(session, ['tab', 'list', '--workspace', workspaceId])).tabs;
    assert.equal(tabs.length, 1 + Math.ceil(Math.max(0, count - 2) / 4));
    assert.ok(tabs.every(tab => tab.pane_count <= (tab.tab_id === created.tab.tab_id ? 3 : 4)));
    checkpoints.push({ workers: count, tabs: tabs.length, panesPerTab: tabs.map(tab => tab.pane_count),
      mainWidth: main.rect.width, areaWidth: layout.area.width, mainHeight: main.rect.height, areaHeight: layout.area.height });
  }
  passed = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed, checkpoints, modelCalls: 0 }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed, checkpoints: checkpoints.length, modelCalls: 0 }) + '\n');
} finally {
  // Only close the workspace created by this run, after checking every terminal identity. / 核对全部终端身份后，只关闭本次创建的工作区。
  const live = resultPayload(api(session, ['pane', 'list', '--workspace', workspaceId])).panes;
  const expected = new Map([[mainId, created.root_pane.terminal_id], ...records.map(item => [item.paneId, item.terminalId])]);
  if (passed && live.every(pane => expected.get(pane.pane_id) === pane.terminal_id)) api(session, ['workspace', 'close', workspaceId]);
  else process.stderr.write('Kept isolated validation workspace for inspection\n');
}
