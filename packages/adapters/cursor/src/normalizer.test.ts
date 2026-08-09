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
  it("normalizes a real `cursor-agent -p --output-format stream-json` transcript (no tool calls)", async () => {
    // Captured 2026-08-08 by running the installed `cursor-agent` (agent
    // 2026.08.04-aaa8809) binary with stdout redirected to a plain file —
    // agentd's actual spawn model, never a pty.
    const raw = await readFixture("cursor", "captured-example.ndjson");
    const batch = normalizeCursorStream(raw, OPTIONS);

    // system/init, the echoed user record, and a non-error result are all
    // transport bookkeeping this adapter does not surface.
    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 3);
    assert.equal(batch.events.length, 1);
    assert.deepEqual(
      batch.events.map((event) => [event.sequence, event.type]),
      [[7, "log"]],
    );
    assert.deepEqual(batch.events[0]?.payload, {
      level: "info",
      message: "pong",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("normalizes a real transcript with parallel tool calls, confirming the shellToolCall/readToolCall variant keys", async () => {
    // Captured the same way, from a prompt that triggers a shell command and
    // a file read in parallel. This is the transcript that confirmed the
    // `tool_call.tool_call` variant-key set beyond the two documented ones
    // (readToolCall, writeToolCall): a real run also emits `shellToolCall`.
    // It also confirmed a `"thinking"` event type the docs don't mention,
    // which the generic default-case fallthrough already treats as ignored
    // rather than rejected — no normalizer change was needed for either.
    const raw = await readFixture(
      "cursor",
      "captured-parallel-tool-calls-example.ndjson",
    );
    const batch = normalizeCursorStream(raw, OPTIONS);

    // system/init, the echoed user record, 16 "thinking" deltas/completion,
    // and a non-error result are all ignored.
    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 19);
    assert.equal(batch.events.length, 5);
    assert.deepEqual(
      batch.events.map((event) => [event.sequence, event.type]),
      [
        [7, "tool"],
        [8, "tool"],
        [9, "tool"],
        [10, "tool"],
        [11, "log"],
      ],
    );
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "started",
      callId: "chatcmpl-tool-6ad586309b774fbba1673b4998bd7eb5",
      tool: "shellToolCall",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "started",
      callId: "chatcmpl-tool-1e349c8c75464af59f15e368555063a9",
      tool: "readToolCall",
    });
    assert.deepEqual(batch.events[2]?.payload, {
      phase: "completed",
      callId: "chatcmpl-tool-1e349c8c75464af59f15e368555063a9",
      tool: "readToolCall",
    });
    assert.deepEqual(batch.events[3]?.payload, {
      phase: "completed",
      callId: "chatcmpl-tool-6ad586309b774fbba1673b4998bd7eb5",
      tool: "shellToolCall",
    });
    assert.deepEqual(batch.events[4]?.payload, {
      level: "info",
      message:
        "Here's what I found:\n\n**Directory listing** (`ls -la`):\n- `err1.log` (0 bytes)\n- `err2.log` (0 bytes)\n- `out1.ndjson` (924 bytes)\n- `out2.ndjson` (5530 bytes)\n- `sample.txt` (23 bytes)\n\n**Contents of `sample.txt`**:\n\nThe file contains a single line:\n\n```\nhello from a test file\n```\n\nThat's it — just a greeting message followed by a trailing newline.",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

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
