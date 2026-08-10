import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeJsonLine,
  parseAgentEvent,
  type AgentEvent,
} from "@pi-cmux/protocol";

import {
  assertHardenedAdversarialBatch,
  assertSurvivesAdversarialCorpus,
  type AdversarialNormalizeBatch,
} from "./adversarial.ts";
import { ADVERSARIAL_FIXTURES, splitLines } from "./fixtures.ts";

function readProtocolStream(raw: string): AdversarialNormalizeBatch {
  const events: AgentEvent[] = [];
  let rejected = 0;

  for (const line of splitLines(raw)) {
    const decoded = decodeJsonLine(line);
    if (!decoded.ok) {
      rejected += 1;
      continue;
    }
    const event = parseAgentEvent(decoded.value);
    if (!event.ok) {
      rejected += 1;
      continue;
    }
    events.push(event.value);
  }

  return { events, rejected };
}

describe("assertSurvivesAdversarialCorpus", () => {
  it("passes for the protocol-level reference reader on every shared fixture", async () => {
    await assertSurvivesAdversarialCorpus(
      readProtocolStream,
      ADVERSARIAL_FIXTURES,
    );
  });

  it("fails hardened checks when path traversals leak through", () => {
    const batch: AdversarialNormalizeBatch = {
      events: [
        {
          protocolVersion: "1",
          taskId: "AUTH-41",
          runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
          sequence: 0,
          timestamp: "2026-08-08T05:00:00.000Z",
          type: "tool",
          payload: { path: "../../../etc/passwd" },
        },
      ],
      rejected: 0,
    };

    assert.throws(() => {
      assertHardenedAdversarialBatch("malicious-paths-codex.ndjson", batch);
    }, /path traversals must not appear/);
  });
});
