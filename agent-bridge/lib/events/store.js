'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('../util');

const EVENTS = { Stop: 'codex.stop.observed', PermissionRequest: 'codex.permission.requested', Interrupt: 'codex.turn.interrupted' };
const STATUS = { Stop: 'stop_observed', PermissionRequest: 'decision_requested', Interrupt: 'turn_interrupted' };
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function directoryKey(cwd) {
  const resolved = fs.realpathSync(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function loadConfig(file) {
  const raw = read(path.resolve(file));
  if (raw?.version !== 1 || !Array.isArray(raw.targets)) throw new Error('Expected events config version 1 and explicit targets');
  const targets = raw.targets.map(target => {
    if (!ID.test(target.id) || typeof target.sessionId !== 'string' || !ID.test(target.sessionId)
        || !path.isAbsolute(target.cwd) || !Array.isArray(target.principals) || !target.principals.length
        || target.principals.some(p => !ID.test(p))) throw new Error('Invalid events target');
    return { ...target, directoryKey: directoryKey(target.cwd) };
  });
  if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error('Duplicate target IDs');
  if (!path.isAbsolute(raw.stateDir)) throw new Error('Events stateDir must be absolute');
  if (raw.maxEvents !== undefined && (!Number.isInteger(raw.maxEvents) || raw.maxEvents < 1 || raw.maxEvents > 10000)) throw new Error('Invalid buffer capacity');
  return { stateDir: path.resolve(raw.stateDir), targets, maxEvents: raw.maxEvents || 2000 };
}

class Store {
  constructor(root) {
    this.root = path.resolve(root);
    for (const kind of ['events', 'subscriptions', 'deliveries']) fs.mkdirSync(path.join(this.root, kind), { recursive: true, mode: 0o700 });
  }
  file(kind, id) {
    if (!['events', 'subscriptions', 'deliveries'].includes(kind) || !ID.test(id)) throw new Error('Invalid record key');
    return path.join(this.root, kind, `${id}.json`);
  }
  get(kind, id) { return read(this.file(kind, id), null); }
  put(kind, id, value) { writeJsonAtomic(this.file(kind, id), kind === 'deliveries' ? { ...value, recordKey: id } : value); }
  list(kind) {
    return fs.readdirSync(path.join(this.root, kind)).filter(f => f.endsWith('.json')).sort()
      .map(f => this.get(kind, f.slice(0, -5)));
  }
  insertEvent(event) {
    const destination = this.file('events', event.eventId), temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
    try {
      // A hard link publishes a complete record atomically without overwriting duplicates. / 硬链接原子发布完整记录，不覆盖重复事件。
      fs.linkSync(temp, destination); return true;
    } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    finally { fs.unlinkSync(temp); }
  }
}

function capture(config, input, { clock = Date.now, store = new Store(config.stateDir) } = {}) {
  if (!input || !Object.hasOwn(EVENTS, input.hook_event_name) || !ID.test(input.session_id || '') || !ID.test(input.turn_id || '')) return { filtered: true };
  let cwd;
  try { cwd = directoryKey(input.cwd); } catch { return { filtered: true }; }
  const target = config.targets.find(t => t.sessionId === input.session_id && t.directoryKey === cwd);
  if (!target) return { filtered: true };
  const permission = input.hook_event_name === 'PermissionRequest';
  const stopped = input.hook_event_name === 'Stop';
  const discriminator = permission ? digest(canonical([input.tool_name, input.tool_use_id || null, input.tool_input || null]))
    : stopped ? digest(canonical([Boolean(input.stop_hook_active), input.last_assistant_message || null])) : '';
  const event = { eventId: `evt_${digest(canonical([target.id, input.session_id, input.turn_id, input.hook_event_name, discriminator]))}`,
    name: EVENTS[input.hook_event_name], timestamp: new Date(clock()).toISOString(),
    data: { target_id: target.id, turn_id: input.turn_id, hook_event: input.hook_event_name,
      status: STATUS[input.hook_event_name], ...(stopped ? { stop_hook_active: Boolean(input.stop_hook_active) } : {}), ...(permission ? { request_id: discriminator,
        tool_name: /^[a-zA-Z0-9_.:-]{1,128}$/.test(input.tool_name || '') ? input.tool_name : 'other' } : {}) }, cursor: null };
  if (store.get('events', event.eventId)) return { eventId: event.eventId, inserted: false };
  if (fs.readdirSync(path.join(store.root, 'events')).filter(f => f.endsWith('.json')).length >= (config.maxEvents || 2000)) {
    writeJsonAtomic(path.join(store.root, 'capture-health.json'), { status: 'buffer_full', at: new Date(clock()).toISOString() });
    return { dropped: 'buffer_full' };
  }
  return { eventId: event.eventId, inserted: store.insertEvent(event) };
}

module.exports = { Store, loadConfig, capture, canonical, digest, EVENTS, ID };
