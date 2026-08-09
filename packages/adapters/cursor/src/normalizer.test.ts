import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEventPayload } from "@pi-cmux/protocol";
import { readFixture } from "@pi-cmux/testkit";

import {
  CursorEventNormalizer,
  normalizeCursorStream,
  type CursorNormalizerOptions,
} from "./normalizer.ts";

const OPTIONS: CursorNormalizerOptions = {
  taskId: "AUTH-41",
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  startSequence: 7,
  now: () => new Date("2026-08-08T05:00:00.000Z"),
};

describe("CursorEventNormalizer", () => {
  it("normalizes the documented Cursor stream-json example", async () => {
    const raw = await readFixture("cursor", "official-doc-example.ndjson");
    const batch = normalizeCursorStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 3);
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
      callId: "toolu_01",
      tool: "readToolCall",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "completed",
      callId: "toolu_01",
      tool: "readToolCall",
    });
    assert.deepEqual(batch.events[2]?.payload, {
      level: "info",
      message: "Found 2 TODO comments: README.md:12 and src/index.ts:4.",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("maps tool calls and provider failures without leaking raw fields", () => {
    const raw = [
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "toolu_2",
        tool_call: {
          writeToolCall: {
            args: { path: "secrets.env", contents: "token=secret" },
          },
          result: { success: true, aggregated_output: "token=secret" },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "provider unavailable: sk-proj-abcdefghijklmnop1234567890",
      }),
    ].join("\n");

    const batch = normalizeCursorStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "completed",
      callId: "toolu_2",
      tool: "writeToolCall",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      level: "error",
      message: "provider unavailable: [REDACTED:openai]",
    });

    const normalized = JSON.stringify(batch.events);
    assert.equal(normalized.includes("secrets.env"), false);
    assert.equal(normalized.includes("token=secret"), false);
    assert.equal(normalized.includes("sk-proj-"), false);
  });

  it("ignores future types but rejects malformed known records", () => {
    const raw = [
      JSON.stringify({ type: "future.transport.event", payload: "opaque" }),
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "toolu_3",
        tool_call: { result: { success: true } },
      }),
      JSON.stringify({ type: "assistant" }),
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "survives" }],
        },
      }),
    ].join("\n");

    const batch = normalizeCursorStream(raw, OPTIONS);

    assert.equal(batch.ignored, 1);
    assert.equal(batch.rejected, 3);
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0]?.payload["message"], "survives");
  });

  it("preserves partial records across reads and allocates contiguous sequences", () => {
    const normalizer = new CursorEventNormalizer(OPTIONS);
    const first = normalizer.push(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":',
    );

    assert.equal(first.events.length, 0);
    assert.equal(first.rejected, 0);
    assert.ok(first.pendingBytes > 0);
    assert.equal(first.offset, 0);

    const second = normalizer.push(
      '"first"}]}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}\n',
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
    const raw = await readFixture("cursor", "official-doc-example.ndjson");
    const batch = normalizeCursorStream(raw, OPTIONS);

    for (const event of batch.events) {
      assert.equal(parseEventPayload(event).ok, true);
    }
  });
});
