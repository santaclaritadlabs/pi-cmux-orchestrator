import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StatusSnapshot } from "@pi-cmux/pi-extension";

import { createCmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import {
  isTerminalRunState,
  notifyTerminalTransition,
  TerminalNotificationGuard,
  terminalNotificationMessage,
} from "./notifications.ts";

const snapshot: StatusSnapshot = {
  run: {
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
    state: "SUCCEEDED",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:01.000Z",
  },
  eventCount: 2,
};

describe("terminal notifications", () => {
  it("detects terminal run states", () => {
    assert.equal(isTerminalRunState("SUCCEEDED"), true);
    assert.equal(isTerminalRunState("RUNNING"), false);
  });

  it("formats a bounded notification message", () => {
    assert.equal(
      terminalNotificationMessage(snapshot, "SUCCEEDED · done"),
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC: SUCCEEDED · done",
    );
  });

  it("sends notification.create once per guard", () => {
    const guard = new TerminalNotificationGuard();
    assert.equal(guard.shouldNotify("RUNNING"), false);
    assert.equal(guard.shouldNotify("SUCCEEDED"), true);
    assert.equal(guard.shouldNotify("SUCCEEDED"), false);
  });

  it("notifies through the cmux client on terminal transition", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const notified = await notifyTerminalTransition(client, {
      workspaceId: "ws-test-01",
      snapshot,
      formattedStatus: "SUCCEEDED · done",
    });

    assert.equal(notified.ok, true);
    assert.equal(transport.rpcCalls.at(-1)?.method, "notification.create");

    client.close();
  });

  it("skips notification while the run is still in flight", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });

    const notified = await notifyTerminalTransition(client, {
      workspaceId: "ws-test-01",
      snapshot: {
        ...snapshot,
        run: { ...snapshot.run, state: "RUNNING" },
      },
      formattedStatus: "RUNNING",
    });

    assert.equal(notified.ok, true);
    assert.equal(transport.rpcCalls.length, 0);

    client.close();
  });
});
