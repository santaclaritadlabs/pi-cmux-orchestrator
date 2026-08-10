import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import {
  buildLogTailCommand,
  createLogTailCommand,
  attachLogTailSurface,
  LOG_TAIL_INDEPENDENCE,
} from "./log-tail.ts";

describe("createLogTailCommand", () => {
  it("builds argv without shell interpolation", () => {
    assert.deepEqual(createLogTailCommand("run_01JQZX3K5T7V9B2N4M6P8R0AWC"), [
      "agentd",
      "logs",
      "--follow",
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    ]);
  });

  it("rejects invalid run ids", () => {
    assert.throws(() => createLogTailCommand(""), /invalid/);
    assert.throws(() => createLogTailCommand("not-a-run-id"), /invalid/);
  });

  it("returns typed errors from buildLogTailCommand", () => {
    const invalid = buildLogTailCommand("bad");
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "SCHEMA_INVALID");
  });

  it("documents that cmux UI teardown does not stop agentd runs", () => {
    assert.match(LOG_TAIL_INDEPENDENCE, /does not cancel the agentd run/);
  });
});

describe("attachLogTailSurface", () => {
  it("configures a surface with the tail argv, not a worker process", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const attached = await attachLogTailSurface(client, {
      workspaceId: "ws-test-01",
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      title: "logs · run",
    });

    assert.equal(attached.ok, true);
    const send = transport.rpcCalls.find(
      (call) => call.method === "surface.send_text",
    );
    assert.ok(send);
    assert.equal(
      send.params["text"],
      "agentd logs --follow run_01JQZX3K5T7V9B2N4M6P8R0AWC\n",
    );
    assert.deepEqual((send.params["text"] as string).split(" ").slice(0, 3), [
      "agentd",
      "logs",
      "--follow",
    ]);

    client.close();
  });
});
