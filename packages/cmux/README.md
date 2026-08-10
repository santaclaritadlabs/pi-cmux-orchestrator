# @pi-cmux/cmux

Optional visual bridge from agentd status projections to the external [cmux](https://cmux.com) CLI/socket API. cmux is **not** a control-plane dependency: `agentd` and `@pi-cmux/pi-extension` work without this package.

## Prerequisites

- Node.js ≥ 22.18
- Running `agentd` daemon
- cmux installed locally (for visual integration only)

## Install from this checkout

```bash
pnpm install
pnpm build
pnpm --filter @pi-cmux/cmux test
```

## Visual integration (optional)

```typescript
import {
  createCmuxClient,
  createRunLayout,
  createCmuxApiSink,
  RunLayoutStore,
} from "@pi-cmux/cmux";
import { CmuxStatusConsumer, PiAgentdBridge } from "@pi-cmux/pi-extension";

const client = createCmuxClient({ socketPath: "/tmp/cmux.sock" });
const store = new RunLayoutStore();

const layout = await createRunLayout(
  client,
  {
    runId: "run_01J…",
    taskId: "AUTH-41",
    workerKind: "codex",
  },
  { store },
);

const sink = createCmuxApiSink(client, {
  workspaceId: layout.value.workspaceId,
  logSurfaceId: layout.value.logSurfaceId,
});

const consumer = new CmuxStatusConsumer(bridge, sink);
await consumer.follow(runId);
```

Log tail surfaces run `agentd logs --follow <runId>` in a cmux pane. **Closing a cmux workspace does not cancel the agentd run** — workers remain supervised by `agentd`.

## Headless smoke (no cmux required)

Verify Pi + agentd without loading this package:

```bash
# 1. Build the workspace
pnpm build

# 2. Run headless regression tests
pnpm --filter @pi-cmux/pi-extension test

# 3. Start agentd (separate terminal)
pnpm --filter @pi-cmux/agentd exec node dist/cli.js start

# 4. Use pi-extension commands from Pi, or exercise the bridge in tests
pnpm --filter @pi-cmux/pi-extension test -- dist/headless.test.js
```

Expected: task create/start/status/watch works with `createCmuxTextSink` only; no `@pi-cmux/cmux` import.

## Security

- Default socket mode: `cmuxOnly` (never `allowAll`)
- Never pass `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, or `CMUX_SURFACE_ID` to workers
- See `docs/threat-model.md` and spec §14

## Opt-in live cmux test

```bash
CMUX_E2E=1 pnpm --filter @pi-cmux/cmux test
```

Requires a running cmux instance with its control socket available.
