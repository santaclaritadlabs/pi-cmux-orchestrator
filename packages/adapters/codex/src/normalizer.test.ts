import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEventPayload } from "@pi-cmux/protocol";
import { readFixture } from "@pi-cmux/testkit";

import {
  CodexEventNormalizer,
  normalizeCodexStream,
  type CodexNormalizerOptions,
} from "./normalizer.ts";

const OPTIONS: CodexNormalizerOptions = {
  taskId: "AUTH-41",
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  startSequence: 7,
  now: () => new Date("2026-08-08T05:00:00.000Z"),
};

describe("CodexEventNormalizer", () => {
  it("normalizes the documented Codex JSONL example", async () => {
    const raw = await readFixture("codex", "official-doc-example.ndjson");
    const batch = normalizeCodexStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 3);
    assert.equal(batch.events.length, 2);
    assert.deepEqual(
      batch.events.map((event) => [event.sequence, event.type]),
      [
        [7, "tool"],
        [8, "log"],
      ],
    );
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "started",
      callId: "item_1",
      tool: "shell",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      level: "info",
      message: "Repo contains docs, sdk, and examples directories.",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("maps completed tools and provider failures without leaking raw fields", () => {
    const raw = [
      JSON.stringify({
        type: "item.completed",
        vendor_extra: "must disappear",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "cat /private/secret",
          aggregated_output: "token=secret",
          exit_code: 17,
        },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: "provider unavailable: sk-proj-abcdefghijklmnop1234567890",
          code: "native_code",
        },
      }),
    ].join("\n");

    const batch = normalizeCodexStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "completed",
      callId: "cmd_1",
      tool: "shell",
      exitCode: 17,
    });
    assert.deepEqual(batch.events[1]?.payload, {
      level: "error",
      message: "provider unavailable: [REDACTED:openai]",
    });

    const normalized = JSON.stringify(batch.events);
    assert.equal(normalized.includes("/private/secret"), false);
    assert.equal(normalized.includes("token=secret"), false);
    assert.equal(normalized.includes("native_code"), false);
    assert.equal(normalized.includes("sk-proj-"), false);
  });

  it("ignores future types and private reasoning but rejects malformed known records", () => {
    const raw = [
      JSON.stringify({ type: "future.transport.event", payload: "opaque" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "reason_1", type: "reasoning", text: "private" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "future_1", type: "new_item_kind" },
      }),
      JSON.stringify({ type: "item.completed" }),
      "not json",
      JSON.stringify({
        type: "item.completed",
        item: { id: "message_1", type: "agent_message", text: "survives" },
      }),
    ].join("\n");

    const batch = normalizeCodexStream(raw, OPTIONS);

    assert.equal(batch.ignored, 3);
    assert.equal(batch.rejected, 2);
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0]?.payload["message"], "survives");
  });

  it("preserves partial records across reads and allocates contiguous sequences", () => {
    const normalizer = new CodexEventNormalizer(OPTIONS);
    const first = normalizer.push(
      '{"type":"item.completed","item":{"id":"one","type":"agent_message","text":',
    );

    assert.equal(first.events.length, 0);
    assert.equal(first.rejected, 0);
    assert.ok(first.pendingBytes > 0);
    assert.equal(first.offset, 0);

    const second = normalizer.push(
      '"first"}}\n' +
        '{"type":"item.completed","item":{"id":"two","type":"agent_message","text":"second"}}\n',
    );

    assert.deepEqual(
      second.events.map((event) => event.sequence),
      [7, 8],
    );
    assert.deepEqual(
      second.events.map((event) => event.payload["message"]),
      ["first", "second"],
    );
  });

  it("produces payloads accepted by the normalized protocol", async () => {
    const raw = await readFixture("codex", "official-doc-example.ndjson");
    const batch = normalizeCodexStream(raw, OPTIONS);

    for (const event of batch.events) {
      assert.equal(parseEventPayload(event).ok, true);
    }
  });
});
