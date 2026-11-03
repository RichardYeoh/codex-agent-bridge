'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Store, canonical, digest, EVENTS } = require('./store');
const { callbackUrl, signingKey, headers, equal, createTransport } = require('./webhook');

class RpcError extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.reason = reason; }
}
class EventService {
  constructor(config, { store = new Store(config.stateDir), transport = createTransport(), clock = Date.now,
    maxAttempts = 5, retentionMs = 7 * 86400000, maxSubscriptions = 100 } = {}) {
    Object.assign(this, { config, store, transport, clock, maxAttempts, retentionMs, maxSubscriptions });
    this.verifications = new Map(); this.draining = false;
  }
  allowed(principal, target) { return this.config.targets.some(t => t.id === target && t.principals.includes(principal)); }
  validate(principal, params, { secret = false } = {}) {
    const args = params?.arguments;
    if (!Object.values(EVENTS).includes(params?.name) || !args || Object.keys(args).length !== 1
        || !this.allowed(principal, args.target_id)) throw new RpcError(-32602, 'Unknown or unauthorized event filter');
    if (params.delivery?.mode !== 'webhook') throw new RpcError(-32602, 'Webhook delivery required');
    let url;
    try { url = callbackUrl(params.delivery.url).href; if (secret) signingKey(params.delivery.secret); }
    catch { throw new RpcError(-32602, 'Invalid webhook destination or signing key'); }
    return { url, id: `sub_${digest(canonical([principal, url, params.name, args]))}` };
  }
  list(principal) {
    const targets = this.config.targets.filter(t => t.principals.includes(principal)).map(t => t.id);
    if (!targets.length) return { events: [] };
    return { events: Object.entries(EVENTS).map(([hook, name]) => ({ name,
      description: `${hook} observation from an authorized Codex target; data only, never approval or project acceptance.`,
      delivery: ['webhook'], inputSchema: { type: 'object', properties: { target_id: { type: 'string', enum: targets } }, required: ['target_id'], additionalProperties: false },
      payloadSchema: { type: 'object', properties: { target_id: { type: 'string' }, turn_id: { type: 'string' },
        hook_event: { const: hook }, status: { type: 'string' }, stop_hook_active: { type: 'boolean' }, request_id: { type: 'string' }, tool_name: { type: 'string' } },
      required: ['target_id', 'turn_id', 'hook_event', 'status'], additionalProperties: false },
    })) };
  }
  async verify(principal, subscription) {
    const cacheKey = digest(canonical([principal, subscription.url, subscription.secret]));
    if ((this.verifications.get(cacheKey) || 0) > this.clock()) return;
    const challenge = crypto.randomBytes(32).toString('base64url'), id = `verify_${crypto.randomUUID()}`;
    const body = JSON.stringify({ type: 'verification', challenge });
    let result;
    try { result = await this.transport(subscription.url, headers(subscription, id, body, this.clock), body); }
    catch { throw new RpcError(-32015, 'callback_unreachable_or_denied'); }
    let echoed;
    try { echoed = JSON.parse(result.body).challenge; } catch {}
    if (result.status < 200 || result.status >= 300 || !equal(echoed, challenge)) throw new RpcError(-32015, 'challenge_failed');
    this.verifications.set(cacheKey, this.clock() + 300000);
    for (const [key, expiry] of this.verifications) if (expiry <= this.clock()) this.verifications.delete(key);
    if (this.verifications.size > 1000) this.verifications.delete(this.verifications.keys().next().value);
  }
  async subscribe(principal, params) {
    const { id, url } = this.validate(principal, params, { secret: true });
    const ttl = params.ttlMs === undefined || params.ttlMs === null ? 3600000 : params.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1000) throw new RpcError(-32602, 'Invalid ttlMs');
    const previous = this.store.get('subscriptions', id), generation = (previous?.generation || 0) + 1;
    if (!previous && this.store.list('subscriptions').length >= this.maxSubscriptions) throw new RpcError(-32000, 'Subscription capacity reached');
    const candidate = { id, principal, name: params.name, arguments: params.arguments, url, secret: params.delivery.secret,
      createdAt: previous?.state === 'active' && previous.expiresAt > this.clock() ? previous.createdAt : this.clock(),
      expiresAt: this.clock() + Math.min(ttl, 86400000), generation, state: 'verifying' };
    // Persist the verification generation so unsubscribe cannot be undone by a late challenge response. / 记录验证代次，避免迟到的挑战响应撤销退订。
    this.store.put('subscriptions', id, { ...(previous || candidate), generation, state: 'verifying' });
    try { await this.verify(principal, candidate); }
    catch (error) {
      if (this.store.get('subscriptions', id)?.generation === generation) this.store.put('subscriptions', id,
        previous || { id, generation, principal, state: 'verification_failed', closedAt: this.clock() });
      throw error;
    }
    const latest = this.store.get('subscriptions', id);
    if (latest?.generation !== generation || latest.state !== 'verifying') throw new RpcError(-32015, 'subscription_changed_during_verification');
    if (previous?.secret && previous.secret !== candidate.secret && previous.state === 'active') {
      candidate.previousSecret = previous.secret; candidate.rotateUntil = this.clock() + 300000;
    }
    candidate.state = 'active'; this.store.put('subscriptions', id, candidate);
    return { id, refreshBefore: new Date(candidate.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(principal, params) {
    const { id } = this.validate(principal, params);
    const previous = this.store.get('subscriptions', id);
    if (previous) this.store.put('subscriptions', id, { id, principal, generation: previous.generation + 1, state: 'unsubscribed', closedAt: this.clock() });
    return {};
  }
  status(principal) {
    const visible = this.store.list('subscriptions').filter(s => s.principal === principal);
    return { subscriptions: visible.map(s => ({ id: s.id, state: s.state, expiresAt: s.expiresAt || null })),
      note: 'Webhook receipt does not prove YDot processing or project completion.' };
  }
  async drain({ limit = 10 } = {}) {
    if (this.draining) return { busy: true };
    this.draining = true;
    let delivered = 0, attempted = 0;
    try {
      const events = this.store.list('events').sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (const event of events) {
        if (this.clock() - Date.parse(event.timestamp) > this.retentionMs) {
          // Only remove validated record filenames owned by this spool. / 只清理本缓冲区拥有且通过键校验的记录文件。
          fs.unlinkSync(this.store.file('events', event.eventId));
        }
      }
      for (const job of this.store.list('deliveries')) {
        if (job.recordKey && (job.lastAttemptAt || job.dueAt || 0) < this.clock() - this.retentionMs) {
          fs.unlinkSync(this.store.file('deliveries', job.recordKey));
        }
      }
      for (const initial of this.store.list('subscriptions')) {
        if (!['active', 'verifying'].includes(initial.state) && initial.closedAt < this.clock() - this.retentionMs) {
          fs.unlinkSync(this.store.file('subscriptions', initial.id)); continue;
        }
        if (initial.state === 'active' && (initial.expiresAt <= this.clock() || !this.allowed(initial.principal, initial.arguments.target_id))) {
          this.store.put('subscriptions', initial.id, { id: initial.id, principal: initial.principal, generation: initial.generation + 1,
            state: initial.expiresAt <= this.clock() ? 'expired' : 'access_revoked', closedAt: this.clock() });
          continue;
        }
        for (const event of events) {
          if (attempted >= limit) return { delivered, attempted };
          const sub = this.store.get('subscriptions', initial.id), at = this.clock();
          if (sub?.state !== 'active' || sub.expiresAt <= at || !this.allowed(sub.principal, sub.arguments.target_id)) {
            if (sub?.state === 'active') this.store.put('subscriptions', sub.id, { id: sub.id, principal: sub.principal,
              generation: sub.generation + 1, state: sub.expiresAt <= at ? 'expired' : 'access_revoked', closedAt: at });
            break;
          }
          if (sub.name !== event.name || sub.arguments.target_id !== event.data.target_id || Date.parse(event.timestamp) < sub.createdAt) continue;
          if (at - Date.parse(event.timestamp) > this.retentionMs) continue;
          const key = `job_${digest(`${sub.id}\n${event.eventId}`)}`, job = this.store.get('deliveries', key) || { attempts: 0, state: 'pending', dueAt: 0 };
          if (job.state !== 'pending' || job.dueAt > at) continue;
          if (at - Date.parse(event.timestamp) > this.retentionMs || job.attempts >= this.maxAttempts) {
            this.store.put('deliveries', key, { ...job, state: 'expired_or_exhausted' }); continue;
          }
          const body = JSON.stringify(event);
          if (Buffer.byteLength(body) > 262144) { this.store.put('deliveries', key, { ...job, state: 'payload_too_large' }); continue; }
          // Persist an attempt before I/O; retries keep eventId, and an in-flight delivery cannot be retracted. / I/O前记录尝试，重试保留事件ID，已在途投递不能撤回。
          job.attempts++; job.dueAt = at + Math.min(1000 * 2 ** (job.attempts - 1), 30000);
          this.store.put('deliveries', key, job); attempted++;
          let response;
          try { response = await this.transport(sub.url, headers(sub, event.eventId, body, this.clock), body); }
          catch { response = { status: 0 }; }
          job.lastStatus = response.status; job.lastAttemptAt = at;
          if (response.status >= 200 && response.status < 300) { job.state = 'accepted'; delivered++; }
          else if (response.status && response.status !== 408 && response.status !== 429 && response.status < 500) job.state = 'rejected';
          else if (job.attempts >= this.maxAttempts) job.state = 'exhausted';
          this.store.put('deliveries', key, job);
          if (response.status === 410 && this.store.get('subscriptions', sub.id)?.generation === sub.generation) {
            this.store.put('subscriptions', sub.id, { id: sub.id, principal: sub.principal, generation: sub.generation + 1, state: 'receiver_gone', closedAt: at });
          }
        }
      }
      return { delivered, attempted };
    } finally { this.draining = false; }
  }
}

module.exports = { EventService, RpcError };
