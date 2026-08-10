import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { err, makeError, ok } from "@pi-cmux/protocol";
import type { StatusSnapshot } from "@pi-cmux/pi-extension";

import { createCmuxClient } from "./client.ts";
import { FakeCmuxTransport } from "./fake-transport.ts";
import { createCmuxApiSink } from "./sink.ts";

const baseSnapshot: StatusSnapshot = {
  run: {
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
    state: "RUNNING",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:01.000Z",
  },
  eventCount: 4,
  latestEvent: {
    protocolVersion: "1",
    taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    sequence: 3,
    timestamp: "2026-08-08T00:00:01.000Z",
    type: "log",
    payload: { level: "info", message: "working" },
  },
};

describe("createCmuxApiSink", () => {
  it("maps a snapshot to cmux status and progress commands", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });
    const sink = createCmuxApiSink(client, { workspaceId: "ws-test-01" });

    await sink.publish({
      runId: baseSnapshot.run.runId,
      text: "RUNNING run_01 · log #3",
      snapshot: baseSnapshot,
    });

    assert.equal(transport.cliCalls.length, 2);
    const statusCall = transport.cliCalls[0];
    const progressCall = transport.cliCalls[1];
    assert.ok(statusCall);
    assert.ok(progressCall);
    assert.deepEqual(statusCall.slice(0, 4), [
      "set-status",
      "agentd-ws-test-01",
      "RUNNING run_01 · log #3",
      "--workspace",
    ]);
    assert.equal(statusCall[4], "ws-test-01");
    assert.equal(progressCall[0], "set-progress");

    client.close();
  });

  it("notifies once when the run reaches a terminal state", async () => {
    const transport = new FakeCmuxTransport();
    const client = createCmuxClient({ transport });
    const sink = createCmuxApiSink(client, { workspaceId: "ws-test-01" });

    const terminal: StatusSnapshot = {
      ...baseSnapshot,
      run: { ...baseSnapshot.run, state: "SUCCEEDED" },
    };

    await sink.publish({
      runId: terminal.run.runId,
      text: "SUCCEEDED run_01 · log #3",
      snapshot: terminal,
    });
    await sink.publish({
      runId: terminal.run.runId,
      text: "SUCCEEDED run_01 · log #3",
      snapshot: terminal,
    });

    assert.equal(
      transport.rpcCalls.filter((call) => call.method === "notification.create")
        .length,
      1,
    );

    client.close();
  });

  it("surfaces client failures through publish", async () => {
    const sink = createCmuxApiSink(
      {
        createWorkspace: () => Promise.reject(new Error("unused")),
        createSurface: () => Promise.reject(new Error("unused")),
        updateStatus: () =>
          Promise.resolve(err(makeError("INTERNAL", "cmux unavailable"))),
        updateProgress: () => Promise.resolve(ok(undefined)),
        appendLog: () => Promise.resolve(ok(undefined)),
        notify: () => Promise.resolve(ok(undefined)),
        close: () => undefined,
      },
      { workspaceId: "ws-test-01" },
    );

    await assert.rejects(async () => {
      await sink.publish({
        runId: baseSnapshot.run.runId,
        text: "RUNNING",
        snapshot: baseSnapshot,
      });
    }, /cmux unavailable/);
  });
});
