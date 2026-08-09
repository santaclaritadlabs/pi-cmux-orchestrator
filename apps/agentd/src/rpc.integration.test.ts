import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { connectToDaemon } from "./client.ts";
import { resolveDaemonPaths, prepareDaemonDirectories } from "./paths.ts";
import { startServer, type DaemonServer } from "./server.ts";
import type { Orchestrator } from "./orchestrator.ts";

/**
 * These tests exercise the actual Unix-socket transport, rather than the
 * daemon harness used by the unit suite. They are opt-in because some CI
 * sandboxes deny bind(2) even for a private, short-lived socket.
 */
const ENABLED = process.env["PI_CMUX_RPC_INTEGRATION"] === "1";

const TEST_TOKEN = "rpc-integration-token";

function healthOnlyOrchestrator(): Orchestrator {
  return {
    liveRunIds: () => [],
  } as unknown as Orchestrator;
}

function isSocketPermissionFailure(error: { cause?: unknown }): boolean {
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause !== undefined; depth += 1) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EPERM"
    )
      return true;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return false;
}

async function startIntegrationServer(
  t: TestContext,
): Promise<
  { server: DaemonServer; root: { path: string } & AsyncDisposable } | undefined
> {
  // Keep the socket under macOS's sun_path ceiling even when TMPDIR is long.
  const directory = await mkdtemp("/tmp/pi-");
  const dir: { path: string } & AsyncDisposable = {
    path: directory,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
  const runtimeDir = path.join(dir.path, "r");
  const stateDir = path.join(dir.path, "s");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const paths = resolveDaemonPaths({ runtimeDir, stateDir });
  const prepared = await prepareDaemonDirectories(paths);
  assert.equal(prepared.ok, true);

  const started = await startServer({
    paths,
    orchestrator: healthOnlyOrchestrator(),
    token: TEST_TOKEN,
  });
  if (!started.ok) {
    await dir[Symbol.asyncDispose]();
    if (isSocketPermissionFailure(started.error)) {
      t.skip("Unix socket bind denied by the execution sandbox (EPERM)");
      return undefined;
    }
    assert.fail(`RPC server failed to start: ${started.error.safeMessage}`);
  }

  return { server: started.value, root: dir };
}

describe("real RPC Unix-socket integration", { skip: !ENABLED }, () => {
  it("authenticates and answers health over the socket", async (t) => {
    const harness = await startIntegrationServer(t);
    if (harness === undefined) return;
    const { server, root } = harness;
    try {
      const connected = await connectToDaemon({
        socketPath: server.socketPath,
        token: TEST_TOKEN,
        client: "rpc-integration",
      });
      assert.equal(connected.ok, true);

      const health = await connected.value.call("daemon.health");
      assert.equal(health.ok, true);
      assert.ok(typeof health.value === "object" && health.value !== null);
      const healthValue = health.value as {
        status: unknown;
        pid: unknown;
        liveRuns: unknown;
        uptimeMs: unknown;
      };
      assert.equal(healthValue.status, "ok");
      assert.equal(healthValue.pid, process.pid);
      assert.equal(healthValue.liveRuns, 0);
      assert.equal(typeof healthValue.uptimeMs, "number");
      connected.value.close();
    } finally {
      await server.close();
      await root[Symbol.asyncDispose]();
    }
  });

  it("rejects a request sent before authentication", async (t) => {
    const harness = await startIntegrationServer(t);
    if (harness === undefined) return;
    const { server, root } = harness;
    try {
      const net = await import("node:net");
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(server.socketPath, () => {
          socket.write(
            `${JSON.stringify({
              protocolVersion: "1",
              id: "unauth",
              method: "daemon.health",
            })}\n`,
          );
        });
        socket.setEncoding("utf8");
        socket.once("data", (chunk: string) => {
          socket.destroy();
          resolve(chunk);
        });
        socket.once("error", reject);
      });
      const parsed = JSON.parse(response) as {
        ok: boolean;
        error?: { code: string };
      };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error?.code, "RPC_UNAUTHENTICATED");
    } finally {
      await server.close();
      await root[Symbol.asyncDispose]();
    }
  });
});
