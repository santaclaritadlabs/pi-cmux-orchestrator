import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  makeError,
  sampleTask,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import type { DaemonClient } from "@pi-cmux/agentd";

import { PiAgentdBridge } from "./index.ts";
import type { PiCommandInput, PiCommandResponse } from "./api.ts";
import {
  PI_COMMANDS,
  registerPiExtension,
  type PiExtensionHost,
} from "./api.ts";

function fakeClient(values: Readonly<Record<string, unknown>>): DaemonClient {
  return {
    call: (method): Promise<Result<unknown, AgentdError>> => {
      const value = values[method];
      return Promise.resolve(
        value === undefined
          ? { ok: false, error: makeError("INTERNAL", "missing") }
          : { ok: true, value },
      );
    },
    close: () => undefined,
  };
}

function host(): {
  host: PiExtensionHost;
  handlers: Map<string, (input: PiCommandInput) => Promise<PiCommandResponse>>;
  shutdown: () => void;
} {
  const handlers = new Map<
    string,
    (input: PiCommandInput) => Promise<PiCommandResponse>
  >();
  let shutdown = (): void => undefined;
  return {
    handlers,
    host: {
      registerCommand: (name, handler) => handlers.set(name, handler),
      unregisterCommand: (name) => handlers.delete(name),
      onShutdown: (handler) => {
        shutdown = handler;
      },
    },
    shutdown: () => {
      shutdown();
    },
  };
}

describe("Pi extension runtime adapter", () => {
  it("registers the complete first-party command surface", async () => {
    const runtime = host();
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({
        "daemon.health": { status: "ok", pid: 7, liveRuns: 0, uptimeMs: 1 },
      }),
    );
    registerPiExtension(runtime.host, bridge);
    assert.deepEqual([...runtime.handlers.keys()], PI_COMMANDS);
    const health = await runtime.handlers.get("agentd.health")?.({ args: [] });
    assert.deepEqual(health, {
      ok: true,
      value: { status: "ok", pid: 7, liveRuns: 0, uptimeMs: 1 },
    });
  });

  it("routes validated task JSON through the bridge and rejects bad input", async () => {
    const runtime = host();
    const run = {
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
      state: "QUEUED" as const,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({ "task.create": run }),
    );
    registerPiExtension(runtime.host, bridge);
    const create = runtime.handlers.get("agentd.create");
    assert.ok(create);
    assert.equal(
      (await create({ args: [JSON.stringify(sampleTask())] })).ok,
      true,
    );
    const malformed = await create({ args: ["not-json"] });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.code, "SCHEMA_INVALID");
  });

  it("unregisters commands and closes the bridge on dispose", () => {
    const runtime = host();
    let closed = false;
    const bridge = PiAgentdBridge.fromClient({
      call: () =>
        Promise.resolve({ ok: false, error: makeError("INTERNAL", "unused") }),
      close: () => {
        closed = true;
      },
    });
    const dispose = registerPiExtension(runtime.host, bridge);
    dispose();
    assert.equal(runtime.handlers.size, 0);
    assert.equal(closed, true);
  });
});
