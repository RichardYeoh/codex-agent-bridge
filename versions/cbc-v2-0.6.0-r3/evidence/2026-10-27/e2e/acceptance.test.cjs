'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePort } = require('./src/port.cjs');

test('valid ports and surrounding spaces', () => {
  assert.equal(parsePort('80'), 80);
  assert.equal(parsePort(' 443 '), 443);
  assert.equal(parsePort('65535'), 65535);
});
for (const value of ['oops', '', '1e2', '1.5', '0', '65536']) {
  test(`reject ${JSON.stringify(value)}`, () => assert.throws(() => parsePort(value)));
}
