'use strict';

// Fail before any worker operation; no real IPC or process is available in this fixture. / 在执行者操作前失败，本替身不提供真实IPC或进程。
const herdr = require('../../lib/herdr');
herdr.ensureServer = async () => {
  const error = new Error('PermissionDenied: fixture IPC access rejected');
  error.code = 'HERDR_IPC_ACCESS_DENIED'; throw error;
};
herdr.api = () => { throw new Error('Fixture forbids Herdr worker operations'); };
require('../../lib/worker-context').tryReuseContext = () => { throw new Error('Fixture forbids context reuse after denied IPC'); };
