'use strict';

function safeMessage(value) {
  return String(value || 'Unknown error')
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '<redacted-url>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(?:token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '<redacted-credential>')
    .replace(/session_[a-zA-Z0-9_-]+/g, '<native-session>')
    .slice(0, 1500);
}

function diagnostic(error, stage, transportFault) {
  const value = { stage, name: error?.name || 'Error', message: safeMessage(error?.message),
    ...(error?.code ? { code: safeMessage(error.code) } : {}) };
  if (error?.cause) {
    value.cause = { name: error.cause.name, message: safeMessage(error.cause.message) };
    // Retain schema paths without copying business payloads or authentication. / 保留模式校验路径，不复制业务载荷或认证材料。
    if (Array.isArray(error.cause.issues)) value.cause = { name: error.cause.name,
      issues: error.cause.issues.slice(0, 8).map(item => ({ code: item.code, path: item.path })) };
  }
  if (transportFault) value.transportFault = safeMessage(transportFault.message);
  return value;
}

function failureReason(error, fallback) {
  if (error?.code === 'ZCODE_RELAY_LOCAL_BUSY') return 'relay_local_busy';
  if (/KICKED/.test(error?.message || '')) return 'relay_kicked';
  if (/AUTH_FAILED/.test(error?.message || '')) return 'relay_auth_failed';
  return fallback;
}

module.exports = { diagnostic, failureReason, safeMessage };
