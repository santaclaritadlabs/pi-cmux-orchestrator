import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createUlidFactory,
  createRunId,
  sampleEvent,
  sampleResult,
  sampleTask,
  type AgentEvent,
  type Result,
} from "@pi-cmux/protocol";
import { temporaryDirectory } from "@pi-cmux/testkit";

import { RunStore } from "./run-store.ts";

/** Unwraps a Result in a test, failing loudly with the error if it is not ok. */
function expectOk<T, E>(result: Result<T, E>): T {
  assert.ok(
    result.ok,
    `expected ok, got: ${result.ok ? "" : JSON.stringify(result.error)}`,
  );
  return result.value;
}

/** A store whose run IDs are deterministic, so assertions can name them. */
function storeIn(root: string): RunStore {
  const ulid = createUlidFactory(() => 1_754_000_000_000);
  return new RunStore({
    root,
    now: () => new Date("2026-08-08T05:00:00.000Z"),
    newRunId: () => createRunId(ulid),
  });
}

describe("run creation", () => {
  it("persists the task and starts QUEUED", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);

    const created = await store.create(sampleTask());
    assert.equal(created.ok, true);
    assert.equal(created.value.state, "QUEUED");
    assert.equal(created.value.taskId, "AUTH-41");

    const task = await store.readTask(created.value.runId);
    assert.equal(task.ok, true);
    assert.equal(task.value.objective, sampleTask().objective);
  });

  it("creates the run directory 0700", async () => {
    // The run directory holds task text and worker output. It is the current
    // user's business only.
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const created = await store.create(sampleTask());
    assert.equal(created.ok, true);

    const stats = await stat(store.runDirectory(created.value.runId));
    assert.equal(stats.mode & 0o777, 0o700);
  });

  it("refuses to adopt an existing run directory", async () => {
    await using dir = await temporaryDirectory();
    // A fixed ID, so the second create really does collide. (Two real ULID
    // factories would not: the random component differs even at the same
    // millisecond, which is exactly what makes collisions implausible in
    // practice — but the store must still refuse one if it happens.)
    const fixedId = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";
    const options = { root: dir.path, newRunId: (): string => fixedId };
    const store = new RunStore(options);
    const collidingStore = new RunStore(options);

    assert.equal((await store.create(sampleTask())).ok, true);
    const second = await collidingStore.create(sampleTask());

    assert.equal(second.ok, false);
    assert.equal(second.error.code, "RUN_ALREADY_EXISTS");
  });

  it("lists runs in creation order without opening a file", async () => {
    await using dir = await temporaryDirectory();
    let clock = 1_754_000_000_000;
    const ulid = createUlidFactory(() => clock);
    const store = new RunStore({
      root: dir.path,
      newRunId: () => createRunId(ulid),
    });

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await store.create(sampleTask());
      assert.equal(created.ok, true);
      ids.push(created.value.runId);
      clock += 1_000;
    }

    const listed = await store.listRunIds();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, ids, "ULIDs must sort in creation order");
  });

  it("ignores stray entries in the runs directory", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    assert.equal((await store.create(sampleTask())).ok, true);

    await writeFile(path.join(store.runsDirectory(), ".DS_Store"), "junk");

    const listed = await store.listRunIds();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
  });

  it("reports an empty list before any run exists", async () => {
    await using dir = await temporaryDirectory();
    const listed = await storeIn(dir.path).listRunIds();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, []);
  });
});

describe("state transitions are checked against disk", () => {
  it("advances through the legal path", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    for (const next of [
      "PREPARING",
      "RUNNING",
      "VALIDATING",
      "SUCCEEDED",
    ] as const) {
      const moved = await store.transitionState(runId, next);
      assert.equal(moved.ok, true, `could not reach ${next}`);
      assert.equal(moved.value.state, next);
    }

    assert.equal(expectOk(await store.readState(runId)).state, "SUCCEEDED");
  });

  it("refuses an illegal transition and leaves state untouched", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    const jumped = await store.transitionState(runId, "SUCCEEDED");
    assert.equal(jumped.ok, false);
    assert.equal(jumped.error.code, "INVALID_STATE_TRANSITION");

    assert.equal(expectOk(await store.readState(runId)).state, "QUEUED");
  });

  it("reports a missing run rather than inventing one", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const missing = await store.readState("run_01JQZX3K5T7V9B2N4M6P8R0AWC");
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "RUN_NOT_FOUND");
  });

  it("reports corrupt state instead of repairing it", async () => {
    // A silently repaired run record is a fabricated audit trail.
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    await writeFile(store.runFile(runId, "state"), "{ not json", "utf8");
    const read = await store.readState(runId);

    assert.equal(read.ok, false);
    assert.equal(read.error.code, "STORE_CORRUPT");
  });

  it("rejects a structurally valid but wrong state.json", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    await writeFile(
      store.runFile(runId, "state"),
      JSON.stringify({ runId, taskId: "AUTH-41", state: "PROBABLY_FINE" }),
      "utf8",
    );

    assert.equal((await store.readState(runId)).ok, false);
  });
});

describe("state.json is written atomically", () => {
  it("leaves no temporary files behind", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    await store.transitionState(runId, "PREPARING");

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(store.runDirectory(runId));
    assert.equal(
      entries.some((e) => e.includes(".tmp")),
      false,
      `temporary files survived: ${entries.join(", ")}`,
    );
  });

  it("never leaves a partially written record", async () => {
    // Every intermediate read must yield a complete, parseable record — that
    // is the whole point of rename-based replacement.
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    for (const next of ["PREPARING", "RUNNING"] as const) {
      await store.transitionState(runId, next);
      const raw = await readFile(store.runFile(runId, "state"), "utf8");
      assert.doesNotThrow(() => JSON.parse(raw));
    }
  });
});

describe("event ingestion", () => {
  const events = (count: number, from = 0): AgentEvent[] =>
    Array.from({ length: count }, (_, i) =>
      sampleEvent({
        sequence: from + i,
        type: "log",
        payload: { level: "info", message: `step ${String(from + i)}` },
      }),
    );

  async function seeded(root: string): Promise<{
    store: RunStore;
    runId: string;
  }> {
    const store = storeIn(root);
    const created = await store.create(sampleTask());
    assert.equal(created.ok, true);
    return { store, runId: created.value.runId };
  }

  it("appends and reads back in sequence order", async () => {
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);

    const written = await store.appendEvents(runId, events(3));
    assert.equal(written.ok, true);
    assert.equal(written.value, 3);

    const read = await store.readEvents(runId);
    assert.equal(read.ok, true);
    assert.deepEqual(
      read.value.map((e) => e.sequence),
      [0, 1, 2],
    );
  });

  it("is idempotent: re-appending identical events writes nothing", async () => {
    // This is what lets recovery re-read stdout from a conservative offset.
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);

    assert.equal(expectOk(await store.appendEvents(runId, events(3))), 3);
    assert.equal(expectOk(await store.appendEvents(runId, events(3))), 0);
    assert.equal(expectOk(await store.readEvents(runId)).length, 3);
  });

  it("stays idempotent across a fresh store instance", async () => {
    // The in-memory index must be rebuildable from disk, or a daemon restart
    // would duplicate every event it re-reads.
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);
    await store.appendEvents(runId, events(3));

    const restarted = storeIn(dir.path);
    assert.equal(expectOk(await restarted.appendEvents(runId, events(3))), 0);
    assert.equal(expectOk(await restarted.readEvents(runId)).length, 3);
  });

  it("rejects a duplicate sequence carrying different content", async () => {
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);
    await store.appendEvents(runId, events(2));

    const conflicting = await store.appendEvents(runId, [
      sampleEvent({
        sequence: 1,
        type: "log",
        payload: { level: "warn", message: "different content" },
      }),
    ]);

    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.error.code, "SEQUENCE_CONFLICT");
    assert.equal(conflicting.error.details?.["sequence"], 1);
  });

  it("accepts out-of-order arrival and sorts on read", async () => {
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);

    await store.appendEvents(runId, [
      sampleEvent({ sequence: 5, type: "heartbeat", payload: { uptimeMs: 5 } }),
      sampleEvent({ sequence: 1, type: "heartbeat", payload: { uptimeMs: 1 } }),
      sampleEvent({ sequence: 3, type: "heartbeat", payload: { uptimeMs: 3 } }),
    ]);

    const read = expectOk(await store.readEvents(runId));
    assert.deepEqual(
      read.map((e) => e.sequence),
      [1, 3, 5],
    );
  });

  it("filters by sinceSequence for streaming reconnects", async () => {
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);
    await store.appendEvents(runId, events(5));

    const tail = expectOk(await store.readEvents(runId, 2));
    assert.deepEqual(
      tail.map((e) => e.sequence),
      [3, 4],
    );
  });

  it("survives a torn final record", async () => {
    // A killed worker leaves exactly this. One bad line must not make the
    // whole run unreadable.
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);
    await store.appendEvents(runId, events(2));

    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      store.runFile(runId, "events"),
      '{"protocolVersion":"1","sequ',
    );

    const read = await store.readEvents(runId);
    assert.equal(read.ok, true);
    assert.equal(read.value.length, 2);
  });

  it("returns an empty log for a run that has emitted nothing", async () => {
    await using dir = await temporaryDirectory();
    const { store, runId } = await seeded(dir.path);
    const read = await store.readEvents(runId);
    assert.equal(read.ok, true);
    assert.deepEqual(read.value, []);
  });
});

describe("terminal result", () => {
  it("accepts exactly one", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    const result = sampleResult({ runId });

    assert.equal((await store.writeResult(runId, result)).ok, true);

    const second = await store.writeResult(runId, result);
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "DUPLICATE_TERMINAL_RESULT");
  });

  it("reads the result back", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    await store.writeResult(runId, sampleResult({ runId }));

    const read = await store.readResult(runId);
    assert.equal(read.ok, true);
    assert.equal(read.value.status, "succeeded");
  });

  it("rejects a result that no longer validates", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    await writeFile(
      store.runFile(runId, "result"),
      JSON.stringify({ ...sampleResult({ runId }), executeThis: "rm -rf /" }),
      "utf8",
    );

    const read = await store.readResult(runId);
    assert.equal(read.ok, false);
    assert.equal(read.error.code, "STORE_CORRUPT");
  });
});

describe("metadata", () => {
  it("starts with no pid and an empty stream offset", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    const metadata = await store.readMetadata(runId);
    assert.equal(metadata.ok, true);
    assert.equal(metadata.value.pid, undefined);
    assert.equal(metadata.value.stdoutOffset, 0);
    assert.equal(metadata.value.lastSequence, -1);
    assert.equal(metadata.value.workerKind, "fake");
  });

  it("records the pid together with its start time", async () => {
    // Both, always: a pid alone cannot survive pid reuse across a restart.
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    const updated = await store.updateMetadata(runId, {
      pid: 4711,
      processStartedAtMs: 1_754_000_000_000,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.value.pid, 4711);

    const reread = expectOk(await store.readMetadata(runId));
    assert.equal(reread.processStartedAtMs, 1_754_000_000_000);
    // Unpatched fields survive.
    assert.equal(reread.workerKind, "fake");
  });
});

describe("run lock", () => {
  it("is exclusive", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    const owner = { pid: 1234, startedAtMs: 1_754_000_000_000 };

    assert.equal((await store.acquireLock(runId, owner)).ok, true);

    const second = await store.acquireLock(runId, {
      pid: 5678,
      startedAtMs: 1,
    });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "RUN_LOCKED");
    // Retryable: the holder may release it.
    assert.equal(second.error.retryable, true);
  });

  it("can be reacquired after release", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    const owner = { pid: 1234, startedAtMs: 1 };

    await store.acquireLock(runId, owner);
    assert.equal((await store.releaseLock(runId)).ok, true);
    assert.equal((await store.acquireLock(runId, owner)).ok, true);
  });

  it("treats releasing an absent lock as success", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));

    assert.equal((await store.releaseLock(runId)).ok, true);
  });

  it("records the owner so a stale lock is identifiable", async () => {
    await using dir = await temporaryDirectory();
    const store = storeIn(dir.path);
    const { runId } = expectOk(await store.create(sampleTask()));
    await store.acquireLock(runId, {
      pid: 4711,
      startedAtMs: 1_754_000_000_000,
    });

    const raw = await readFile(store.runFile(runId, "lock"), "utf8");
    const owner = JSON.parse(raw) as { pid: number; startedAtMs: number };
    assert.equal(owner.pid, 4711);
    assert.equal(owner.startedAtMs, 1_754_000_000_000);
  });
});
