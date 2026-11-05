'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { EventService } = require('../lib/events/service');
const { createServer } = require('../lib/events/server');
const { digest } = require('../lib/events/store');
const { readBinding, runtimeEnvironment, failureStatus, doctorStatus, RuntimeFailure, doctorSucceeded, start } = require('../../tools/ydot-tunnel-runtime.cjs');
const runtimeFile = require.resolve('../../tools/ydot-tunnel-runtime.cjs');
const sentinel = '无权限哨兵_ONLY_TEST_SPLIT_BOUNDARIES_93E7';
const fixtureToken = 'LOCAL-ONLY-UNPRIVILEGED-BRIDGE-TEST-STRING';
const roots = [];
test.after(() => { for (const root of roots) { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tunnel-test-')); roots.push(root);
  const local = path.join(root, '.local/ydot-secure-tunnel-20261031'); fs.mkdirSync(local, { recursive: true });
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  const targets = [{ id: 'test-owner', sessionId: 'test-session', cwd: root, principals: ['ydot'] }];
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ version: 1, stateDir, targets }));
  fs.writeFileSync(path.join(root, 'profile.yaml'), 'cloudflared: {managed: false}\n');
  // Deliberately invalid executable tests local launch failure without any network. / 故意无效的可执行文件验证本地启动失败，不访问网络。
  fs.writeFileSync(path.join(root, 'client.exe'), 'not an executable');
  const binding = { version: 1, activationApproved: true, targets };
  for (const [name, relativePath] of Object.entries({ client: 'client.exe', profile: 'profile.yaml', bridgeConfig: 'config.json' })) {
    binding[name] = { relativePath, sha256: digest(fs.readFileSync(path.join(root, relativePath))) };
  }
  const manifest = path.join(local, 'binding.json'); fs.writeFileSync(manifest, JSON.stringify(binding));
  return { root, local, stateDir, binding, manifest };
}
test('tunnel binding rejects modified files, paths escaping the project, and expanded target scope', () => {
  const f = fixture(); assert.equal(readBinding(f.root).config.targets.length, 1);
  fs.appendFileSync(path.join(f.root, 'profile.yaml'), 'changed'); assert.throws(() => readBinding(f.root), /Changed profile/);
  const g = fixture(); g.binding.client.relativePath = os.tmpdir(); fs.writeFileSync(g.manifest, JSON.stringify(g.binding));
  assert.throws(() => readBinding(g.root), /outside this project/);
  const h = fixture(); h.binding.targets[0].sessionId = 'other-session'; fs.writeFileSync(h.manifest, JSON.stringify(h.binding));
  assert.throws(() => readBinding(h.root), /allowlist/);
});
test('runtime environment excludes inherited credentials and forces raw HTTP logs off', () => {
  const env = runtimeEnvironment({ PATH: 'system-path', OPENAI_API_KEY: 'old-key', OPENAI_ADMIN_KEY: 'admin-key', CONTROL_PLANE_API_KEY: 'old-runtime', LOG_HTTP_RAW_UNSAFE: 'true', MCP_COMMAND: 'arbitrary-shell' }, 'new-runtime', 'tunnel_test', 'local-token', 'local-profiles');
  assert.equal(env.CONTROL_PLANE_API_KEY, 'new-runtime'); assert.equal(env.EVENT_BRIDGE_AUTHORIZATION, 'Bearer local-token');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OPENAI_ADMIN_KEY, undefined); assert.equal(env.MCP_COMMAND, undefined);
  assert.equal(env.LOG_HTTP_RAW_UNSAFE, 'false'); assert.equal(env.PATH, 'system-path');
});
test('doctor success follows the official ok/FAIL contract and also requires a successful process exit', () => {
  assert.equal(doctorSucceeded(0, { result: 'ok', checks: [{ id: 'profile_load', status: 'PASS' }] }), true);
  assert.equal(doctorSucceeded(0, { result: 'pass', checks: [] }), false);
  assert.equal(doctorSucceeded(0, { result: 'ok', checks: [{ status: 'FAIL' }] }), false);
  assert.equal(doctorSucceeded(2, { result: 'ok', checks: [] }), false);
  assert.equal(doctorSucceeded(0, null), false);
});
test('raw stdout/stderr are discarded at every byte split including UTF8, EOF and oversized lines', () => {
  const driver = `const {PassThrough}=require('node:stream');const {once}=require('node:events');
    const {discardClientOutput}=require(process.argv[1]);const marker=process.env.AUDIT_SENTINEL;
    (async()=>{let cases=0;for(const channel of ['stdout','stderr'])for(const value of [marker,'prefix '+marker+'\\n'+marker+'\\r\\n']){
      const bytes=Buffer.from(value);for(let cut=0;cut<=bytes.length;cut++){
        const stream=new PassThrough();discardClientOutput(stream);const ended=once(stream,'end');
        stream.write(bytes.subarray(0,cut));stream.end(bytes.subarray(cut));await ended;cases++;
      }
    }for(const channel of ['stdout','stderr']){const stream=new PassThrough();discardClientOutput(stream);const ended=new Promise(resolve=>stream.once('end',resolve));
      stream.write('x'.repeat(33000));stream.emit('error',new Error(marker));stream.end(Buffer.from(marker));await ended;cases++;}
      process.stdout.write(JSON.stringify({discarded:true,cases})+'\\n');})().catch(()=>process.exit(2));`;
  const result = spawnSync(process.execPath, ['-e', driver, runtimeFile], {
    env: { ...process.env, AUDIT_SENTINEL: sentinel }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const expected = 2 * ([sentinel, 'prefix ' + sentinel + '\n' + sentinel + '\r\n'].reduce((n, s) => n + Buffer.byteLength(s) + 1, 0)) + 2;
  assert.ok(result.stdout === JSON.stringify({ discarded: true, cases: expected }) + '\n', 'Only a fixed test summary may be emitted');
  assert.ok(!(result.stdout + result.stderr).includes(sentinel), 'No sentinel or recombinable raw output');
});
test('doctor and failure receipts emit only enumerated fields, never raw diagnostics, result text or error messages', () => {
  const receipt = doctorStatus({ result: sentinel, failed_checks: [sentinel], checks: [{ id: sentinel, status: sentinel, summary: sentinel }] });
  assert.deepEqual(receipt, { phase: 'doctor', result: 'unknown', checks: [{ id: 'other_check', status: 'UNKNOWN' }] });
  for (const error of [new Error(sentinel), Object.assign(new Error(sentinel), { code: sentinel }), new RuntimeFailure(sentinel)]) {
    assert.deepEqual(failureStatus(error), { phase: 'runtime-error', reason: 'runtime_failed' });
  }
});
test('malformed stdin at every byte boundary and real CLI invalid input never print parser snippets', () => {
  const driver = `const {PassThrough}=require('node:stream');const {main,failureStatus}=require(process.argv[1]);
    (async()=>{const data=Buffer.from('{"runtimeKey":"'+process.env.AUDIT_SENTINEL+'",BROKEN}');let cases=0;
      for(let cut=0;cut<=data.length;cut++){const input=new PassThrough();const done=main({input,argv:[]}).then(()=>{throw Error('unexpected success')},e=>failureStatus(e));
        input.write(data.subarray(0,cut));input.end(data.subarray(cut));const receipt=await done;
        if(JSON.stringify(receipt)!==JSON.stringify({phase:'runtime-error',reason:'credential_input_invalid'}))throw Error('unsafe receipt');cases++;}
      process.stdout.write(JSON.stringify({invalidInputRejected:true,cases})+'\\n');})().catch(()=>process.exit(3));`;
  const result = spawnSync(process.execPath, ['-e', driver, runtimeFile], { env: { ...process.env, AUDIT_SENTINEL: sentinel }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const count = Buffer.byteLength('{"runtimeKey":"' + sentinel + '",BROKEN}') + 1;
  assert.ok(result.stdout === JSON.stringify({ invalidInputRejected: true, cases: count }) + '\n', 'No parser content may be emitted');
  for (const input of [Buffer.from('{"runtimeKey":"' + sentinel + '",BROKEN}'), Buffer.from(sentinel.repeat(1000))]) {
    const cli = spawnSync(process.execPath, [runtimeFile], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 1); assert.equal(cli.stdout, '');
    assert.ok([JSON.stringify({ phase: 'runtime-error', reason: 'credential_input_invalid' }) + '\n',
      JSON.stringify({ phase: 'runtime-error', reason: 'credential_input_too_large' }) + '\n'].includes(cli.stderr), 'CLI must emit only the fixed failure schema');
  }
});
test('invalid or admin credentials never create owners or start bridge services', async () => {
  const f = fixture();
  f.binding.activationApproved = false; fs.writeFileSync(f.manifest, JSON.stringify(f.binding));
  await assert.rejects(start(f.root, {}), error => failureStatus(error).reason === 'activation_paused');
  f.binding.activationApproved = true; fs.writeFileSync(f.manifest, JSON.stringify(f.binding));
  await assert.rejects(start(f.root, { tunnelId: 'invalid', runtimeKey: 'never-sent-to-any-network' }), /real Tunnel ID/);
  await assert.rejects(start(f.root, { tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', runtimeKey: 'sk-admin-never-sent-to-any-network' }), /never an admin/);
  f.binding.tunnelId = 'tunnel_only_the_selected_resource'; fs.writeFileSync(f.manifest, JSON.stringify(f.binding));
  await assert.rejects(start(f.root, { tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', runtimeKey: 'fixture-not-a-real-runtime-key' }), /differs from/);
  assert.equal(fs.existsSync(path.join(f.local, 'runtime-owner.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'event-server-owner.json')), false);
});
test('pre-existing runtime ownership is preserved without starting a second bridge', async () => {
  const f = fixture(); const owner = path.join(f.local, 'runtime-owner.json'); fs.writeFileSync(owner, '{"pid":12345}');
  await assert.rejects(start(f.root, { tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', runtimeKey: 'fixture-not-a-real-runtime-key' }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(owner, 'utf8'), '{"pid":12345}'); assert.equal(fs.existsSync(path.join(f.stateDir, 'event-server-owner.json')), false);
});
test('failure to launch the dedicated client releases its own bridge and ownership files', async () => {
  const f = fixture();
  await assert.rejects(start(f.root, { tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', runtimeKey: 'fixture-not-a-real-runtime-key' }, { bridgePort: 0, fixtureToken }));
  assert.equal(fs.existsSync(path.join(f.local, 'runtime-owner.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'event-server-owner.json')), false);
});

test('real local child failures never relay sentinels and leave no runtime/bridge owners or sensitive persisted evidence', () => {
  for (const mode of ['invalid-doctor', 'failed-doctor', 'failed-client']) {
    const f = fixture();
    const driver = `const {spawn}=require('node:child_process');const {start,failureStatus}=require(process.argv[1]);
      const spawnClient=(_file,args,options)=>{const phase=args[0],mode=process.env.AUDIT_MODE;
        const program=\`const s=process.env.AUDIT_SENTINEL;const b=Buffer.from(s);
          const noise=stream=>{for(let cut=0;cut<=b.length;cut++){stream.write(b.subarray(0,cut));stream.write(b.subarray(cut));}stream.write('x'.repeat(33000));};
          if(process.env.AUDIT_PHASE==='doctor'){
            noise(process.stderr);
            if(process.env.AUDIT_MODE==='invalid-doctor'){noise(process.stdout);process.exitCode=7;}
            else{process.stdout.write(JSON.stringify({result:process.env.AUDIT_MODE==='failed-doctor'?'fail':'ok',
              checks:[{id:s,status:process.env.AUDIT_MODE==='failed-doctor'?'FAIL':'PASS',summary:s}],failed_checks:[s]}));}
          }else{noise(process.stdout);noise(process.stderr);process.exitCode=9;}\`;
        return spawn(process.execPath,['-e',program],{...options,env:{...options.env,AUDIT_SENTINEL:process.env.AUDIT_SENTINEL,AUDIT_MODE:mode,AUDIT_PHASE:phase}});};
      start(process.argv[2],{tunnelId:'tunnel_0123456789abcdef0123456789abcdef',runtimeKey:process.env.AUDIT_SENTINEL},
        {bridgePort:0,fixtureToken:'LOCAL-ONLY-UNPRIVILEGED-BRIDGE-TEST-STRING',spawnClient}).then(()=>process.exitCode=4,e=>{
          process.stderr.write(JSON.stringify(failureStatus(e))+'\\n');process.exitCode=7;});`;
    // The UTF8 sentinel is an inert fixture; neither subprocess can contact a cloud API. / UTF8哨兵仅为无权限样本，两个子进程均不访问云端API。
    const result = spawnSync(process.execPath, ['-e', driver, runtimeFile, f.root], {
      env: { ...process.env, AUDIT_SENTINEL: sentinel, AUDIT_MODE: mode }, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
    });
    assert.equal(result.status, 7);
    const reason = { 'invalid-doctor': 'doctor_output_invalid', 'failed-doctor': 'doctor_failed', 'failed-client': 'client_failed' }[mode];
    assert.ok(result.stderr === JSON.stringify({ phase: 'runtime-error', reason }) + '\n', 'No raw diagnostics or fragments may accompany failure');
    const lines = result.stdout.trim().split('\n').map(s => JSON.parse(s));
    assert.ok(lines.every(row => row.loopbackOnly === true || ['doctor', 'local-runtime-stopped'].includes(row.phase)), 'Only explicit local status fields may be printed');
    assert.ok(!(result.stdout + result.stderr).includes(sentinel), 'No stdout/stderr sentinel');
    assert.equal(fs.existsSync(path.join(f.local, 'runtime-owner.json')), false);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'event-server-owner.json')), false);
    const scan = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name); if (entry.isDirectory()) scan(item);
      else assert.ok(!fs.readFileSync(item).includes(Buffer.from(sentinel)), 'No sentinel in runtime evidence files');
    } }; scan(f.root);
  }
});

const nativeClient = path.resolve(__dirname, '../../.local/tunnel-client/v0.0.19/tunnel-client.exe');
test('official Windows doctor accepts authenticated MCP without claiming OAuth; test control plane receives no requests', {
  skip: process.platform !== 'win32' || !fs.existsSync(nativeClient),
}, async () => {
  const f = fixture(); let controlRequests = 0, child, deadline;
  const plane = http.createServer((_req, res) => { controlRequests++; res.writeHead(401); res.end(); });
  const token = 'LOCAL-ONLY-MCP-AUTHENTICATION-FIXTURE';
  const server = createServer(new EventService({ stateDir: f.stateDir, targets: [{ id: 'fixture', principals: ['ydot'] }] }), { token });
  try {
    plane.listen(0, '127.0.0.1'); await once(plane, 'listening'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      assert.equal((await fetch(url + route)).status, 404);
    }
    assert.equal((await fetch(url + '/mcp')).status, 401);
    assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })).status, 200);
    const profile = path.join(f.root, 'native-doctor.yaml');
    fs.writeFileSync(profile, `control_plane:\n  base_url: http://127.0.0.1:${plane.address().port}\n  api_key: env:CONTROL_PLANE_API_KEY\n  poll_channels: [main]\ncloudflared:\n  managed: false\nmcp:\n  server_urls:\n    - channel: main\n      url: ${url}/mcp\n  extra_headers:\n    Authorization: env:EVENT_BRIDGE_AUTHORIZATION\n  discovery_extra_headers:\n    Authorization: env:EVENT_BRIDGE_AUTHORIZATION\nhealth:\n  listen_addr: 127.0.0.1:0\nadmin_ui:\n  open_browser: false\n`);
    const env = runtimeEnvironment(process.env, 'LOCAL-FIXTURE-NOT-A-CLOUD-KEY', 'tunnel_0123456789abcdef0123456789abcdef', token, path.join(f.root, 'profiles'));
    child = spawn(nativeClient, ['doctor', '--profile-file', profile, '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    deadline = setTimeout(() => child.kill(), 10000);
    const [code] = await once(child, 'exit'); const report = JSON.parse(output);
    assert.equal(doctorSucceeded(code, report), true, JSON.stringify(report.checks.map(c => ({ id: c.id, status: c.status, summary: c.summary }))));
    assert.equal(report.checks.find(c => c.id === 'oauth_metadata').status, 'PASS'); assert.equal(controlRequests, 0);
  } finally {
    clearTimeout(deadline);
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
    server.closeAllConnections(); plane.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => plane.close(r))]);
  }
});
