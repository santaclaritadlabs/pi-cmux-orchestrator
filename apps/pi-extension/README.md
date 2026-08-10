# @pi-cmux/pi-extension

First-party Pi bridge to the local `agentd` RPC socket. Pi decides and requests
actions; `agentd` owns task lifecycle, policy, and worker processes. This
package never starts workers and never parses provider streams.

## Distribution

This package is **workspace-internal** — it is not published to npm. See
[`docs/adr/0012-pi-extension-distribution.md`](../../docs/adr/0012-pi-extension-distribution.md).

The one public npm artifact is `@pi-cmux/agentd` (see
[`docs/adr/0009-release-packaging.md`](../../docs/adr/0009-release-packaging.md)).

## Prerequisites

- Node.js ≥ 22.18 (see repo `.nvmrc`)
- pnpm ≥ 10.33
- A running or startable `agentd` daemon (from this checkout or from npm)

## Install from this checkout

From the repository root:

```bash
pnpm install
pnpm build
pnpm --filter @pi-cmux/pi-extension test
```

## Install into Pi

From the repository root, the installer runs the workspace install, waits for it
to finish, runs the build, waits for it to finish, and only then writes a small
loader into Pi's global extension directory:

```bash
pnpm install:pi-extension
```

The default destination is `~/.pi/agent/extensions`. A custom extension
directory can be selected explicitly:

```bash
pnpm install:pi-extension -- --target "$HOME/.config/pi/extensions"
```

`PI_EXTENSION_DIR` is also accepted. The generated
`pi-cmux-orchestrator.js` is a pointer to this checkout's compiled
`apps/pi-extension/dist/pi-entry.js`; keep the checkout in place after
installation. The loader executes code from that checkout, so only install from
a trusted repository. Pi auto-discovers the default directory. For a custom directory,
add the generated loader path to the `extensions` array in Pi's
`~/.pi/agent/settings.json`, or load it once with `pi -e <loader-path>`.

The loader connects to the daemon's default socket and token paths. Set
`AGENTD_SOCKET_PATH` or `AGENTD_TOKEN_PATH` when the daemon uses custom paths.

## Use in a Pi extension host

Import the bridge and command registration helpers:

```typescript
import {
  activatePiExtension,
  PiAgentdBridge,
  CmuxStatusConsumer,
  createCmuxTextSink,
} from "@pi-cmux/pi-extension";
```

Connect and register commands (example):

```typescript
const activated = await activatePiExtension(host, {
  socketPath: "/path/to/agentd.sock",
});
if (!activated.ok) {
  // handle AgentdError
}
const dispose = activated.value;
// dispose() on shutdown
```

Optional cmux status projection (headless text sink — no cmux binary required):

```typescript
const bridge = PiAgentdBridge.fromClient(/* connected DaemonClient */);
const consumer = new CmuxStatusConsumer(
  bridge,
  createCmuxTextSink({ write: (text) => process.stdout.write(text) }),
);
await consumer.follow(runId);
```

For a real cmux cockpit, use `@pi-cmux/cmux` (optional visual bridge) — not a
dependency of this package.

## Headless operation

`agentd` and this bridge work without cmux or `@pi-cmux/cmux`. cmux is an
optional visual client; closing a cmux workspace must not cancel workers
(`agentd` remains authoritative).

## Security

- Never pass `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, or `CMUX_SURFACE_ID` into
  worker environments (enforced by `agentd` / sandbox; see
  `docs/threat-model.md`).
- Do not call provider CLIs from Pi or extension code — route execution through
  `agentd`.

## Verify locally

```bash
pnpm --filter @pi-cmux/pi-extension test
```

Full repo gate:

```bash
pnpm verify
```
