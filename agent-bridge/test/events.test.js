'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { Store, loadConfig, capture } = require('../lib/events/store');
const { EventService } = require('../lib/events/service');
const { headers, publicAddress, callbackUrl, createTransport } = require('../lib/events/webhook');
const { createServer } = require('../lib/events/server');
const hooks = require('../lib/events/hook-config');
const roots = [];
const secret = `whsec_${Buffer.alloc(32, 17).toString('base64')}`;
test.after(() => { for (const root of roots) { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-events-')); roots.push(root);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, stateDir: path.join(root, 'state'), targets: [
    { id: 'owner', sessionId: 'session-one', cwd: root, principals: ['ydot'] }] }));
  const config = loadConfig(file), store = new Store(config.stateDir);
  let now = 1700000000000; const calls = [], outcomes = [];
  const transport = async (url, h, body) => {
    const data = JSON.parse(body); calls.push({ url, h, body, data });
    const expected = crypto.createHmac('sha256', Buffer.alloc(32, 17)).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${body}`).digest('base64');
    if (h['webhook-signature'].split(' ')[0] === `v1,${expected}`) assert.ok(true);
    else if (!outcomes.includes('rotation')) assert.fail('Invalid Standard Webhooks signature');
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    const next = outcomes.shift(); if (next === 'offline') throw new Error('offline');
    return { status: typeof next === 'number' ? next : 204, body: '' };
  };
  const options = { store, transport, clock: () => now };
  const service = new EventService(config, options);
  const params = { name: 'codex.stop.observed', arguments: { target_id: 'owner' },
    delivery: { mode: 'webhook', url: 'https://callback.example.invalid/events', secret } };
  const input = { hook_event_name: 'Stop', cwd: root, session_id: 'session-one', turn_id: 'turn-one',
    last_assistant_message: 'PRIVATE FULL CODE AND SECRETS', transcript_path: 'PRIVATE HISTORY' };
  return { root, file, config, store, calls, outcomes, options, service, params, input,
    clock: () => now, advance: ms => { now += ms; } };
}

test('completion passes signed challenge and persistent outbox, duplicates remain one event/one delivery after restart', async () => {
  const f = fixture();
  const sub = await f.service.subscribe('ydot', f.params);
  assert.ok(sub.id.startsWith('sub_')); assert.equal(sub.cursor, null);
  assert.equal(capture(f.config, f.input, { clock: f.clock }).inserted, true);
  assert.equal(capture(f.config, { ...f.input, transcript_path: 'changed' }, { clock: f.clock }).inserted, false);
  assert.equal((await f.service.drain()).delivered, 1);
  assert.equal((await new EventService(f.config, f.options).drain()).attempted, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].data.data.status, 'stop_observed');
  assert.equal(f.calls[1].h['webhook-id'], f.calls[1].data.eventId);
  assert.equal(f.calls[1].h['X-MCP-Subscription-Id'], sub.id);
  assert.equal(JSON.stringify(f.store.list('events')).includes('PRIVATE'), false);
});

test('wrong session/directory and unauthorized subscriptions are filtered before callback', async () => {
  const f = fixture(), other = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-events-other-')); roots.push(other);
  assert.equal(capture(f.config, { ...f.input, session_id: 'wrong' }).filtered, true);
  assert.equal(capture(f.config, { ...f.input, cwd: other }).filtered, true);
  await assert.rejects(f.service.subscribe('other', f.params), { code: -32602 });
  assert.equal(f.store.list('events').length, 0); assert.equal(f.calls.length, 0);
});

test('offline/500 responses retry finitely with stable ID and fresh signature, accepted records do not resend', async () => {
  const f = fixture(); await f.service.subscribe('ydot', f.params);
  capture(f.config, f.input, { clock: f.clock }); f.outcomes.push('offline', 500, 204);
  await f.service.drain(); assert.equal((await f.service.drain()).attempted, 0);
  f.advance(1000); await new EventService(f.config, f.options).drain();
  f.advance(2000); assert.equal((await f.service.drain()).delivered, 1);
  const events = f.calls.filter(c => !c.data.type);
  assert.equal(new Set(events.map(c => c.h['webhook-id'])).size, 1);
  assert.equal(new Set(events.map(c => c.h['webhook-signature'])).size, 3);
  assert.equal((await f.service.drain()).attempted, 0);
  const exhausted = fixture(); await exhausted.service.subscribe('ydot', exhausted.params);
  capture(exhausted.config, exhausted.input, { clock: exhausted.clock }); exhausted.outcomes.push(...Array(6).fill('offline'));
  for (let i = 0; i < 7; i++) { await exhausted.service.drain(); exhausted.advance(60000); }
  assert.equal(exhausted.calls.filter(c => !c.data.type).length, 5);
  assert.equal(exhausted.store.list('deliveries')[0].state, 'exhausted');
});

test('410/413 never retry; challenge mismatch never activates subscription', async () => {
  for (const status of [410, 413]) {
    const f = fixture(); await f.service.subscribe('ydot', f.params); f.outcomes.push(status);
    capture(f.config, f.input, { clock: f.clock }); await f.service.drain(); f.advance(60000);
    assert.equal((await f.service.drain()).attempted, 0);
  }
  const f = fixture(), bad = new EventService(f.config, { ...f.options, transport: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  await assert.rejects(bad.subscribe('ydot', f.params), { code: -32015 });
  assert.notEqual(f.store.list('subscriptions')[0].state, 'active');
});

test('refresh, rotation, expiration, revocation and unsubscribe persist without cross-principal access', async () => {
  const f = fixture(); const a = await f.service.subscribe('ydot', { ...f.params, ttlMs: 1000 });
  f.advance(500); const b = await new EventService(f.config, f.options).subscribe('ydot', { ...f.params, ttlMs: 2000 });
  assert.equal(a.id, b.id); assert.ok(b.refreshBefore > a.refreshBefore);
  f.service.unsubscribe('ydot', f.params); capture(f.config, f.input, { clock: f.clock });
  assert.equal((await f.service.drain()).attempted, 0);
  await f.service.subscribe('ydot', { ...f.params, ttlMs: 1000 }); f.advance(1001);
  assert.equal((await f.service.drain()).attempted, 0);
  await f.service.subscribe('ydot', f.params); f.config.targets[0].principals = [];
  assert.equal((await f.service.drain()).attempted, 0);
  assert.equal(f.store.list('subscriptions')[0].state, 'access_revoked');
  const rotated = headers({ id: 'sub', secret, previousSecret: `whsec_${Buffer.alloc(32, 18).toString('base64')}`, rotateUntil: f.clock() + 1000 }, 'evt', '{}', f.clock);
  assert.equal(rotated['webhook-signature'].split(' ').length, 2);
});

test('unsubscribe during challenge cannot be resurrected by a delayed response', async () => {
  const f = fixture(); let finish;
  const service = new EventService(f.config, { ...f.options, transport: (_u, _h, body) => new Promise(resolve => {
    finish = () => resolve({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
  }) });
  const pending = service.subscribe('ydot', f.params); service.unsubscribe('ydot', f.params); finish();
  await assert.rejects(pending, /subscription_changed/);
  assert.equal(f.store.list('subscriptions')[0].state, 'unsubscribed');
});

test('native-shaped Stop/PermissionRequest/Interrupt fixture hooks exit zero, emit no control output and exclude prompts/commands', () => {
  const f = fixture(), configBefore = fs.readFileSync(f.file);
  for (const hook_event_name of ['Stop', 'PermissionRequest', 'Interrupt']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, '../hooks/codex-events.js'), f.file], {
      input: JSON.stringify({ ...f.input, hook_event_name, tool_name: 'Bash', tool_input: { command: 'PRIVATE COMMAND' } }), encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), {}); assert.equal(child.stderr, '');
  }
  const data = f.store.list('events'); assert.equal(data.length, 3);
  const permission = data.find(e => e.data.hook_event === 'PermissionRequest');
  assert.equal(permission.data.status, 'decision_requested'); assert.equal(Object.hasOwn(permission.data, 'decision'), false);
  assert.equal(JSON.stringify(data).includes('PRIVATE'), false); assert.deepEqual(fs.readFileSync(f.file), configBefore);
  const invalid = spawnSync(process.execPath, [path.join(__dirname, '../hooks/codex-events.js'), f.file], { input: 'bad', encoding: 'utf8', timeout: 3000 });
  assert.equal(invalid.status, 0); assert.deepEqual(JSON.parse(invalid.stdout), {});
});

test('buffer capacity is bounded and retention removes only owned old records', async () => {
  const f = fixture(); f.config.maxEvents = 1;
  capture(f.config, f.input, { clock: f.clock });
  assert.equal(capture(f.config, { ...f.input, turn_id: 'turn-two' }, { clock: f.clock }).dropped, 'buffer_full');
  f.advance(8 * 86400000); await f.service.drain(); assert.equal(f.store.list('events').length, 0);
});

test('Hook merge/removal preserves unrelated policy hooks and produces only asynchronous observation handlers', () => {
  const groups = hooks.makeGroups(path.join(fixture().root, 'config.json'));
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-policy' }] }] }, description: 'keep' };
  const merged = hooks.merge(existing, groups);
  assert.deepEqual(hooks.merge(merged, groups), merged); assert.deepEqual(hooks.remove(merged, groups), existing);
  for (const group of Object.values(groups)) { assert.equal(group.hooks[0].async, true); assert.equal(group.hooks[0].timeout, 3); assert.ok(group.hooks[0].commandWindows.includes('pwsh')); }
});

test('MCP endpoint authenticates events and read-only tools together; no remote shell/queue write tools exist', async () => {
  const f = fixture(), token = crypto.randomBytes(32).toString('hex'), server = createServer(f.service, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const rpc = (method, params = {}, auth = token) => fetch(endpoint, { method: 'POST', headers: {
    authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    assert.equal((await rpc('events/list', {}, 'wrong')).status, 401);
    assert.deepEqual((await (await rpc('initialize')).json()).result.capabilities.events, {});
    assert.equal((await (await rpc('events/list')).json()).result.events.length, 3);
    assert.ok((await (await rpc('events/subscribe', f.params)).json()).result.id);
    const tools = (await (await rpc('tools/list')).json()).result.tools;
    assert.deepEqual(tools.map(t => t.name), ['bridge_status']);
    assert.equal((await (await rpc('tools/call', { name: 'shell', arguments: {} })).json()).error.code, -32602);
    assert.deepEqual((await (await rpc('events/unsubscribe', f.params)).json()).result, {});
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('SSRF rejects private/mapped/special addresses and non-HTTPS callback forms', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.1.1.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:444', 'https://example.com/#x']) assert.throws(() => callbackUrl(url));
});

test('each callback request revalidates DNS, pins the chosen address and never follows redirect responses', async () => {
  const { EventEmitter } = require('node:events'); let lookups = 0, requests = 0;
  const transport = createTransport({ resolve: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    request: (url, options, listener) => {
      requests++; assert.equal(url.hostname, 'callback.example.invalid'); assert.equal(options.agent, false);
      options.lookup(url.hostname, {}, (_error, address) => assert.equal(address, '8.8.8.8'));
      const req = new EventEmitter(); req.destroy = error => { req.emit('error', error); req.emit('close'); };
      req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 302;
        listener(res); res.emit('end'); req.emit('close'); }); return req;
    } });
  assert.equal((await transport('https://callback.example.invalid/path', {}, '{}')).status, 302);
  await assert.rejects(transport('https://callback.example.invalid/path', {}, '{}'), /denied/);
  assert.equal(requests, 1); assert.equal(lookups, 2);
});

test('secret rotation refreshes the same subscription and signs with both keys only inside the bounded window', async () => {
  const f = fixture(), second = `whsec_${Buffer.alloc(32, 18).toString('base64')}`;
  const service = new EventService(f.config, { ...f.options, transport: async (_url, _h, body) => ({ status: 200,
    body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }) });
  const first = await service.subscribe('ydot', f.params);
  const next = await service.subscribe('ydot', { ...f.params, delivery: { ...f.params.delivery, secret: second } });
  assert.equal(first.id, next.id);
  const sub = f.store.get('subscriptions', first.id);
  assert.equal(sub.secret, second); assert.equal(sub.previousSecret, secret);
  assert.equal(headers(sub, 'evt', '{}', f.clock)['webhook-signature'].split(' ').length, 2);
  f.advance(300001);
  assert.equal(headers(sub, 'evt', '{}', f.clock)['webhook-signature'].split(' ').length, 1);
  await assert.rejects(service.subscribe('ydot', { ...f.params, delivery: { ...f.params.delivery, secret: 'whsec_bad' } }), { code: -32602 });
  await assert.rejects(service.subscribe('ydot', { ...f.params, ttlMs: 0 }), { code: -32602 });
});

test('foreground runtime binds loopback only and closes its own listener/ownership file; missing authentication cannot start it', async () => {
  const f = fixture(), { main } = require('../bin/codex-events');
  assert.throws(() => createServer(f.service), /authentication token/);
  const running = await main(['serve', '--config', f.file, '--port', '0'], { token: crypto.randomBytes(32).toString('hex') });
  try {
    assert.equal(running.server.address().address, '127.0.0.1');
    assert.equal(fs.existsSync(path.join(f.config.stateDir, 'event-server-owner.json')), true);
    await assert.rejects(main(['serve', '--config', f.file, '--port', '0'], { token: crypto.randomBytes(32).toString('hex') }), { code: 'EEXIST' });
  } finally { await running.close(); }
  assert.equal(running.server.listening, false);
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'event-server-owner.json')), false);
});

test('project Hook apply/removal is reversible and retains an existing unrelated policy', async () => {
  const f = fixture(), { main } = require('../bin/codex-events');
  const hookFile = path.join(f.root, '.codex', 'hooks.json'); fs.mkdirSync(path.dirname(hookFile));
  const prior = { description: 'retain', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'retain-policy' }] }] } };
  fs.writeFileSync(hookFile, JSON.stringify(prior));
  await main(['hooks', '--config', f.file, '--project', f.root, '--apply']);
  assert.equal(JSON.parse(fs.readFileSync(hookFile)).hooks.Stop.length, 2);
  await main(['hooks', '--config', f.file, '--project', f.root, '--apply', '--remove']);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookFile)), prior);
});

test('expiration without events scrubs signing material and subscription creation is capped before new callback I/O', async () => {
  const f = fixture(), service = new EventService(f.config, { ...f.options, maxSubscriptions: 1 });
  const a = await service.subscribe('ydot', { ...f.params, ttlMs: 1000 });
  await assert.rejects(service.subscribe('ydot', { ...f.params, name: 'codex.turn.interrupted' }), { code: -32000 });
  assert.equal(f.calls.length, 1);
  f.advance(1001); await service.drain();
  const expired = f.store.get('subscriptions', a.id);
  assert.equal(expired.state, 'expired'); assert.equal(Object.hasOwn(expired, 'secret'), false);
});

test('generated Windows command forwards hook stdin and remains observation-only', { skip: process.platform !== 'win32' }, () => {
  const f = fixture(), command = hooks.makeGroups(f.file).Stop.hooks[0].commandWindows;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: JSON.stringify(f.input), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(f.store.list('events').length, 1);
});

test('Stop observations never assert final completion and a later Stop continuation is a distinct event without storing its text', () => {
  const f = fixture();
  const first = capture(f.config, f.input, { clock: f.clock });
  const next = capture(f.config, { ...f.input, stop_hook_active: true, last_assistant_message: 'PRIVATE CONTINUATION' }, { clock: f.clock });
  assert.notEqual(first.eventId, next.eventId);
  const events = f.store.list('events');
  assert.ok(events.every(e => e.name === 'codex.stop.observed' && e.data.status === 'stop_observed'));
  assert.equal(events.some(e => e.data.stop_hook_active === true), true);
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
});

test('filtered and controlled-error hook paths emit an empty JSON object without any control decision', () => {
  const f = fixture(), script = path.join(__dirname, '../hooks/codex-events.js');
  for (const [config, input] of [
    [f.file, JSON.stringify({ ...f.input, session_id: 'not-allowed' })],
    [f.file, JSON.stringify({ ...f.input, turn_id: '' })],
    [f.file, 'not-json'],
    [path.join(f.root, 'missing-config.json'), JSON.stringify(f.input)],
    [f.file, 'x'.repeat(512 * 1024 + 1)],
  ]) {
    const result = spawnSync(process.execPath, [script, config], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(result.stderr, '');
  }
  assert.equal(f.store.list('events').length, 0);
});

test('hook input deadline emits valid JSON and terminates its own child without task-control fields', async () => {
  const f = fixture();
  const child = spawn(process.execPath, [path.join(__dirname, '../hooks/codex-events.js'), f.file], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture hook failed to respect its input deadline')); }, 3000);
    child.once('error', reject); child.once('close', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0); assert.deepEqual(JSON.parse(stdout), {}); assert.equal(stderr, '');
});
