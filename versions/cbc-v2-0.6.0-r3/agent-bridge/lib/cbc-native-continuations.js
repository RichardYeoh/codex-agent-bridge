'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const RECOVERY_TEXT = '<system-reminder data-role="error-recovery">Network error occurred, please continue</system-reminder>';
const time = row => typeof row?.timestamp === 'number' ? row.timestamp : Date.parse(row?.timestamp);
const body = row => Array.isArray(row?.content) && row.content.length === 1
  && row.content[0].type === 'input_text' ? row.content[0].text : null;
const requestId = row => row?.providerData?.conversationRequestId;
const sameIdentity = (a, b) => typeof a?.sessionId === 'string' && a.sessionId === b?.sessionId
  && typeof a.cwd === 'string' && typeof b.cwd === 'string'
  && path.resolve(a.cwd).toLowerCase() === path.resolve(b.cwd).toLowerCase();

// Exclude only the verified native network-retry pair, never arbitrary metadata or reminder text.
// 仅排除经完整证据核对的原生网络重试记录对，不泛化忽略元数据或提示文本。
function classifyContinuations(records) {
  const messages = records.filter(row => row?.type === 'message');
  const counts = new Map();
  for (const row of messages) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const unique = row => typeof row?.id === 'string' && row.id.length > 0 && counts.get(row.id) === 1;
  const users = [], ignored = [];
  let anchor = null;
  for (let i = 0; i < messages.length; i++) {
    const row = messages[i];
    if (row.role !== 'user') continue;
    const parent = messages[i - 1], meta = row.providerData, error = parent?.providerData?.error;
    const id = requestId(anchor);
    const retry = anchor && unique(anchor) && unique(row) && unique(parent)
      && typeof id === 'string' && id.length > 0 && requestId(row) === id && requestId(parent) === id
      && anchor.providerData?.agent === 'cli' && anchor.providerData.isMeta !== true
      && anchor.providerData.skipRun !== true && anchor.providerData.startsNewUserRequest !== false
      && meta?.agent === 'cli' && meta.isMeta === true && meta.startsNewUserRequest === false
      && !meta.injectedHistory && !anchor.providerData.injectedHistory && !parent.providerData?.injectedHistory
      && body(row) === RECOVERY_TEXT && parent.role === 'assistant' && parent.status === 'incomplete'
      && parent.providerData?.agent === 'cli' && parent.providerData.skipRun === true
      && error?.code === 'ECONNRESET' && error.isNetworkError === true
      && error.networkErrorAutoRetry === true && error.isRetryable === true
      && error.isStreamTimeout === false && row.parentId === parent.id
      && sameIdentity(row, anchor) && sameIdentity(parent, anchor)
      && Number.isFinite(time(anchor)) && Number.isFinite(time(parent)) && Number.isFinite(time(row))
      && time(anchor) <= time(parent) && time(parent) < time(row);
    if (retry) {
      ignored.push({ kind: 'native-network-retry', at: new Date(time(row)).toISOString(),
        nativeMessageId: row.id, parentMessageId: parent.id,
        evidenceSha256: crypto.createHash('sha256').update(JSON.stringify([anchor, parent, row])).digest('hex') });
    } else {
      users.push(row); anchor = row;
    }
  }
  return { users, ignored };
}

module.exports = { classifyContinuations, RECOVERY_TEXT };
