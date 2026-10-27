'use strict';
const assert = require('node:assert/strict');
const { normalizeLabel } = require('./normalize.cjs');
assert.equal(normalizeLabel(' AbC '), 'ABC');
assert.equal(normalizeLabel('  '), '');
for (const value of [null, undefined, false, 1, {}, []]) assert.throws(() => normalizeLabel(value), TypeError);
console.log('AGY_ARTIFACT_PASS');
