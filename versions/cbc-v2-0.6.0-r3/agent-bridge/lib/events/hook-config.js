'use strict';

const path = require('node:path');
const { canonical } = require('./store');
const MARKER = 'Codex events: observe only';
function makeGroups(configFile) {
  const script = path.resolve(__dirname, '../../hooks/codex-events.js');
  const values = [process.execPath, script, path.resolve(configFile)];
  if (values.some(v => /[\r\n"`$]/.test(v))) throw new Error('Hook paths contain unsupported shell metacharacters');
  const ps = v => `'${v.replace(/'/g, "''")}'`, sh = v => `'${v.replace(/'/g, "'\\''")}'`;
  const handler = { type: 'command', command: values.map(sh).join(' '),
    commandWindows: `pwsh -NoProfile -NonInteractive -Command "& ${values.map(ps).join(' ')}"`,
    async: true, timeout: 3, statusMessage: MARKER };
  return Object.fromEntries(['Stop', 'PermissionRequest', 'Interrupt'].map(event => [event, { hooks: [{ ...handler }] }]));
}
function merge(existing, groups) {
  const value = structuredClone(existing || {}); value.hooks ||= {};
  for (const [event, group] of Object.entries(groups)) {
    value.hooks[event] ||= [];
    if (!Array.isArray(value.hooks[event])) throw new Error('Unrecognized existing Hook configuration');
    if (!value.hooks[event].some(item => canonical(item) === canonical(group))) value.hooks[event].push(group);
  }
  return value;
}
function remove(existing, groups) {
  const value = structuredClone(existing);
  for (const [event, group] of Object.entries(groups)) {
    if (!Array.isArray(value.hooks?.[event])) continue;
    value.hooks[event] = value.hooks[event].filter(item => canonical(item) !== canonical(group));
    if (!value.hooks[event].length) delete value.hooks[event];
  }
  return value;
}
module.exports = { makeGroups, merge, remove };
