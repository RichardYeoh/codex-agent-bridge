'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', 'acceptance.test.cjs', 'layout-acceptance.test.cjs'], {
  cwd: path.resolve(__dirname, '../evidence/2026-10-27/e2e'), stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
