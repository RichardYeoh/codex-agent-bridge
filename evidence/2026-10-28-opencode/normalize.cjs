'use strict';

/**
 * Normalize a label into a trimmed, upper-cased string.
 * 将标签规范化为去除首尾空白并转为大写后的字符串。
 *
 * @param {string} label Raw label value / 原始标签值
 * @returns {string} Normalized label / 规范化后的标签
 * @throws {TypeError} When the input is not a string / 输入不是字符串时抛出
 */
function normalizeLabel(label) {
  // Reject non-string inputs before touching string methods / 在调用字符串方法前拒绝非字符串输入
  if (typeof label !== 'string') {
    throw new TypeError('normalizeLabel expects a string / normalizeLabel 只接受字符串');
  }

  // Trim surrounding whitespace, then upper-case the result / 去除首尾空白后再转大写
  return label.trim().toUpperCase();
}

module.exports = { normalizeLabel };
