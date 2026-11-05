'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');

function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Invalid webhook signing key');
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== secret.slice(6).replace(/=+$/, '')) throw new Error('Invalid webhook signing key');
  return key;
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function headers(subscription, id, body, clock = Date.now) {
  const timestamp = String(Math.floor(clock() / 1000));
  const keys = [subscription.secret, ...(subscription.previousSecret && subscription.rotateUntil > clock() ? [subscription.previousSecret] : [])];
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': keys.map(secret => `v1,${crypto.createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`).join(' '),
    'X-MCP-Subscription-Id': subscription.id };
}

function callbackUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port && u.port !== '443'
      || u.hostname.endsWith('.') || u.hostname.length > 253 || u.href.length > 2048) throw new Error('Invalid HTTPS callback');
  return u;
}
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2)
      || a === 192 && b === 88 && c === 99 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (net.isIP(address) === 6) {
    // Accept global-unicast only; reject mapped IPv4, local, multicast, and transition/documentation ranges. / 仅接受全球单播，拒绝映射IPv4、本地、多播、转换及文档地址。
    const x = address.toLowerCase(), parts = x.split(':'), first = parseInt(parts[0], 16), second = parseInt(parts[1] || '0', 16);
    return /^[23][0-9a-f]{3}:/.test(x) && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
      && first !== 0x2002 && first !== 0x3ffe && first !== 0x3fff;
  }
  return false;
}

function createTransport({ resolve = (hostname, options) => dns.lookup(hostname, options), request = https.request,
  timeoutMs = 2500, maxResponseBytes = 16384 } = {}) {
  return async (destination, signedHeaders, body) => {
    const url = callbackUrl(destination), hostname = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer, records;
    try { records = await Promise.race([resolve(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('Callback DNS timeout')), timeoutMs); })]); }
    finally { clearTimeout(dnsTimer); }
    if (!records.length || records.some(record => !publicAddress(record.address))) throw new Error('Callback address denied');
    const pinned = records[0];
    return new Promise((resolveResponse, reject) => {
      // Pin each request to validated DNS while preserving hostname/TLS verification; never follow redirects. / 每次请求固定到已验证DNS，保留主机名与TLS校验，禁止重定向。
      const req = request(url, { method: 'POST', headers: { ...signedHeaders, 'content-length': Buffer.byteLength(body) },
        agent: false, family: pinned.family, autoSelectFamily: false,
        lookup: (_host, options, callback) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      }, response => {
        let size = 0; const chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > maxResponseBytes) { response.destroy(); reject(new Error('Callback response too large')); } else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      const timer = setTimeout(() => req.destroy(new Error('Callback request timeout')), timeoutMs);
      req.once('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body);
    });
  };
}

module.exports = { signingKey, equal, headers, callbackUrl, publicAddress, createTransport };
