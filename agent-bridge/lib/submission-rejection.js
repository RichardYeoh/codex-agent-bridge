'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const TASK_ID = /^[a-z][a-z0-9-]{2,47}$/;
const REJECTED_MESSAGES = new Set([
  paneId => `agent ${paneId} is not an active named agent`,
  paneId => `agent ${paneId} is no longer the pane foreground process`,
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function unresolved(reason) {
  return { state: 'unresolved', reason };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parseJson(bytes) {
  return JSON.parse(bytes.toString('utf8'));
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tokenizeCommand(command) {
  const source = command.replace(/`[ \t]*(?:\r\n|\n|\r)[ \t]*/g, ' ');
  const tokens = [];
  let value = '', quote = null, started = false;
  const push = () => {
    if (started) tokens.push(value);
    value = ''; started = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (quote === "'") {
      if (char === "'" && next === "'") { value += "'"; index += 1; }
      else if (char === "'") quote = null;
      else value += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '`' && next !== undefined) { value += next; index += 1; }
      else if (char === '"') quote = null;
      else value += char;
      started = true;
      continue;
    }
    if (char === '`' && next !== undefined) {
      value += next; started = true; index += 1; continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { push(); continue; }
    if (char === ';' || char === '|' || char === '&' && next === '&') {
      push();
      if ((char === '|' || char === '&') && next === char) { tokens.push(char + char); index += 1; }
      else tokens.push(char);
      continue;
    }
    if (char === '{' || char === '}') { push(); tokens.push(char); continue; }
    value += char; started = true;
  }
  if (quote) return null;
  push();
  return tokens;
}

function baseName(value) {
  return path.win32.basename(String(value).replaceAll('/', '\\')).toLowerCase();
}

function canonicalPath(value) {
  let normalized = value;
  const msysDrive = normalized.match(/^\/([a-zA-Z])\/(.*)$/);
  if (process.platform === 'win32' && msysDrive) {
    normalized = `${msysDrive[1].toUpperCase()}:\\${msysDrive[2].replaceAll('/', '\\')}`;
  }
  const resolved = process.platform === 'win32' ? path.win32.resolve(normalized) : path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function literalValue(value) {
  return typeof value === 'string' && Boolean(value.trim())
    && !/[;$|&<>`\r\n]/.test(value) && !/\$[({]|%[^%]+%/.test(value);
}

function stripEnvironment(tokens, stateDir) {
  const remaining = [...tokens], values = Object.create(null);
  while (remaining.length) {
    const match = remaining[0].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) break;
    const [, name, value] = match;
    if (!['MSYSTEM', 'AGENT_BRIDGE_STATE_DIR', 'AGENT_BRIDGE_CBC'].includes(name)
        || Object.hasOwn(values, name) || !literalValue(value)) return null;
    if (name === 'MSYSTEM' && value !== 'UCRT64') return null;
    if (name === 'AGENT_BRIDGE_STATE_DIR' && canonicalPath(value) !== canonicalPath(stateDir)) return null;
    values[name] = value;
    remaining.shift();
  }
  if (Object.keys(values).length
      && (values.MSYSTEM !== 'UCRT64' || !values.AGENT_BRIDGE_STATE_DIR)) return null;
  if (remaining.some(token => /\$[({]|%[^%]+%/.test(token))) return null;
  return remaining;
}

function trimBlock(tokens) {
  const result = [...tokens];
  while (result[0] === '&') result.shift();
  while (result[0] === '{' && result.at(-1) === '}') { result.shift(); result.pop(); }
  return result;
}

function directDispatch(tokens, taskId, stateDir) {
  const command = stripEnvironment(trimBlock(tokens), stateDir);
  if (!command) return null;
  const positions = command.map((value, index) => value === 'dispatch' ? index : -1).filter(index => index >= 0);
  if (positions.length !== 1) return null;
  const operationIndex = positions[0];
  if (operationIndex > 0) {
    const prefix = command.slice(0, operationIndex), script = baseName(prefix.at(-1));
    const cliScript = /^agent-bridge(?:\.js|\.cjs|\.cmd|\.ps1)?$/.test(script);
    const directCli = prefix.length === 1 && cliScript;
    const nodeCli = prefix.length === 2 && /^node(?:\.exe)?$/.test(baseName(prefix[0])) && cliScript;
    if (!directCli && !nodeCli) return null;
  }
  const args = command.slice(operationIndex + 1), ids = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--task-id') ids.push(args[index + 1]);
  }
  if (ids.length !== 1 || ids[0] !== taskId) return null;
  return { operation: 'dispatch', taskId };
}

function commandOperations(command, taskId, stateDir, depth = 0) {
  if (depth > 4) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return null;
  const segments = [];
  let segment = [];
  for (const token of tokens) {
    if ([';', '|', '||', '&&'].includes(token)) {
      if (!segment.length) return null;
      segments.push(segment); segment = [];
    } else segment.push(token);
  }
  if (!segment.length) return null;
  segments.push(segment);

  const operations = [];
  for (const original of segments) {
    const words = trimBlock(original);
    if (!words.length) return null;
    const executable = baseName(words[0]);
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
      const switches = words.map((word, index) => /^-(?:command|c)$/i.test(word) ? index : -1).filter(index => index >= 0);
      if (switches.length !== 1 || switches[0] === words.length - 1) return null;
      const nested = commandOperations(words.slice(switches[0] + 1).join(' '), taskId, stateDir, depth + 1);
      if (!nested) return null;
      operations.push(...nested);
      continue;
    }
    if (executable === 'cmd.exe' || executable === 'cmd') {
      const switches = words.map((word, index) => /^\/(?:c|k)$/i.test(word) ? index : -1).filter(index => index >= 0);
      if (switches.length !== 1 || switches[0] === words.length - 1) return null;
      const nested = commandOperations(words.slice(switches[0] + 1).join(' '), taskId, stateDir, depth + 1);
      if (!nested) return null;
      operations.push(...nested);
      continue;
    }
    const operation = directDispatch(original, taskId, stateDir);
    if (!operation) return null;
    operations.push(operation);
  }
  return operations;
}

function bindingHash(task) {
  const binding = {
    stateDir: path.resolve(task.stateDir),
    taskId: task.id,
    round: task.round,
    agent: task.agent,
    cwd: task.cwd ? path.resolve(task.cwd) : null,
    workerKey: task.workerKey ?? null,
    agentName: task.agentName ?? null,
    herdrSession: task.herdrSession ?? null,
    paneId: task.paneId ?? null,
    terminalId: task.terminalId ?? null,
    workerSessionId: task.workerSessionId ?? null,
  };
  return sha256(Buffer.from(JSON.stringify(binding), 'utf8'));
}

function rejectionError(task) {
  if (typeof task.error !== 'string') return null;
  let value;
  try { value = JSON.parse(task.error); } catch { return null; }
  if (!exactKeys(value, ['error', 'id']) || value.id !== 'cli:agent:prompt'
      || !exactKeys(value.error, ['code', 'message']) || value.error.code !== 'agent_not_ready'
      || ![...REJECTED_MESSAGES].some(makeMessage => value.error.message === makeMessage(task.paneId))) return null;
  return value;
}

function inspectRejection(task, { receiptFile } = {}) {
  try {
    if (!task || typeof task !== 'object' || !TASK_ID.test(task.id || '')
        || typeof task.stateDir !== 'string' || !path.isAbsolute(task.stateDir)
        || typeof receiptFile !== 'string' || !receiptFile.trim()) return unresolved('invalid_input');

    const taskDir = path.resolve(task.stateDir, 'tasks', task.id);
    const taskFile = path.join(taskDir, 'task.json');
    const taskBytes = fs.readFileSync(taskFile);
    const persistedTask = parseJson(taskBytes);
    if (!isDeepStrictEqual(task, persistedTask)) return unresolved('task_snapshot_changed');
    if (persistedTask.agent !== 'cbc' || persistedTask.status !== 'submission_unknown'
        || persistedTask.submission?.status !== 'uncertain' || persistedTask.watcherPid != null
        || !Number.isSafeInteger(persistedTask.round) || persistedTask.round < 1) return unresolved('task_not_eligible');

    const rawError = rejectionError(persistedTask);
    if (!rawError) return unresolved('rejection_error_mismatch');
    const history = persistedTask.history;
    if (!Array.isArray(history)) return unresolved('submission_history_missing');
    const submitted = history.map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.round === persistedTask.round && entry.status === 'submitted');
    const unknown = history.map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.round === persistedTask.round && entry.status === 'submission_unknown');
    if (submitted.length !== 1 || unknown.length !== 1 || submitted[0].index >= unknown[0].index
        || unknown[0].entry.message !== persistedTask.error) return unresolved('submission_history_ambiguous');
    if (history.slice(unknown[0].index + 1).some(entry => entry?.round === persistedTask.round
        && ['submitted', 'retry_submitted', 'submission_retried'].includes(entry.status))) {
      return unresolved('later_submission_history');
    }

    const eventsFile = path.join(persistedTask.stateDir, 'events.ndjson');
    const eventsBytes = fs.readFileSync(eventsFile);
    const events = eventsBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const currentEvents = events.map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.taskId === persistedTask.id && entry.round === persistedTask.round);
    const uncertainEvents = currentEvents.filter(({ entry }) => entry.type === 'submission_uncertain');
    if (uncertainEvents.length !== 1 || uncertainEvents[0].entry.message !== persistedTask.error
        || currentEvents.some(({ entry }) => entry.type === 'submitted')) {
      return unresolved('submission_events_ambiguous');
    }
    const uncertaintyIndex = uncertainEvents[0].index;
    if (currentEvents.some(({ entry, index }) => index > uncertaintyIndex
        && (entry.type === 'submission_uncertain' || entry.type === 'submission_rejected'
          || entry.type === 'submitted' || entry.type === 'retry_submitted'
          || entry.type === 'dispatch_failed' && entry.message !== persistedTask.error))) {
      return unresolved('later_submission_event');
    }

    const round = String(persistedTask.round).padStart(3, '0');
    const attempts = fs.readdirSync(taskDir).filter(name => name.startsWith(`round-${round}-submission-`)
      && name.endsWith('.json'));
    const submissionKeys = Object.keys(persistedTask.submission || {});
    const hasAttemptMetadata = submissionKeys.some(key => /attempt|journal/i.test(key))
      || Object.keys(persistedTask).some(key => /submissionAttempt/i.test(key));
    let source;
    let attempt;
    if (attempts.length === 0 && !hasAttemptMetadata) {
      source = 'legacy-rpc-crosscheck';
    } else {
      if (attempts.length !== 1 || !persistedTask.submission.attemptId || !persistedTask.submission.file) {
        return unresolved('submission_attempt_ambiguous');
      }
      const expectedAttemptFile = path.join(taskDir, `round-${round}-submission-${persistedTask.submission.attemptId}.json`);
      if (!samePath(persistedTask.submission.file, expectedAttemptFile)
          || !samePath(path.join(taskDir, attempts[0]), expectedAttemptFile)) return unresolved('submission_attempt_binding_mismatch');
      const attemptBytes = fs.readFileSync(expectedAttemptFile);
      attempt = parseJson(attemptBytes);
      if (attempt.protocol !== 1 || attempt.attemptId !== persistedTask.submission.attemptId
          || attempt.taskId !== persistedTask.id || attempt.round !== persistedTask.round
          || attempt.agent !== persistedTask.agent || attempt.herdrSession !== persistedTask.herdrSession
          || attempt.paneId !== persistedTask.paneId || attempt.terminalId !== persistedTask.terminalId
          || attempt.workerSessionId !== persistedTask.workerSessionId || attempt.status !== 'uncertain'
          || attempt.inputAccepted !== false || attempt.errorCode !== 'agent_not_ready') {
        return unresolved('submission_attempt_mismatch');
      }
      source = 'herdr-pre-input-rejection';
    }

    const expectedPromptFile = path.join(taskDir, `round-${round}-prompt.md`);
    if (typeof persistedTask.promptPath !== 'string' || !samePath(persistedTask.promptPath, expectedPromptFile)) {
      return unresolved('prompt_binding_mismatch');
    }
    const promptBytes = fs.readFileSync(expectedPromptFile);
    const promptSha256 = sha256(promptBytes);
    if (attempt && attempt.promptSha256 !== promptSha256) return unresolved('prompt_changed');

    const receiptBytes = fs.readFileSync(path.resolve(receiptFile));
    const receipt = parseJson(receiptBytes);
    if (!exactKeys(receipt, ['command', 'exit_code', 'stdout', 'stderr']) || typeof receipt.command !== 'string'
        || receipt.exit_code !== 1 || receipt.stdout !== '' || typeof receipt.stderr !== 'string') {
      return unresolved('receipt_mismatch');
    }
    if (/[`]/.test(receipt.command.replace(/`[ \t]*(?:\r\n|\n|\r)[ \t]*/g, ''))) {
      return unresolved('receipt_command_expansion');
    }
    const commands = commandOperations(receipt.command, persistedTask.id, persistedTask.stateDir);
    if (!commands || commands.length !== 1) return unresolved('receipt_command_mismatch');
    let stderr;
    try { stderr = JSON.parse(receipt.stderr); } catch { return unresolved('receipt_stderr_malformed'); }
    if (!exactKeys(stderr, ['error', 'code']) || stderr.error !== persistedTask.error
        || stderr.code !== 'HERDR_COMMAND_FAILED') return unresolved('receipt_error_mismatch');

    return {
      state: 'not_sent',
      source,
      taskId: persistedTask.id,
      round: persistedTask.round,
      code: 'agent_not_ready',
      operation: 'agent.prompt',
      bindingSha256: bindingHash(persistedTask),
      taskSha256: sha256(taskBytes),
      receiptSha256: sha256(receiptBytes),
      promptSha256,
      originalSubmissionPreserved: true,
      nativeWorkState: 'not_checked',
    };
  } catch {
    return unresolved('evidence_unreadable');
  }
}

module.exports = { inspectRejection };
