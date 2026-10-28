'use strict';
const assert = require('node:assert/strict');
const { normalizeLabel } = require('./normalize.cjs');
assert.equal(normalizeLabel(' AbC '), 'ABC');
assert.equal(normalizeLabel(''), '');
assert.throws(() => normalizeLabel(3), TypeError);
console.log('OPENCODE_REWORK_PASS');
