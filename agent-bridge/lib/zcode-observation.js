'use strict';

const { turnState } = require('./zcode-remote');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Queries never create a session or replay a possibly admitted write. / 查询不得新建会话或重放可能已接纳的写入。
async function queryAdmission(remote, envelope, { attempts = 4, sleep = pause, reconnect } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await (typeof remote === 'function' ? remote() : remote).query(envelope);
      const entry = response.results?.find(item => item.key?.commandId === envelope.commandId
        && item.key.sessionId === envelope.sessionId);
      if (entry?.result && entry.result !== 'unknown' && entry.result.commandId === envelope.commandId) return entry.result;
    } catch (error) {
      if (attempt === attempts - 1 || error.code === 'ZCODE_RELAY_LOCAL_BUSY' || /KICKED|AUTH_FAILED|WRONG_PARAM/.test(error.message)) throw error;
      if (reconnect) {
        try { await reconnect(); }
        catch (reconnectError) {
          if (reconnectError.code === 'ZCODE_RELAY_LOCAL_BUSY' || /KICKED|AUTH_FAILED|WRONG_PARAM/.test(reconnectError.message)) throw reconnectError;
        }
      }
    }
    if (attempt < attempts - 1) await sleep(Math.min(1000 * 2 ** attempt, 8000));
  }
  throw new Error('ZCode command admission unconfirmed; no write replayed');
}

async function resolveTurn(remote, snapshot, commandId, { maxPages = 50, headerRowId } = {}) {
  const direct = turnState(snapshot, commandId);
  if (direct.seen) return { ...direct, evidence: 'snapshot', seq: snapshot.seq, logEpoch: snapshot.logEpoch };
  // Read the authoritative branch, never infer completion from cached headers or files. / 查询权威分支，不以缓存轮次头或交付文件推断结束。
  let beforeRowId = Number.isSafeInteger(headerRowId) ? headerRowId + 1 : undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await remote.call('zcode-agent', 'conversationRowsRangeV4', {
      ...remote.target, sessionId: snapshot.sessionId, limit: 200,
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
    });
    if (result.atLogEpoch !== snapshot.logEpoch) throw new Error('ZCode history epoch changed; refresh observation');
    if (!Number.isSafeInteger(result.atSeq) || result.atSeq < snapshot.seq) throw new Error('ZCode history watermark stale; refresh observation');
    const header = result.rows.find(row => row.kind === 'turnHeader' && row.sourceCommandId === commandId);
    if (header) return { ...turnState({ ...snapshot, rows: { window: [header] } }, commandId),
      evidence: 'conversationRowsRangeV4', seq: result.atSeq, logEpoch: result.atLogEpoch };
    if (page === 0 && headerRowId !== undefined) { beforeRowId = undefined; continue; }
    if (!result.hasMore || !result.rows.length) break;
    const cursor = Math.min(...result.rows.map(row => row.rowId));
    if (!Number.isFinite(cursor) || beforeRowId !== undefined && cursor >= beforeRowId) break;
    beforeRowId = cursor;
  }
  return { seen: false, terminal: false, evidence: 'history-unconfirmed' };
}

// Renew wait windows; only transport faults consume bounded retries. / 自动续观察窗口，仅传输故障消耗有界重试预算。
async function observeExecution({ getConversation, refresh, reconnect, commandId, sessionId,
  checkpoint = () => {}, timeoutMs = 1800000, maxReconnects = 5, maxUnconfirmed = 3,
  initialHeaderRowId, sleep = pause }) {
  let failures = 0, unconfirmed = 0, headerRowId = initialHeaderRowId;
  for (;;) {
    try {
      const conversation = getConversation();
      const snapshot = conversation.snapshot;
      if (snapshot.sessionId !== sessionId) throw new Error('ZCode observation session identity mismatch');
      const result = await resolveTurn(conversation.remote, snapshot, commandId, { headerRowId });
      if (result.header) headerRowId = result.header.rowId;
      if (headerRowId !== undefined) result.headerRowId = headerRowId;
      checkpoint({ result, snapshot });
      if (snapshot.pendingInteractions?.length || snapshot.workspaceHookAdmission) return { result, snapshot, interaction: true };
      if (result.terminal && (snapshot.control.activeWorks?.some(work => work.sourceCommandId !== commandId)
          || snapshot.queue?.items?.length)) return { result, snapshot, foreignWork: true };
      if (result.terminal) return { result, snapshot };
      if (!result.seen) {
        if (++unconfirmed >= maxUnconfirmed) throw new Error('ZCode submission_unconfirmed; no terminal evidence for original command');
        await sleep(1000 * unconfirmed); await refresh(); continue;
      }
      unconfirmed = 0;
      const previousSeq = snapshot.seq;
      try {
        await conversation.wait(s => s.seq > previousSeq, timeoutMs);
      } catch (error) {
        if (error.code !== 'ZCODE_OBSERVATION_WINDOW') throw error;
        await refresh();
      }
      failures = 0;
    } catch (error) {
      if (error.code === 'ZCODE_RELAY_LOCAL_BUSY' || /KICKED|AUTH_FAILED|WRONG_PARAM|identity mismatch|submission_unconfirmed/.test(error.message)
          || failures >= maxReconnects) throw error;
      await sleep(Math.min(1000 * 2 ** failures++, 30000));
      // Release the old connection before acquiring the only Relay seat. / 获取唯一Relay席位前先释放旧连接。
      try { await reconnect(); } catch (reconnectError) {
        if (reconnectError.code === 'ZCODE_RELAY_LOCAL_BUSY' || /KICKED|AUTH_FAILED|WRONG_PARAM/.test(reconnectError.message)) throw reconnectError;
        if (failures >= maxReconnects) throw reconnectError;
      }
    }
  }
}

module.exports = { queryAdmission, resolveTurn, observeExecution };
