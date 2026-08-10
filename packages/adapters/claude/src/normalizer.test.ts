import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEventPayload } from "@pi-cmux/protocol";
import {
  assertSurvivesAdversarialCorpus,
  providerAdversarialFixtures,
  readFixture,
} from "@pi-cmux/testkit";

import {
  ClaudeEventNormalizer,
  normalizeClaudeStream,
  type ClaudeNormalizerOptions,
} from "./normalizer.ts";

const OPTIONS: ClaudeNormalizerOptions = {
  taskId: "AUTH-41",
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  startSequence: 7,
  now: () => new Date("2026-08-08T05:00:00.000Z"),
};

describe("ClaudeEventNormalizer", () => {
  it("normalizes the documented Claude Code stream-json example", async () => {
    const raw = await readFixture("claude", "official-doc-example.ndjson");
    const batch = normalizeClaudeStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    // system/init and the terminal result are ignored transport records.
    assert.equal(batch.ignored, 2);
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
      callId: "toolu_1",
      tool: "Bash",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "completed",
      callId: "toolu_1",
      tool: "Bash",
    });
    assert.deepEqual(batch.events[2]?.payload, {
      level: "info",
      message: "Repo contains docs, sdk, and examples directories.",
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("normalizes a real `claude -p --output-format stream-json` transcript (no tool calls)", async () => {
    // Captured 2026-08-08 by running the installed `claude` CLI v2.1.226
    // with stdout redirected to a plain file — agentd's actual spawn model.
    const raw = await readFixture("claude", "captured-example.ndjson");
    const batch = normalizeClaudeStream(raw, OPTIONS);

    // system/init, a rate_limit_event, and the terminal result are all
    // transport/session bookkeeping this adapter does not surface.
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

  it("normalizes a real transcript with a tool call (thinking block, tool_use, tool_result)", async () => {
    // Captured the same way; this run asked Claude to write a file via its
    // own Write tool, exercising the real tool_use/tool_result correlation
    // and confirming a live `thinking` content block is ignored, not
    // rejected.
    const raw = await readFixture(
      "claude",
      "captured-tool-call-example.ndjson",
    );
    const batch = normalizeClaudeStream(raw, OPTIONS);

    // system/init, a thinking block, a rate_limit_event, and the terminal
    // result.
    assert.equal(batch.rejected, 0);
    assert.equal(batch.ignored, 4);
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
      callId: "toolu_0173SGXcLUsdHiCzWJDJwKbL",
      tool: "Write",
    });
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "completed",
      callId: "toolu_0173SGXcLUsdHiCzWJDJwKbL",
      tool: "Write",
    });
    assert.deepEqual(batch.events[2]?.payload, {
      level: "info",
      message: 'Done — created verify.txt with the content "hello-verify".',
    });
    assert.equal(batch.pendingBytes, 0);
    assert.equal(batch.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("names a tool_result by the tool_use it correlates with and redacts leaked secrets", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_9",
              name: "Bash",
              input: { command: "cat /private/secret" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          id: "msg_2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: "token=sk-proj-abcdefghijklmnop1234567890",
              is_error: false,
            },
          ],
        },
      }),
    ].join("\n");

    const batch = normalizeClaudeStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.deepEqual(batch.events[1]?.payload, {
      phase: "completed",
      callId: "toolu_9",
      tool: "Bash",
    });

    // tool_result *content* is not persisted into the event at all — only
    // the correlating id and the remembered tool name are. This assertion
    // still guards against a future change accidentally forwarding it.
    const normalized = JSON.stringify(batch.events);
    assert.equal(normalized.includes("/private/secret"), false);
    assert.equal(normalized.includes("sk-proj-"), false);
  });

  it("falls back to 'unknown' for a tool_result with no matching tool_use", () => {
    const raw = JSON.stringify({
      type: "user",
      message: {
        id: "msg_1",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_orphan", content: "x" },
        ],
      },
    });

    const batch = normalizeClaudeStream(raw, OPTIONS);

    assert.equal(batch.rejected, 0);
    assert.deepEqual(batch.events[0]?.payload, {
      phase: "completed",
      callId: "toolu_orphan",
      tool: "unknown",
    });
  });

  it("ignores future block/message types but rejects malformed known records", () => {
    const raw = [
      JSON.stringify({ type: "future.transport.event", payload: "opaque" }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "private" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { id: "m2", role: "assistant", content: [{ type: "text" }] },
      }),
      JSON.stringify({ type: "assistant" }),
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m3",
          role: "assistant",
          content: [{ type: "text", text: "survives" }],
        },
      }),
    ].join("\n");

    const batch = normalizeClaudeStream(raw, OPTIONS);

    // ignored: the unknown envelope type, and the `thinking` content block.
    assert.equal(batch.ignored, 2);
    // rejected: a `text` block missing `text`, an `assistant` record missing
    // `message`, and the framing-level "not json" line.
    assert.equal(batch.rejected, 3);
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0]?.payload["message"], "survives");
  });

  it("preserves partial records across reads and allocates contiguous sequences", () => {
    const normalizer = new ClaudeEventNormalizer(OPTIONS);
    const first = normalizer.push(
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":',
    );

    assert.equal(first.events.length, 0);
    assert.equal(first.rejected, 0);
    assert.ok(first.pendingBytes > 0);
    assert.equal(first.offset, 0);

    const second = normalizer.push(
      '"first"}]}}\n' +
        '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"second"}]}}\n',
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
    const raw = await readFixture("claude", "official-doc-example.ndjson");
    const batch = normalizeClaudeStream(raw, OPTIONS);

    for (const event of batch.events) {
      assert.equal(parseEventPayload(event).ok, true);
    }
  });
});

describe("adversarial corpus (Task 9)", () => {
  it("survives hardened adversarial fixtures", async () => {
    await assertSurvivesAdversarialCorpus(
      (raw) => normalizeClaudeStream(raw, OPTIONS),
      providerAdversarialFixtures("claude"),
      { hardened: true },
    );
  });
});
