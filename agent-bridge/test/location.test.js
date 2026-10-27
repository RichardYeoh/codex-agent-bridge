'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placementFor, splitDirection } = require('../lib/location');

test('normal delegation reuses the caller pane workspace', () => {
  assert.deepEqual(placementFor({}, { HERDR_PANE_ID: 'w1:p2', HERDR_WORKSPACE_ID: 'w1' }),
    { mode: 'pane', anchorPaneId: 'w1:p2', workspaceId: 'w1', direction: null });
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
