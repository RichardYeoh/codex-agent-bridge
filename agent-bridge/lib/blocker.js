'use strict';

function classifyBlocker(text) {
  const tail = String(text || '').split(/\r?\n/).slice(-50).join('\n');
  if (/insufficient_quota|quota (?:exceeded|exhausted)|usage limit (?:reached|exceeded)|credit balance (?:exhausted|insufficient)|积分不足|额度(?:已)?(?:用尽|耗尽)|余额不足/i.test(tail)) {
    return { type: 'quota', requiresAction: true, message: 'Worker quota/credit limit; preserve session and resume after availability is restored' };
  }
  if (/rate_limit_exceeded|too many requests|\b429\s*(?:Too Many Requests|rate limit)|请求过于频繁/i.test(tail)) {
    return { type: 'rate_limit', requiresAction: true, message: 'Worker rate limited; no automatic task resubmission' };
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network (?:error|unreachable)|网络连接失败|网络不可用/i.test(tail)) {
    return { type: 'network', requiresAction: true, message: 'Worker network failure; preserve session and inspect before resuming' };
  }
  return null;
}

module.exports = { classifyBlocker };
