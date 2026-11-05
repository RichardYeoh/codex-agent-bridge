'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const deps = path.resolve(process.env.ZCODE_SDK_BUILD_DEPS || path.join(root, '.local/zcode-sdk-deps'));
const esbuild = require(require.resolve('esbuild', { paths: [deps] }));
const sha = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
const base = `https://raw.githubusercontent.com/zai-org/ZCode/${sha}/`;
const cache = path.join(root, '.local/zcode-sdk-sources');
const output = path.join(root, 'agent-bridge/vendor/zcode');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const manifestPath = path.join(output, 'sources.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const sourceHashes = new Map((previous.sources || []).map(item => [item.path, item.sha256]));
const sources = new Map();
const entries = {
  'packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts': ['createAcknowledgedWebRemoteControlRelayProtocol'],
  'packages/rpc/src/channelClient.ts': ['ChannelClient'],
  'packages/shared/src/zcode-protocol-v4/wire-assembler.ts': ['TopicWireFrameAssembler'],
  'packages/shared/src/zcode-protocol-v4/transport.ts': ['conversationTopicFrameSchema'],
  'packages/shared/src/zcode-protocol-v4/apply.ts': ['applyConversationDeltas'],
  'apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts': ['loadSharedZCodeCredentialSync'],
};
const rpc = `export {Emitter,DisposableStore,Event,CancellationToken,CancellationTokenSource,toDisposable} from '${base}packages/rpc/src/foundation.ts';export {VSBuffer} from '${base}packages/rpc/src/buffer.ts';export {ChannelClient} from '${base}packages/rpc/src/channelClient.ts';`;
const shared = `export * from '${base}packages/shared/src/web-remote-control-rpc-transport.ts';`;

async function download(relative) {
  if (relative.includes('..') || !/^[\w./-]+$/.test(relative)) throw new Error('Invalid source path');
  const file = path.join(cache, relative.replaceAll('/', '_'));
  let data;
  if (fs.existsSync(file)) data = fs.readFileSync(file);
  else {
    const response = await fetch(base + relative, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Pinned source unavailable: ${relative}`);
    data = Buffer.from(await response.arrayBuffer()); fs.writeFileSync(file, data);
  }
  if (sourceHashes.has(relative) && sourceHashes.get(relative) !== hash(data)) throw new Error(`Source digest mismatch: ${relative}`);
  sources.set(relative, hash(data)); return data.toString('utf8');
}

async function main() {
  if (require(require.resolve('esbuild/package.json', { paths: [deps] })).version !== '0.28.2'
      || require(require.resolve('zod/package.json', { paths: [deps] })).version !== '4.6.7') {
    throw new Error('Reproduction requires esbuild 0.28.2 and zod 4.6.7');
  }
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  await esbuild.build({
    stdin: { contents: Object.entries(entries).map(([file, names]) => `export {${names.join(',')}} from '${base}${file}';`).join(''), loader: 'ts' },
    bundle: true, minify: true, platform: 'node', format: 'cjs', target: 'node24',
    banner: { js: '/* Derived from zai-org/ZCode (Apache-2.0) and zod (MIT). See sibling licenses and sources.json. Read-only credential export; workspace import shims adapted by Codex Agent Bridge. */' },
    outfile: path.join(output, 'remote-sdk.cjs'),
    plugins: [{ name: 'pinned-official-source', setup(build) {
      // Only the read-only credential export is retained; writing dependencies are disabled. / 仅保留只读凭据导出，禁用写入依赖。
      build.onResolve({ filter: /^@zcode\/shared\/node$/ }, () => ({ path: 'read-only-auth', namespace: 'auth-shim' }));
      build.onLoad({ filter: /.*/, namespace: 'auth-shim' }, () => ({ loader: 'js', contents:
        'export const atomicWritePrivateTextFile=()=>{throw Error("Read-only auth")};export const backupCorruptFile=atomicWritePrivateTextFile;export const withFileLock=atomicWritePrivateTextFile;' }));
      build.onResolve({ filter: /^@zcode\/(rpc|shared)$/ }, args => ({ path: args.path, namespace: 'workspace-shim' }));
      build.onLoad({ filter: /.*/, namespace: 'workspace-shim' }, args => ({ contents: args.path === '@zcode/rpc' ? rpc : shared, loader: 'ts' }));
      build.onResolve({ filter: /^https:\/\/raw\.githubusercontent\.com\// }, args => {
        if (!args.path.startsWith(base)) throw new Error('Unpinned source');
        return { path: args.path, namespace: 'official-http' };
      });
      build.onResolve({ filter: /^\.\.?\//, namespace: 'official-http' }, args => {
        const url = new URL(args.path.replace(/\.js$/, '.ts'), args.importer).href;
        if (!url.startsWith(base)) throw new Error('Unpinned relative source');
        return { path: url, namespace: 'official-http' };
      });
      build.onResolve({ filter: /^zod$/, namespace: 'official-http' }, () => ({ path: require.resolve('zod', { paths: [deps] }) }));
      build.onLoad({ filter: /.*/, namespace: 'official-http' }, async args => ({ contents: await download(args.path.slice(base.length)), loader: 'ts' }));
    } }],
  });
  fs.writeFileSync(path.join(output, 'LICENSE-ZCode'), await download('LICENSE'));
  fs.copyFileSync(path.join(path.dirname(require.resolve('zod/package.json', { paths: [deps] })), 'LICENSE'), path.join(output, 'LICENSE-zod'));
  fs.writeFileSync(manifestPath, JSON.stringify({ upstreamCommit: sha, esbuild: '0.28.2', zod: '4.6.7',
    bundleSha256: hash(fs.readFileSync(path.join(output, 'remote-sdk.cjs'))),
    sources: [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([file, digest]) => ({ path: file, sha256: digest })),
  }, null, 2) + '\n');
  process.stdout.write(`Built pinned ZCode SDK from ${sources.size} verified sources\n`);
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
