'use strict';

const path = require('node:path');

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function validResumeArgv(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 64
      || args.some(value => typeof value !== 'string' || value.includes("'") || CONTROL.test(value))) return false;
  const first = args[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(first) || first.includes('/') || first.includes('\\')
      || path.isAbsolute(first)) return false;
  return Buffer.byteLength(args.join(' '), 'utf8') <= 8 * 1024;
}

function buildResumeArgv(stateDir, taskId, nativeId) {
  if (typeof stateDir !== 'string' || typeof taskId !== 'string' || typeof nativeId !== 'string') return null;
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(taskId)
      || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(nativeId)) return null;
  const args = ['node', path.resolve(__dirname, '..', 'bin', 'resume-worker.js'), path.resolve(stateDir), taskId, nativeId];
  return validResumeArgv(args) ? args : null;
}

module.exports = { validResumeArgv, buildResumeArgv };
