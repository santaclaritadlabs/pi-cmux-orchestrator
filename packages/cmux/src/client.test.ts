import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CmuxStatusSink } from "@pi-cmux/pi-extension";

import { createCmuxClient, type CmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import {
  DEFAULT_CMUX_SOCKET_MODE,
  rejectCmuxControlVarsInWorkerEnv,
  resolveSocketMode,
} from "./security.ts";
import { createCmuxApiSink } from "./sink.ts";

describe("cmux security contract", () => {
  it("defaults socket mode to cmuxOnly", () => {
    const mode = resolveSocketMode();
    assert.equal(mode.ok, true);
    assert.equal(mode.value, "cmuxOnly");
    assert.equal(DEFAULT_CMUX_SOCKET_MODE, "cmuxOnly");
  });

  it("rejects allowAll as a socket mode", () => {
    const mode = resolveSocketMode("allowAll");
    assert.equal(mode.ok, false);
    assert.equal(mode.error.code, "POLICY_DENIED");
  });

  it("rejects unknown socket mode values", () => {
    const mode = resolveSocketMode("permissive");
    assert.equal(mode.ok, false);
    assert.equal(mode.error.code, "SCHEMA_INVALID");
  });

  it("rejects cmux control variables in worker environment records", () => {
    for (const name of [
      "CMUX_SOCKET_PATH",
      "CMUX_WORKSPACE_ID",
      "CMUX_SURFACE_ID",
    ] as const) {
      const rejected = rejectCmuxControlVarsInWorkerEnv({
        [name]: "/tmp/evil",
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "POLICY_DENIED");
    }

    const allowed = rejectCmuxControlVarsInWorkerEnv({ PATH: "/usr/bin" });
    assert.equal(allowed.ok, true);
  });

  it("createCmuxClient rejects allowAll at construction", () => {
    assert.throws(
      () =>
        createCmuxClient({
          socketPath: "/tmp/cmux.sock",
          socketMode: "allowAll",
        }),
      /allowAll is not permitted/,
    );
  });
});

describe("CmuxClient", () => {
  it("returns a transport-backed client", () => {
    const transport = new FakeCmuxTransport();
    let client: CmuxClient | undefined;
    assert.doesNotThrow(() => {
      client = createCmuxClient({
        transport,
        socketMode: "cmuxOnly",
      });
    });
    assert.ok(client);
    assert.equal(typeof client.createWorkspace, "function");
    client.close();
  });

  it("creates a workspace through the injected transport", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const created = await client.createWorkspace({
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      title: "review",
    });

    assert.equal(created.ok, true);
    assert.equal(created.value.workspaceId, "ws-test-01");
    client.close();
  });

  it("quotes surface command argv before send_text", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const created = await client.createSurface({
      workspaceId: "ws-test-01",
      title: "tail",
      command: ["agentd", "logs", "--follow", "run;rm -rf /"],
    });

    assert.equal(created.ok, true);
    const sent = transport.rpcCalls.find(
      (call) => call.method === "surface.send_text",
    );
    assert.ok(sent);
    assert.equal(sent.params["text"], "agentd logs --follow 'run;rm -rf /'\n");

    client.close();
  });
});

describe("CmuxStatusSink compatibility", () => {
  it("createCmuxApiSink satisfies CmuxStatusSink", () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });
    const sink: CmuxStatusSink = createCmuxApiSink(client, {
      workspaceId: "ws-test-01",
    });
    assert.equal(typeof sink.publish, "function");
    client.close();
  });
});
