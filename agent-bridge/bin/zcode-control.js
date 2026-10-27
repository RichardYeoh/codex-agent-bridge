#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadTask, taskDir, writeJsonAtomic } = require('../lib/util');
const { ZCodeRemote, Conversation, readBinding } = require('../lib/zcode-remote');

async function main() {
  const [id, action, interactionId] = process.argv.slice(2);
  if (!['snapshot', 'approve-once'].includes(action)) throw new Error('zcode-control <task-id> <snapshot|approve-once [interaction-id]>');
  const task = loadTask(id);
  if (task.agent !== 'zcode' || !task.workerSessionId) throw new Error('Expected a captured ZCode task session');
  const remote = new ZCodeRemote(readBinding(task.zcodeConfig));
  remote.on('fault', () => {});
  let conversation;
  try {
    await remote.connect(); await remote.attachProject(task.cwd);
    conversation = new Conversation(remote, task.workerSessionId);
    conversation.on('fault', () => {});
    const snapshot = await conversation.subscribe();
    if (action === 'snapshot') {
      process.stdout.write(JSON.stringify({ control: snapshot.control, pendingInteractions: snapshot.pendingInteractions,
        queue: snapshot.queue, rows: snapshot.rows.window }, null, 2) + '\n');
      return;
    }
    // Approval must name an existing permission; no project-wide or full-access grant. / 批准必须定位现存权限请求，不授予项目级或完全访问权。
    const interaction = snapshot.pendingInteractions.find(item => item.interactionId === interactionId && item.kind === 'permission');
    if (!interaction?.payload?.options?.some(option => option.optionId === 'allowOnce')) throw new Error('No matching one-time permission');
    const envelope = remote.envelope('resolveInteraction', task.workerSessionId, { interactionId, answer: { optionId: 'allowOnce' } });
    writeJsonAtomic(path.join(taskDir(id), 'zcode-approval.json'), { envelope });
    const ack = await remote.command(envelope);
    process.stdout.write(JSON.stringify({ status: ack.status, reasonCode: ack.reasonCode }) + '\n');
  } finally { await conversation?.dispose(); remote.close(); }
}
main().catch(() => { process.stderr.write('ZCode control failed; no automatic retry was performed.\n'); process.exitCode = 1; });
