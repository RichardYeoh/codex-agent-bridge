'use strict';

const { spawnSync } = require('node:child_process');

function readPaneIdentity(binary, session, paneId, { spawnSyncFn = spawnSync } = {}) {
  if (typeof binary !== 'string' || !binary || typeof session !== 'string' || !session
      || typeof paneId !== 'string' || !paneId) return null;
  const args = [...(session === 'default' ? [] : ['--session', session]), 'pane', 'get', paneId];
  const scripted = /\.(?:c?js)$/i.test(binary);
  const result = spawnSyncFn(scripted ? process.execPath : binary,
    scripted ? [binary, ...args] : args,
    { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const pane = parsed?.result?.pane || parsed?.pane;
    if (pane?.pane_id !== paneId || typeof pane.terminal_id !== 'string' || !pane.terminal_id) return null;
    return { paneId: pane.pane_id, terminalId: pane.terminal_id };
  } catch { return null; }
}

function herdrCall(binary, session, args, spawnSyncFn) {
  if (typeof binary !== 'string' || !binary || typeof session !== 'string' || !session) return null;
  const cliArgs = [...(session === 'default' ? [] : ['--session', session]), ...args];
  const scripted = /\.(?:c?js)$/i.test(binary);
  const result = spawnSyncFn(scripted ? process.execPath : binary,
    scripted ? [binary, ...cliArgs] : cliArgs,
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  try { return JSON.parse(result.stdout); }
  catch { return null; }
}

function readNativeInventory(binary, session, { spawnSyncFn = spawnSync } = {}) {
  const panesResponse = herdrCall(binary, session, ['pane', 'list'], spawnSyncFn);
  const agentsResponse = herdrCall(binary, session, ['agent', 'list'], spawnSyncFn);
  const panes = panesResponse?.result?.panes || panesResponse?.panes;
  const agents = agentsResponse?.result?.agents || agentsResponse?.agents;
  if (!Array.isArray(panes) || !Array.isArray(agents)) return null;
  const records = new Map();
  for (const pane of panes) {
    if (!pane || typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') return null;
    records.set(pane.pane_id, { ...pane });
  }
  for (const agent of agents) {
    if (!agent || typeof agent.pane_id !== 'string') return null;
    records.set(agent.pane_id, { ...records.get(agent.pane_id), ...agent });
  }
  return [...records.values()];
}

module.exports = { readPaneIdentity, readNativeInventory };
