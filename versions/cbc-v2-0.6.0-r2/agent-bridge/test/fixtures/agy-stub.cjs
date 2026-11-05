'use strict';
const readline = require('node:readline');
const args = process.argv.slice(2), at = args.indexOf('--conversation');
const id = process.env.AGY_STUB_WRONG_ID ? 'different-session' : at >= 0 ? args[at + 1] : 'fixture-conversation';
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ event: 'init', conversation_id: id, init: {} });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const text = JSON.parse(line).message.content;
  if (text === 'WAIT') return;
  if (text === 'INVALID') { process.stdout.write('invalid json\n'); return; }
  if (text === 'PERMISSION') process.stderr.write('tool soft-denied: requires approval\n');
  emit({ event: 'step_update', step_update: { conversation_id: id, step_type: 'agent_response', text_delta: '中文' } });
  emit({ event: 'result', result: { conversation_id: id, status: text === 'ERROR' ? 'ERROR' : 'SUCCESS',
    response: '中文结果', ...(text === 'ERROR' ? { error: 'quota exhausted' } : {}) } });
});
