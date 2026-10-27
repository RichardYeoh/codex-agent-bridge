/**
 * Normalize label by trimming whitespace and converting to uppercase.
 * 规范化标签：去除首尾空白字符并转换为大写。
 *
 * @param {string} label - Input label string / 输入标签字符串
 * @returns {string} - Normalized label / 规范化后的标签
 * @throws {TypeError} - If input is not a string / 如果输入不是字符串
 */
function normalizeLabel(label) {
  if (typeof label !== 'string') {
    throw new TypeError('Label must be a string / 标签必须是字符串');
  }
  return label.trim().toUpperCase();
}

module.exports = {
  normalizeLabel,
};
