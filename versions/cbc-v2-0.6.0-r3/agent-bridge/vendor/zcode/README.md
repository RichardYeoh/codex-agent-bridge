# ZCode protocol subset

`remote-sdk.cjs` bundles selected official ZCode transport, RPC, conversation assembly/reducer and read-only shared-login functions. It contains no account data or machine configuration. Upstream source is pinned in `sources.json`; the adapter does not modify the installed ZCode application.

ZCode sources retain the Apache-2.0 license in `LICENSE-ZCode`. Bundled zod retains its MIT license in `LICENSE-zod`. These third-party licenses do not change the license of the surrounding project. Workspace import aliases are replaced by a small export shim; credential-writing imports are disabled and eliminated. The shared credential reader and cipher remain the upstream implementation.

Rebuild from the repository root with Node.js 24 or later:

```powershell
npm install --prefix .local/zcode-sdk-deps --no-save --ignore-scripts esbuild@0.28.2 zod@4.6.7
node tools/build-zcode-sdk.cjs
```

The build reads fixed upstream sources, caches them under `.local`, verifies recorded digests, and updates the bundle manifest. Normal installation uses the checked-in bundle and does not download build tools. Rebuild and run protocol tests after intentionally updating the upstream commit or dependency versions. A successful build alone does not establish compatibility with a newer Desktop runtime.
