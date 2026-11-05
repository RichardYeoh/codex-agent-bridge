'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic, withLock } = require('./util');

const SCHEMA = 'bridge-task-v2';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const SOURCES = {
  'evidence.hook': 'adapter',
  'transport.sending': 'transport', 'transport.written': 'transport',
  'transport.unknown': 'transport', 'transport.rejected': 'transport',
  'native.admitted': 'adapter', 'native.stopped': 'adapter', 'native.blocked': 'adapter',
  'native.progress': 'adapter',
  'native.foreign_input': 'adapter', 'observer.unavailable': 'observer', 'observer.healthy': 'observer',
  'resource.busy': 'adapter', 'resource.released': 'adapter',
  'worker.result': 'worker', 'review.accepted': 'controller', 'review.rework': 'controller',
  'control.cancel_requested': 'controller', 'control.closed': 'controller',
  'control.abandoned': 'controller',
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(ok, message) { if (!ok) fail('PROTOCOL_INVALID', message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function stamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function digest(value) { return sha(JSON.stringify(value)); }

function validateRequest(r) {
  check(plain(r) && r.schema === SCHEMA, 'Unsupported request schema');
  check(/^[a-z][a-z0-9-]{2,47}$/.test(r.taskId), 'Invalid task ID');
  check(ID.test(r.requestId) && Number.isSafeInteger(r.round) && r.round > 0, 'Invalid round/request');
  check(SHA.test(r.specSha256) && SHA.test(r.promptSha256) && SHA.test(r.pointerSha256), 'Missing request digests');
  check(stamp(r.createdAt) && path.isAbsolute(r.cwd) && path.isAbsolute(r.stateDir), 'Invalid request location/time');
  check(plain(r.binding), 'Missing request binding');
  for (const key of ['agent', 'sessionId', 'herdrSession', 'paneId', 'terminalId', 'workerStartedAt']) {
    check(typeof r.binding[key] === 'string' && r.binding[key].length > 0, `Missing binding ${key}`);
  }
  check(Array.isArray(r.allowedArtifacts) && r.allowedArtifacts.every(x => typeof x === 'string' && x.length), 'Invalid artifact scopes');
  if (r.predecessor) check(plain(r.predecessor) && r.predecessor.taskId === r.taskId
    && Number.isSafeInteger(r.predecessor.round) && r.predecessor.round > 0 && r.predecessor.round < r.round
    && ID.test(r.predecessor.requestId) && SHA.test(r.predecessor.requestSha256)
    && (r.predecessor.resultSha256 === null || SHA.test(r.predecessor.resultSha256)), 'Invalid predecessor request');
  return r;
}

function requestDirectory(r) {
  validateRequest(r);
  return path.join(r.stateDir, 'tasks', r.taskId,
    `round-${String(r.round).padStart(3, '0')}-request-${r.requestId}`);
}

// Resolve real ancestors before taking locks; aliases must share one owner. / 加锁前解析真实父目录，别名必须共享所有者。
function safeDirectory(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true });
  const absolute = path.resolve(dir);
  const real = fs.realpathSync.native(absolute);
  let cursor = absolute;
  while (path.dirname(cursor) !== cursor) {
    check(!fs.lstatSync(cursor).isSymbolicLink(), 'Protocol directory contains a link/reparse alias');
    cursor = path.dirname(cursor);
  }
  return real;
}

function readRegular(file, max = 8 * 1024 * 1024) {
  const st = fs.lstatSync(file);
  check(st.isFile() && !st.isSymbolicLink() && st.size <= max, 'Unsafe or oversized protocol file');
  return fs.readFileSync(file);
}

function load(r) {
  const dir = safeDirectory(requestDirectory(r));
  const saved = JSON.parse(readRegular(path.join(dir, 'request.json')));
  check(digest(saved) === digest(r), 'Immutable request identity changed');
  const data = JSON.parse(readRegular(path.join(dir, 'events.json')));
  check(data.schema === SCHEMA && data.requestSha256 === digest(r) && Array.isArray(data.events), 'Invalid event store');
  data.events.forEach(e => validateEvent(r, e));
  check(new Set(data.events.map(e => e.source + ':' + e.eventId)).size === data.events.length, 'Duplicate event identity in persisted store');
  check(data.eventsSha256 === digest(data.events), 'Event store digest mismatch');
  return data;
}

async function locked(r, fn) {
  const dir = safeDirectory(requestDirectory(r), true);
  const key = 'request-' + sha(process.platform === 'win32' ? dir.toLowerCase() : dir).slice(0, 40);
  return withLock(key, fn, 15000);
}

async function create(r) {
  validateRequest(r);
  return locked(r, () => {
    const dir = requestDirectory(r), file = path.join(dir, 'request.json');
    if (fs.existsSync(file)) {
      check(digest(JSON.parse(readRegular(file))) === digest(r), 'Request ID already belongs to another request');
    } else writeJsonAtomic(file, r);
    const events = path.join(dir, 'events.json');
    // A crash between request and journal creation is safe: no transport has started. / 请求与日志创建之间崩溃可恢复，此时尚未开始传输。
    const ready = path.join(dir, 'initialized.json');
    if (!fs.existsSync(events)) {
      check(!fs.existsSync(ready), 'Initialized request lost its event journal; diagnose, never recreate an empty history');
      writeJsonAtomic(events, { schema: SCHEMA, requestSha256: digest(r), events: [], eventsSha256: digest([]) });
    }
    load(r);
    if (!fs.existsSync(ready)) writeJsonAtomic(ready, { requestSha256: digest(r) });
    return inspect(r);
  });
}

function validateEvent(r, e) {
  check(plain(e) && e.schema === SCHEMA && ID.test(e.eventId), 'Invalid event envelope');
  check(e.taskId === r.taskId && e.round === r.round && e.requestId === r.requestId
    && e.replyTo === r.requestId, 'Event belongs to another request');
  check(Object.hasOwn(SOURCES, e.kind) && SOURCES[e.kind] === e.source, 'Event source cannot make this assertion');
  check(stamp(e.createdAt) && plain(e.payload), 'Invalid event payload/time');
  const p = e.payload;
  check(Buffer.byteLength(JSON.stringify(e)) <= 65536, 'Event is oversized');
  if (e.kind.startsWith('native.')) {
    check(p.sessionId === r.binding.sessionId && p.terminalId === r.binding.terminalId
      && p.paneId === r.binding.paneId, 'Native event binding mismatch');
    check(stamp(p.at) && Date.parse(p.at) >= Date.parse(r.createdAt), 'Native event predates request');
    if (e.kind === 'native.admitted') check(p.pointerSha256 === r.pointerSha256 && SHA.test(p.evidenceSha256), 'Admission proof mismatch');
    if (e.kind === 'native.stopped') check(SHA.test(p.evidenceSha256), 'Stop requires native evidence digest');
  }
  if (e.kind === 'evidence.hook') check(['UserPromptSubmit', 'Stop', 'Notification', 'PreToolUse', 'PostToolUse'].includes(p.name)
    && p.sessionId === r.binding.sessionId && p.paneId === r.binding.paneId && p.terminalId === r.binding.terminalId
    && stamp(p.at) && Date.parse(p.at) >= Date.parse(r.createdAt)
    && (p.name !== 'UserPromptSubmit' || SHA.test(p.promptSha256)), 'Invalid raw Hook evidence');
  if (e.kind === 'worker.result') {
    check(['delivered', 'failed'].includes(p.outcome) && SHA.test(p.manifestSha256) && stamp(p.at), 'Invalid result claim');
    check(typeof p.reason === 'string' && p.reason.length <= 2048, 'Result requires a bounded reason');
  }
  if (e.kind === 'transport.rejected') check(p.inputWritten === false, 'Rejection must prove no input');
  if (e.kind === 'resource.released') check(['exact-native-terminal', 'bound-worker-absent'].includes(p.proofType)
    && SHA.test(p.evidenceSha256) && p.sessionId === r.binding.sessionId && stamp(p.at), 'Resource release requires exact native or process evidence');
  if (e.kind === 'review.accepted' || e.kind === 'review.rework') check(SHA.test(p.resultSha256), 'Review must bind a frozen result');
  if (e.kind.startsWith('control.')) {
    check(typeof p.actor === 'string' && p.actor.length > 0 && typeof p.reason === 'string' && p.reason.length > 0, 'Control action requires actor and reason');
    if (e.kind === 'control.closed') check(['request-ended', 'not-sent', 'bound-worker-absent'].includes(p.proofType)
      && SHA.test(p.evidenceSha256), 'Coordination close requires a supported proof');
    if (e.kind === 'control.abandoned') check(SHA.test(p.evidenceSha256), 'Abandonment requires retained operator evidence');
  }
}

function event(r, kind, payload, id) {
  const e = { schema: SCHEMA, eventId: id || crypto.randomUUID(), source: SOURCES[kind],
    taskId: r.taskId, round: r.round, requestId: r.requestId, replyTo: r.requestId,
    kind, payload, createdAt: new Date().toISOString() };
  validateEvent(r, e); return e;
}

// Compute facts, not the last chat message; arrival order cannot erase a result. / 按事实计算状态，不依据最后聊天消息；到达顺序不能抹除结果。
function reduce(r, events) {
  validateRequest(r); events.forEach(e => validateEvent(r, e));
  const by = kind => events.filter(e => e.kind === kind);
  const last = kind => by(kind).at(-1);
  const conflicts = [];
  const unique = (kind, select) => {
    const values = [...new Set(by(kind).map(select))];
    if (values.length > 1) conflicts.push(kind);
    return last(kind);
  };
  const admission = unique('native.admitted', e => e.payload.evidenceSha256);
  const stop = unique('native.stopped', e => e.payload.at + ':' + e.payload.evidenceSha256);
  const result = unique('worker.result', e => e.payload.manifestSha256 + ':' + e.payload.outcome);
  const rejected = last('transport.rejected');
  if (rejected && (admission || stop)) conflicts.push('rejected-but-executed');
  if (rejected && last('transport.written')) conflicts.push('rejected-but-written');
  if (stop && admission && Date.parse(stop.payload.at) < Date.parse(admission.payload.at)) conflicts.push('stop-before-admission');
  if (result && admission && Date.parse(result.payload.at) < Date.parse(admission.payload.at)) conflicts.push('result-before-admission');
  if (result && stop && Date.parse(result.payload.at) > Date.parse(stop.payload.at)) conflicts.push('result-after-stop');
  const foreignBeforeStop = admission && by('native.foreign_input').some(e => Date.parse(e.payload.at) >= Date.parse(admission.payload.at)
    && (!stop || Date.parse(e.payload.at) <= Date.parse(stop.payload.at)));
  if (foreignBeforeStop) conflicts.push('foreign-input-during-request');
  const ready = Boolean(admission && stop && result && !conflicts.length);
  const resultSha256 = admission && stop && result ? digest({ requestSha256: digest(r), admission: admission.payload,
    stop: stop.payload, result: result.payload }) : null;
  const accepted = last('review.accepted'), rework = last('review.rework');
  if (accepted && rework) conflicts.push('conflicting-review');
  for (const item of [accepted, rework].filter(Boolean)) {
    if (!ready || item.payload.resultSha256 !== resultSha256) conflicts.push('review-evidence-mismatch');
  }
  const freshest = items => items.reduce((a, b) => !a || Date.parse(b.payload.at || b.createdAt) >= Date.parse(a.payload.at || a.createdAt) ? b : a, null);
  const observer = freshest(events.filter(e => e.kind.startsWith('observer.')));
  const resource = freshest(events.filter(e => e.kind.startsWith('resource.')));
  const resourceRevoked = resource?.kind === 'resource.released' && resource.payload.proofType === 'bound-worker-absent'
    && events.some(e => ['native.admitted', 'native.progress', 'native.blocked', 'native.foreign_input'].includes(e.kind)
      && Date.parse(e.payload.at) > Date.parse(resource.payload.at));
  if (resourceRevoked) conflicts.push('activity-after-resource-release');
  const block = freshest(by('native.blocked'));
  const progress = freshest(by('native.progress'));
  const blocked = block && admission && Date.parse(block.payload.at) >= Date.parse(admission.payload.at)
    && (!progress || Date.parse(progress.payload.at) <= Date.parse(block.payload.at));
  const closed = last('control.closed'), cancelRequested = last('control.cancel_requested');
  if (closed) {
    const proof = closed.payload;
    const endedProof = stop && !foreignBeforeStop && proof.proofType === 'request-ended' && proof.evidenceSha256 === stop.payload.evidenceSha256;
    const notSentProof = proof.proofType === 'not-sent' && !admission && (rejected || !last('transport.sending'))
      && proof.evidenceSha256 === digest(rejected?.payload || { prepared: r.requestId });
    const absentProof = proof.proofType === 'bound-worker-absent' && resource?.kind === 'resource.released'
      && resource.payload.proofType === proof.proofType && resource.payload.evidenceSha256 === proof.evidenceSha256;
    if (!(endedProof || notSentProof || absentProof)) conflicts.push('unproved-coordination-close');
  }
  return {
    schema: SCHEMA, requestId: r.requestId, taskId: r.taskId, round: r.round,
    transport: admission ? 'admitted' : rejected ? 'rejected' : last('transport.unknown') ? 'unknown'
      : last('transport.written') ? 'written' : last('transport.sending') ? 'sending' : 'prepared',
    execution: admission && stop && !foreignBeforeStop ? 'ended' : foreignBeforeStop ? 'unknown'
      : blocked ? 'blocked' : admission ? 'running' : rejected ? 'not_started'
        : last('transport.sending') || last('transport.written') || last('transport.unknown') ? 'unknown' : 'not_started',
    observation: conflicts.length ? 'conflict' : observer?.kind === 'observer.unavailable' ? 'unavailable' : 'healthy',
    review: accepted ? 'accepted' : rework ? 'changes_requested' : conflicts.length ? 'not_ready' : ready ? 'pending' : 'not_ready',
    reviewIntegrity: conflicts.length && (accepted || rework) ? 'contested' : 'consistent',
    resource: resourceRevoked ? 'conflict' : resource?.kind === 'resource.released' ? 'released' : resource?.kind === 'resource.busy' ? 'held' : 'unknown',
    control: last('control.abandoned') ? 'abandoned' : closed ? 'closed' : cancelRequested ? 'cancel_requested' : 'open',
    outcome: ready ? result.payload.outcome : null, resultSha256, conflicts,
    waitingFor: conflicts.length ? ['reconcile-conflict'] : !admission ? ['native-admission'] : !stop ? ['native-stop'] : !result ? ['worker-result'] : [],
    eventCount: events.length,
  };
}

async function append(r, e) {
  validateRequest(r); validateEvent(r, e);
  return locked(r, () => {
    const data = load(r);
    const prior = data.events.find(x => x.source === e.source && x.eventId === e.eventId);
    if (prior) {
      // Transport retries may have a different receive time, but not a different meaning. / 重投接收时间可变，事件内容不可改变。
      const content = x => ({ ...x, createdAt: null });
      if (digest(content(prior)) !== digest(content(e))) fail('PROTOCOL_ID_CONFLICT', 'Event ID reused with different content');
      return reduce(r, data.events);
    }
    check(data.events.length < 4096, 'Request event limit reached; retain evidence and diagnose');
    const next = [...data.events, e];
    const state = reduce(r, next);
    // A local review action never turns an unresolved assertion into acceptance. / 本地主审动作不能将未决声明变成验收通过。
    if (e.kind.startsWith('review.')) check(!state.conflicts.length && state.resultSha256 && state.control === 'open', 'Review evidence is not ready');
    if (e.kind === 'control.closed') check(!state.conflicts.includes('unproved-coordination-close'), 'Coordination close proof is not ready');
    const record = { ...data, events: next, eventsSha256: digest(next) };
    check(Buffer.byteLength(JSON.stringify(record, null, 2) + '\n') <= 8 * 1024 * 1024, 'Request journal byte limit reached; retain evidence and diagnose');
    writeJsonAtomic(path.join(requestDirectory(r), 'events.json'), record);
    return state;
  });
}

function inspect(r) { return reduce(r, load(r).events); }

module.exports = { SCHEMA, SOURCES, sha, digest, validateRequest, validateEvent, requestDirectory,
  safeDirectory, readRegular, create, load, inspect, event, append, reduce };
