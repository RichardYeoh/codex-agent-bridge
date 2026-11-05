#!/usr/bin/env node
'use strict';

const { loadConfig, capture } = require('../lib/events/store');
let size = 0, chunks = [], finished = false;
function finish(exit = false) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  // Empty JSON carries no decision for Stop, permission, or interruption. / 空JSON不裁决停止、权限或中断。
  process.stdout.write('{}\n', () => { if (exit) process.exit(0); });
}
const timer = setTimeout(() => finish(true), 700);
process.stdout.on('error', () => process.exit(0));
// Observation only: every controlled exit emits valid JSON and exits zero. / 仅观察：每个可控退出路径输出有效JSON并返回零。
process.stdin.on('data', chunk => {
  if (finished) return;
  size += chunk.length;
  if (size > 512 * 1024) { chunks = []; finish(true); return; }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  if (finished) return;
  try { capture(loadConfig(process.argv[2]), JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {}
  finish();
});
process.stdin.on('error', () => finish(true));
