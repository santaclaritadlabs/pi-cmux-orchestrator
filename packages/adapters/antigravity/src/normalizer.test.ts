import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertSurvivesAdversarialCorpus,
  providerAdversarialFixtures,
  readFixture,
} from "@pi-cmux/testkit";

import {
  AntigravityEventNormalizer,
  normalizeAntigravityStream,
  type AntigravityNormalizerOptions,
} from "./normalizer.ts";

const OPTIONS: AntigravityNormalizerOptions = {
  taskId: "AUTH-41",
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  startSequence: 7,
  now: () => new Date("2026-08-08T05:00:00.000Z"),
};

describe("AntigravityEventNormalizer", () => {
  it("normalizes a real `agy --output-format stream-json` transcript (no tool calls)", async () => {
    // Captured 2026-08-08 by running the installed `agy` v1.1.11 binary with
    // stdout redirected to a plain file — agentd's actual spawn model.
    const raw = await readFixture("antigravity", "captured-example.ndjson");
    const batch = normalizeAntigravityStream(raw, OPTIONS);

    // init, user_input, an untyped "unknown" step, a checkpoint, and result
    // are all transport/session bookkeeping this adapter does not surface.
    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 5);
    assert.equal(batch.events.length, 1);
    assert.deepEqual(
      batch.events.map((event) => [event.sequence, event.type]),
      [[7, "log"]],
    );
    assert.deepEqual(batch.events[0]?.payload, {
      level: "info",
      message: "pong\n",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("normalizes a real transcript with a denied tool call (state: ERROR)", async () => {
    // Captured the same way. This is the transcript that caught the bug: the
    // documented schema only mentions ACTIVE/DONE, but a denied tool call
    // reports state "ERROR" — a value that must still produce a completed
    // tool event plus an error log, not fall through to `rejected`.
    const raw = await readFixture(
      "antigravity",
      "captured-tool-error-example.ndjson",
    );
    const batch = normalizeAntigravityStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    // init, user_input, "unknown", a text-less agent_response, and result.
    assert.equal(batch.ignored, 5);
    assert.equal(batch.events.length, 3);
    assert.deepEqual(
      batch.events.map((event) => [event.sequence, event.type]),
      [
        [7, "tool"],
        [8, "tool"],
        [9, "log"],
      ],
    );
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "started",
      callId: "3",
      tool: "run_command",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "completed",
      callId: "3",
      tool: "run_command",
      durationMs: 13,
    });
    assert.deepEqual(batch.events[2]?.payload, {
      level: "error",
      message: "User denied permission to run command:\npwd",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("maps a failed tool step to a completed tool event plus an error log, without leaking raw fields", () => {
    const raw = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv_1",
          step_index: 3,
          state: "DONE",
          step_type: "tool",
          tool_name: "write_file",
          vendor_extra: "must disappear",
          tool_info: {
            name: "write_file",
            parameters: { path: "/etc/shadow" },
            error: {
              type: "PERMISSION_DENIED",
              message: "AUTH_TOKEN=abc123 leaked in output",
            },
          },
        },
      }),
    ].join("\n");

    const batch = normalizeAntigravityStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.equal(batch.events.length, 2);
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "completed",
      callId: "3",
      tool: "write_file",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      level: "error",
      message: "[REDACTED:env-assignment] leaked in output",
    });
    for (const event of batch.events) {
      assert.equal("vendor_extra" in event.payload, false);
      assert.equal("parameters" in event.payload, false);
    }
  });

  it("ignores an unrecognized step_type for forward compatibility", () => {
    const raw = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv_1",
        step_index: 4,
        state: "DONE",
        step_type: "future_step_kind",
      },
    });

    const batch = normalizeAntigravityStream(raw, OPTIONS);
    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 1);
    assert.equal(batch.events.length, 0);
  });

  it("rejects a tool step with no tool identifier", () => {
    const raw = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv_1",
        step_index: 5,
        state: "ACTIVE",
        step_type: "tool",
      },
    });

    const batch = normalizeAntigravityStream(raw, OPTIONS);
    assert.equal(batch.rejected, 1);
    assert.equal(batch.events.length, 0);
  });

  it("rejects invalid JSON and continues past it", () => {
    const normalizer = new AntigravityEventNormalizer(OPTIONS);
    const batch = normalizer.push("{ this is not json\n");
    const tail = normalizer.finish();
    assert.equal(batch.rejected + tail.rejected, 1);
    assert.equal(batch.events.length + tail.events.length, 0);
  });
});

describe("adversarial corpus (Task 11)", () => {
  it("survives hardened adversarial fixtures", async () => {
    await assertSurvivesAdversarialCorpus(
      (raw) => normalizeAntigravityStream(raw, OPTIONS),
      providerAdversarialFixtures("antigravity"),
      { hardened: true },
    );
  });
});
