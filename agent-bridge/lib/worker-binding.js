'use strict';

const path = require('node:path');

// Codex chooses context continuity; the tool treats this key as opaque metadata. / 上下文连续性由Codex判断，工具只把绑定键作为不透明元数据。
function bindingKey(value) {
  const key = value === undefined || value === null ? 'primary' : String(value).trim();
  if (!key || key.length > 128 || /[\x00-\x1f]/.test(key)) throw new Error('Invalid worker context binding key');
  return key;
}

function sameBinding(a, b) {
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return canonical(a.cwd) === canonical(b.cwd) && a.agent === b.agent && a.herdrSession === b.herdrSession
    && bindingKey(a.workerKey) === bindingKey(b.workerKey);
}

module.exports = { bindingKey, sameBinding };
