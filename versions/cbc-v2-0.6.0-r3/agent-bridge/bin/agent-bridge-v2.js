#!/usr/bin/env node
'use strict';

// Versioned entry enrolls new CBC tasks only; existing tasks keep their recorded protocol. / 分版本入口仅登记新CBC任务，已有任务保持原协议。
process.env.AGENT_BRIDGE_TASK_PROTOCOL = '2';
require('./agent-bridge').main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code || 'AGENT_BRIDGE_ERROR' }) + '\n');
  process.exitCode = 1;
});
