# Single-Process Native Liney — technical validation branch

The explicit target is **one operating-system process**, not merely one
installer bundling separate executables.

- Native UI: Slint (no browser renderer, WebKitGTK or Chromium).
- Runtime: Node.js with TypeScript; its worker runs the existing LINEJS
  Engine in a **Worker Thread**, not a subprocess. Threads share the
  process/PID but have separate JS isolates and message passing.
- SQLite: transitional compatibility module connects Bun's `bun:sqlite`
  to Node's `node:sqlite`. On Node 22, `node:sqlite` is experimental.
- IPC on native path: `MessagePort`/Worker messages in memory; no child
  process, stdin pipe, local HTTP server or extra daemon.
- Legacy Tauri JSONL remains usable until feature parity is reached.

## Development test (isolated account)

From the repository root:

```sh
bun install
bun build engine/main.ts --target=node --packages=external --outfile app-unified/dist/engine.mjs
cd app-unified
npm install
export LINEY_UNIFIED_TEST=1
export LINEY_DISABLE_AUTO_RESTORE=1
export LINEY_DATA_DIR="$(mktemp -d)"
npm run dev
```

Do not run the test against a real account/data directory. The prototype
does not replace Liney v0.1.3, and doesn't yet provide a full chat view,
trays, media, complete UI capabilities, binary packaging or live LINE tests.
The test runner must verify the engine boots and responds to `ping`
before the unified architecture can be claimed as runtime-proven.

Future packaging must bundle one app and its native libraries. Other
native media helpers also need auditing before guaranteeing *zero* child
processes during calls/screen sharing. The UI may be native while bundling
Node's runtime: the executable size is not expected to equal a Rust-only GUI.

## Tested paths

The mock Worker + Slint proof runs in a single OS process. It does not
access LINE or real chat history:

```sh
cd app-unified
npm install
LINEY_UNIFIED_TEST=1 LINEY_UNIFIED_MOCK_ENGINE=1 LINEY_DATA_DIR="$(mktemp -d)" npm run dev
```

The host verifies the engine-reported process ID equals its own PID before
reporting success. The full LINEJS Node worker still needs dependency/runtime
validation on an isolated account.

Slint's current Node bindings are beta. Direct Bun+Slint was evaluated
and **failed at runtime** because Bun's libuv compatibility did not support
`uv_backend_fd` in the tested version. Do not use that path without a new
passing runtime smoke test.
