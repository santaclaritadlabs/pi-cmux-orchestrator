import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  makeError,
  sampleTask,
  type AgentEvent,
  type AgentResult,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import type { DaemonClient } from "@pi-cmux/agentd";

import { formatStatus, PiAgentdBridge } from "./index.ts";

const run = {
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
  state: "RUNNING" as const,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:01.000Z",
};

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

describe("PiAgentdBridge", () => {
  it("validates task, run, result, and event responses", async () => {
    const event: AgentEvent = {
      protocolVersion: "1",
      taskId: run.taskId,
      runId: run.runId,
      sequence: 0,
      timestamp: "2026-08-08T00:00:01.000Z",
      type: "status",
      payload: { state: "running" },
    };
    const result: AgentResult = {
      protocolVersion: "1",
      taskId: run.taskId,
      runId: run.runId,
      status: "succeeded",
      summary: "done",
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes: { worktreePath: "/tmp/worktree", dirty: false },
      warnings: [],
    };
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({
        "task.create": run,
        "task.start": run,
        "daemon.health": { status: "ok", pid: 42, liveRuns: 1, uptimeMs: 1234 },
        "task.status": run,
        "task.cancel": { ...run, state: "CANCELLED" },
        "task.result": result,
        "task.events": [event],
      }),
    );
    assert.equal((await bridge.createTask(sampleTask())).ok, true);
    assert.equal((await bridge.createAndStart(sampleTask())).ok, true);
    const health = await bridge.health();
    assert.ok(health.ok);
    assert.equal(health.value.pid, 42);
    assert.equal((await bridge.start(run.runId)).ok, true);
    assert.equal((await bridge.result(run.runId)).ok, true);
    const snapshot = await bridge.snapshot(run.runId);
    assert.ok(snapshot.ok);
    assert.equal(snapshot.value.latestEvent?.sequence, 0);
    assert.equal(
      formatStatus(snapshot.value),
      "RUNNING run_01JQZX3K5T7V9B2N4M6P8R0AWC · status #0",
    );
  });

  it("rejects malformed daemon payloads instead of exposing unknown data", async () => {
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({ "task.status": { runId: "not-a-record" } }),
    );
    const response = await bridge.status(run.runId);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "RPC_MALFORMED");
  });

  it("rejects event pages that do not match the requested run or sequence", async () => {
    const event: AgentEvent = {
      protocolVersion: "1",
      taskId: run.taskId,
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWD",
      sequence: 0,
      timestamp: "2026-08-08T00:00:01.000Z",
      type: "heartbeat",
      payload: { uptimeMs: 1 },
    };
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({ "task.events": [event] }),
    );
    const response = await bridge.events(run.runId);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "RPC_MALFORMED");
  });

  it("returns a Result when a status consumer throws", async () => {
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({
        "task.status": { ...run, state: "SUCCEEDED" },
        "task.events": [],
      }),
    );
    const response = await bridge.watch(run.runId, {
      onSnapshot: () => {
        throw new Error("pane closed");
      },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INTERNAL");
  });

  it("offers a cancellable status watch for Pi/cmux consumers", async () => {
    const event: AgentEvent = {
      protocolVersion: "1",
      taskId: run.taskId,
      runId: run.runId,
      sequence: 0,
      timestamp: "2026-08-08T00:00:01.000Z",
      type: "heartbeat",
      payload: { state: "running" },
    };
    const controller = new AbortController();
    let updates = 0;
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({ "task.status": run, "task.events": [event] }),
    );
    const watched = await bridge.watch(run.runId, {
      intervalMs: 25,
      signal: controller.signal,
      onSnapshot: () => {
        updates += 1;
        controller.abort();
      },
    });
    assert.equal(watched.ok, true);
    assert.equal(updates, 1);
  });
});
