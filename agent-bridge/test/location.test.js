'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placementFor, splitDirection, planInTab } = require('../lib/location');

test('normal delegation reuses the caller pane workspace', () => {
  assert.deepEqual(placementFor({}, { HERDR_PANE_ID: 'w1:p2', HERDR_WORKSPACE_ID: 'w1' }),
    { mode: 'pane', anchorPaneId: 'w1:p2', workspaceId: 'w1', direction: null });
});

test('main Codex retains the whole left half; overflow pages fill right/down/left-down', () => {
  let next = 0;
  const pane = (x, y, width, height) => ({ pane_id: `pane-${next++}`, rect: { x, y, width, height } });
  const main = pane(0, 0, 160, 48), mainId = main.pane_id;
  const tabs = [{ area: { x: 0, y: 0, width: 160, height: 48 }, panes: [main] }], owned = new Set();
  for (let i = 1; i <= 10; i++) {
    let selected, plan;
    for (let index = 0; index < tabs.length; index++) {
      plan = planInTab(tabs[index], owned, index === 0 ? mainId : undefined);
      if (plan) { selected = tabs[index]; break; }
    }
    if (!selected) {
      const worker = pane(0, 0, 160, 48); owned.add(worker.pane_id);
      tabs.push({ area: { x: 0, y: 0, width: 160, height: 48 }, panes: [worker] });
    } else {
      const parent = selected.panes.find(item => item.pane_id === plan.paneId), r = parent.rect;
      const child = plan.direction === 'right' ? pane(r.x + r.width / 2, r.y, r.width / 2, r.height)
        : pane(r.x, r.y + r.height / 2, r.width, r.height / 2);
      if (plan.direction === 'right') r.width /= 2; else r.height /= 2;
      selected.panes.push(child); owned.add(child.pane_id);
    }
    assert.deepEqual(main.rect, { x: 0, y: 0, width: 80, height: 48 });
    assert.equal(tabs[0].panes.length, Math.min(i, 2) + 1);
    assert.equal(tabs.length, 1 + Math.ceil(Math.max(0, i - 2) / 4));
    assert.ok(tabs.slice(1).every(tab => tab.panes.length <= 4));
  }
});

test('unmanaged panes are never split by the automatic packing policy', () => {
  const layout = { area: { width: 160, height: 48 }, panes: [
    { pane_id: 'main', rect: { x: 0, y: 0, width: 80, height: 48 } },
    { pane_id: 'user-pane', rect: { x: 80, y: 0, width: 80, height: 48 } }] };
  assert.equal(planInTab(layout, new Set(), 'main'), null);
  assert.equal(planInTab(layout, new Set()), null);
});
test('daemon clients can explicitly select an existing workspace tab', () => {
  assert.deepEqual(placementFor({ workspace: 'w3' }, {}), { mode: 'tab', workspaceId: 'w3' });
  assert.throws(() => placementFor({}, {}), /specify --workspace or --pane/);
  assert.deepEqual(placementFor({ workspace: 'w3' }, { HERDR_PANE_ID: 'w1:p2', HERDR_WORKSPACE_ID: 'w1' }),
    { mode: 'tab', workspaceId: 'w3' });
});
test('cross-server IDs are not inherited and new workspaces require an explicit request', () => {
  assert.throws(() => placementFor({ session: 'other' }, { HERDR_PANE_ID: 'w1:p1' }), /No caller workspace/);
  assert.deepEqual(placementFor({ 'new-workspace': true, 'isolation-reason': 'independent worktree' }, {}),
    { mode: 'workspace', reason: 'independent worktree' });
  assert.throws(() => placementFor({ 'new-workspace': true, workspace: 'w1' }, {}), /conflicts/);
});
test('split geometry avoids creating narrow columns', () => {
  assert.equal(splitDirection({ width: 164, height: 45 }), 'right');
  assert.equal(splitDirection({ width: 80, height: 45 }), 'down');
});
