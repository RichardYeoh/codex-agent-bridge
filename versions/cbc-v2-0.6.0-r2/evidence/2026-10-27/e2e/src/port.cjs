'use strict';

/**
 * Parse a port value from text. / 从文本解析端口值。
 *
 * Stage 3 (rework 2): after trimming, the input must be a non-empty
 * decimal-integer string; the parsed value must also fall within the
 * valid port range 1..65535. Format violations throw TypeError, range
 * violations throw RangeError.
 * 第三阶段（第二次返工）：去除首尾空格后，输入必须是非空十进制整数字符串，
 * 且解析值须落在合法端口范围 1..65535 内；格式违规抛 TypeError，
 * 范围越界抛 RangeError。
 *
 * @param {string} text Raw input text. / 原始输入文本。
 * @returns {number} Parsed port value within 1..65535. / 1..65535 内的端口值。
 */
function parsePort(text) {
  // Normalize by trimming surrounding whitespace. / 去除首尾空格做规范化。
  const trimmed = String(text).trim();

  // Empty text and non-decimal-integer formats are rejected. / 空文本与非十进制整数格式一律拒绝。
  if (trimmed === '' || !/^[0-9]+$/.test(trimmed)) {
    throw new TypeError(`Invalid port: ${String(text)}`);
  }

  // Decimal-digit string is now safe to convert. / 此时十进制数字串可安全转换。
  const value = Number(trimmed);

  // Port range check: 1..65535 inclusive. / 端口范围校验：1..65535（含端点）。
  if (value < 1 || value > 65535) {
    throw new RangeError(`Port out of range: ${String(text)}`);
  }

  return value;
}

module.exports = { parsePort };
