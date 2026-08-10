import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ok } from "@pi-cmux/protocol";

import { createCmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import {
  createRunLayout,
  formatControlSurfaceTitle,
  formatLogSurfaceTitle,
  formatWorkspaceTitle,
  MAX_LAYOUT_TITLE_CHARS,
  RunLayoutStore,
  truncateLayoutTitle,
} from "./layout.ts";

describe("layout titles", () => {
  it("formats workspace and surface titles with bounded length", () => {
    assert.equal(
      formatWorkspaceTitle({
        runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
        taskId: "AUTH-41",
        workerKind: "codex",
      }),
      "AUTH-41 · CODEX",
    );
    assert.equal(formatControlSurfaceTitle("AUTH-41"), "Pi · AUTH-41");
    assert.equal(
      formatLogSurfaceTitle("run_01JQZX3K5T7V9B2N4M6P8R0AWC"),
      "logs · run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    );

    const long = "x".repeat(MAX_LAYOUT_TITLE_CHARS + 20);
    assert.equal(truncateLayoutTitle(long).length, MAX_LAYOUT_TITLE_CHARS);
    assert.match(truncateLayoutTitle(long), /…$/);
  });
});

describe("createRunLayout", () => {
  it("creates workspace, control, and log tail surfaces per spec §13", async () => {
    let surfaceCreates = 0;
    const transport = new FakeCmuxTransport((method) => {
      if (method === "surface.create") {
        surfaceCreates += 1;
        return ok({
          surface_id: `surface-${String(surfaceCreates)}`,
          surface_ref: `surface:${String(surfaceCreates)}`,
        });
      }
      if (method === "workspace.create") {
        return ok({
          workspace_id: "ws-auth-41",
          workspace_ref: "workspace:3",
        });
      }
      return ok({});
    });
    const client = createCmuxClient({ transport });
    const store = new RunLayoutStore();

    const layout = await createRunLayout(
      client,
      {
        runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
        taskId: "AUTH-41",
        workerKind: "codex",
      },
      { store },
    );

    assert.equal(layout.ok, true);
    assert.equal(layout.value.workspaceId, "ws-auth-41");
    assert.equal(layout.value.controlSurfaceId, "surface-1");
    assert.equal(layout.value.logSurfaceId, "surface-2");

    assert.deepEqual(
      transport.rpcCalls.map((call) => call.method),
      [
        "workspace.create",
        "workspace.rename",
        "surface.list",
        "surface.create",
        "surface.list",
        "surface.create",
        "surface.send_text",
      ],
    );

    const rename = transport.rpcCalls.find(
      (call) => call.method === "workspace.rename",
    );
    assert.deepEqual(rename?.params, {
      workspace_id: "ws-auth-41",
      title: "AUTH-41 · CODEX",
    });

    const logSurface = transport.rpcCalls.at(-1);
    assert.ok(logSurface);
    assert.equal(logSurface.method, "surface.send_text");
    assert.match(String(logSurface.params["text"]), /^agentd logs --follow/);

    client.close();
  });

  it("is idempotent for the same run id when using one store", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });
    const store = new RunLayoutStore();
    const input = {
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      taskId: "AUTH-42",
      workerKind: "claude" as const,
    };

    const first = await createRunLayout(client, input, { store });
    const second = await createRunLayout(client, input, { store });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.value, first.value);

    assert.equal(
      transport.rpcCalls.filter((call) => call.method === "workspace.create")
        .length,
      1,
    );

    client.close();
  });

  it("creates only one workspace for concurrent layout requests", async () => {
    let workspaceCreates = 0;
    let surfaceCreates = 0;
    const transport = new FakeCmuxTransport((method) => {
      if (method === "workspace.create") {
        workspaceCreates += 1;
        return ok({
          workspace_id: `ws-concurrent-${String(workspaceCreates)}`,
          workspace_ref: "workspace:9",
        });
      }
      if (method === "surface.create") {
        surfaceCreates += 1;
        return ok({
          surface_id: `surface-${String(surfaceCreates)}`,
          surface_ref: `surface:${String(surfaceCreates)}`,
        });
      }
      return ok({});
    });
    const client = createCmuxClient({ transport });
    const store = new RunLayoutStore();
    const input = {
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      taskId: "AUTH-43",
      workerKind: "codex" as const,
    };

    const [first, second] = await Promise.all([
      createRunLayout(client, input, { store }),
      createRunLayout(client, input, { store }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.value, first.value);
    assert.equal(workspaceCreates, 1);

    client.close();
  });
});
