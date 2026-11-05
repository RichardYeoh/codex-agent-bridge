#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('../lib/protocol-v2');
async function main() {
  const args = process.argv.slice(2), options = { artifacts: [] };
  for (let i = 0; i < args.length; i += 2) {
    if (!['--request-file', '--outcome', '--reason', '--artifact'].includes(args[i]) || args[i + 1] === undefined) throw new Error('Invalid result command argument');
    if (args[i] === '--artifact') options.artifacts.push(args[i + 1]);
    else options[args[i].slice(2)] = args[i + 1];
  }
  const file = path.resolve(options['request-file'] || '');
  const r = JSON.parse(p.readRegular(file)); p.validateRequest(r);
  if (file !== path.join(p.requestDirectory(r), 'request.json')) throw new Error('Noncanonical request file');
  // The worker may claim a result but cannot accept or control another session. / 执行端只能声明结果，不能验收或控制其他会话。
  const result = await require('../lib/protocol-artifacts').submitResult(r, {
    outcome: options.outcome, reason: options.reason || '', artifacts: options.artifacts,
  });
  process.stdout.write(JSON.stringify({ requestId: r.requestId, resultRecorded: true, review: result.review }) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ code: error.code || 'RESULT_REFUSED', message: error.message }) + '\n'); process.exitCode = 1; });
