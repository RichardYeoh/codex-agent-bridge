'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { bindingKey } = require('../lib/worker-binding');
const { assertSingleActive } = require('../lib/worker-scheduling');
const task = (id, workerKey, extra = {}) => ({ id, workerKey, cwd: path.resolve('project'), agent: 'cbc', herdrSession: 'test',
  status: 'running', allowedWritePaths: [`src/${id}.js`], ...extra });

test('work context keys are opaque, bounded values rather than predefined roles', () => {
  assert.equal(bindingKey(), 'primary'); assert.equal(bindingKey(' 任意连续任务 '), '任意连续任务');
  assert.throws(() => bindingKey('')); assert.throws(() => bindingKey('a\nb'));
});
test('ordinary delegation remains serial even for distinct worker contexts', () => {
  assert.throws(() => assertSingleActive(task('next', 'next'), [task('first', 'first')]), /Another worker/);
  assert.throws(() => assertSingleActive(task('next', 'next', { parallel: true }), [task('first', 'first')]), /Another worker/);
});
test('explicit parallel delegates have distinct contexts and disjoint write scopes', () => {
  const active = Array.from({ length: 5 }, (_, i) => task(`module-${i}`, `module-${i}`, { parallel: true }));
  for (let i = 0; i < active.length; i++) assert.doesNotThrow(() => assertSingleActive(active[i], active.slice(0, i)));
  assert.throws(() => assertSingleActive(task('extra', 'module-0', { parallel: true }), active), /occupied/);
  assert.throws(() => assertSingleActive(task('extra', 'separate', { parallel: true, allowedWritePaths: ['src'] }), active), /overlaps/);
  assert.throws(() => assertSingleActive(task('extra', 'separate', { parallel: true, allowedWritePaths: ['src/*.js'] }), active), /globs/);
});
test('a pending review owns its context until acceptance or cancellation', () => {
  const next = task('next', 'stable');
  assert.throws(() => assertSingleActive(next, [task('first', 'stable', { status: 'review_pending' })]), /occupied/);
  assert.doesNotThrow(() => assertSingleActive(next, [task('first', 'stable', { status: 'accepted' })]));
});
test('shared Desktop relay seats cannot be used by simultaneous ZCode delegates', () => {
  const common = { parallel: true, agent: 'zcode', zcodeBindingSha256: 'same-host' };
  assert.throws(() => assertSingleActive(task('next', 'next', common), [task('first', 'first', common)]), /one terminal/);
});
