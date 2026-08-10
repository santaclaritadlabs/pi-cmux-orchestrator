import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import {
  createSocketTransport,
  DEFAULT_CMUX_SOCKET_PATH,
  resolveCmuxSocketPath,
} from "./socket-transport.ts";

describe("FakeCmuxTransport", () => {
  it("round-trips workspace.create and updateStatus via recorded RPC and CLI", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport, socketMode: "cmuxOnly" });

    const created = await client.createWorkspace({
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      title: "AUTH-41 · CODEX",
    });
    assert.equal(created.ok, true);

    const status = await client.updateStatus({
      workspaceId: created.value.workspaceId,
      text: "RUNNING",
    });
    assert.equal(status.ok, true);

    assert.deepEqual(
      transport.rpcCalls.map((call) => call.method),
      ["workspace.create", "workspace.rename"],
    );
    assert.deepEqual(transport.cliCalls[0], [
      "set-status",
      `agentd-${created.value.workspaceId}`,
      "RUNNING",
      "--workspace",
      created.value.workspaceId,
    ]);

    client.close();
  });

  it("sends notification.create over RPC", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const notified = await client.notify({
      workspaceId: "workspace:1",
      message: "task succeeded",
    });
    assert.equal(notified.ok, true);
    assert.equal(transport.rpcCalls.at(-1)?.method, "notification.create");

    client.close();
  });
});

describe("resolveCmuxSocketPath", () => {
  it("prefers an explicit path over the environment default", () => {
    assert.equal(
      resolveCmuxSocketPath("/custom/cmux.sock"),
      "/custom/cmux.sock",
    );
  });

  it("falls back to the production default", () => {
    const previous = process.env["CMUX_SOCKET_PATH"];
    delete process.env["CMUX_SOCKET_PATH"];
    try {
      assert.equal(resolveCmuxSocketPath(), DEFAULT_CMUX_SOCKET_PATH);
    } finally {
      if (previous === undefined) delete process.env["CMUX_SOCKET_PATH"];
      else process.env["CMUX_SOCKET_PATH"] = previous;
    }
  });
});

describe("live cmux socket", () => {
  it("lists workspaces when CMUX_E2E=1", async (t) => {
    if (process.env["CMUX_E2E"] !== "1") {
      t.skip("opt-in gate: set CMUX_E2E=1 with a running cmux socket");
      return;
    }

    const transport = createSocketTransport({
      socketPath: resolveCmuxSocketPath(),
    });
    const listed = await transport.rpc("workspace.list", {});
    transport.close();

    assert.equal(listed.ok, true);
    assert.ok(Array.isArray(listed.value["workspaces"]));
  });
});
