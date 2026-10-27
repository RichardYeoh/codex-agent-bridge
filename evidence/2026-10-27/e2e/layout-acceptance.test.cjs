'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('the restored task uses the required cbc marker exactly', () => {
  assert.equal(fs.readFileSync('layout-proof.txt', 'utf8').trim(), 'cbc|workspace-reuse|resumed');
});
