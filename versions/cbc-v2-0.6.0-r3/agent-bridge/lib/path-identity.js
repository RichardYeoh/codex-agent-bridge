'use strict';

const fs = require('node:fs'), path = require('node:path');
function canonicalPath(value) {
  let cursor = path.resolve(value); const tail = [];
  // Resolve the nearest existing ancestor so not-yet-created files share alias identity. / 解析最近已有父目录，让待创建文件也共享别名身份。
  for (;;) {
    try { cursor = fs.realpathSync.native(cursor); break; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.unshift(path.basename(cursor)); cursor = parent;
    }
  }
  const result = path.join(cursor, ...tail);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
module.exports = { canonicalPath };
