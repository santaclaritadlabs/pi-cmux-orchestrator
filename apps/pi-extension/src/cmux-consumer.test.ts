import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ok } from "@pi-cmux/protocol";
import type { StatusSnapshot } from "./index.ts";

import { CmuxStatusConsumer, createCmuxTextSink } from "./cmux-consumer.ts";

const snapshot: StatusSnapshot = {
  run: {
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
    state: "SUCCEEDED",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:01.000Z",
  },
  eventCount: 0,
};

describe("CmuxStatusConsumer", () => {
  it("publishes a formatted projection and does not own lifecycle", async () => {
    const messages: string[] = [];
    const consumer = new CmuxStatusConsumer(
      {
        watch: (_runId, options) =>
          Promise.resolve(options.onSnapshot(snapshot)).then(() =>
            ok(undefined),
          ),
      },
      createCmuxTextSink({
        write: (text) => {
          messages.push(text);
        },
      }),
    );

    const result = await consumer.follow(snapshot.run.runId);
    assert.equal(result.ok, true);
    assert.deepEqual(messages, [
      "SUCCEEDED run_01JQZX3K5T7V9B2N4M6P8R0AWC · no events\n",
    ]);
  });

  it("rejects an empty run id before calling the bridge", async () => {
    let called = false;
    const consumer = new CmuxStatusConsumer(
      {
        watch: () => {
          called = true;
          return Promise.resolve(ok(undefined));
        },
      },
      { publish: () => undefined },
    );
    const result = await consumer.follow("");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SCHEMA_INVALID");
    assert.equal(called, false);
  });

  it("isolates a publish failure instead of stopping the watch loop", async () => {
    let snapshotsSeen = 0;
    const errors: unknown[] = [];
    const consumer = new CmuxStatusConsumer(
      {
        watch: async (_runId, options) => {
          // Two snapshots in one watch: the first publish throws, the
          // second must still run — proving the loop survived the first.
          await options.onSnapshot(snapshot);
          await options.onSnapshot(snapshot);
          return ok(undefined);
        },
      },
      {
        publish: () => {
          snapshotsSeen += 1;
          if (snapshotsSeen === 1) throw new Error("cmux socket down");
        },
      },
    );

    const result = await consumer.follow(snapshot.run.runId, {
      onPublishError: (error) => errors.push(error),
    });
    assert.equal(result.ok, true);
    assert.equal(snapshotsSeen, 2);
    assert.equal(errors.length, 1);
  });
});
