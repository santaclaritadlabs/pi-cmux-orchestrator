/**
 * The fake worker.
 *
 * P1 supervises this process for real: a real `spawn`, real file descriptors,
 * real signals, real exit codes. Only the *provider* is fake. That is what lets
 * cancellation, timeout escalation and restart recovery be tested end to end
 * with no network, no credentials, and no provider CLI — and it is the same
 * process the fake adapter drives.
 *
 * Every failure mode here maps to a case CLAUDE.md requires covered:
 * malformed NDJSON, partial records, duplicate and out-of-order events,
 * oversized output, a missing terminal event, and a hung process.
 *
 * Run: `node packages/testkit/dist/replay.js --emit 5 --delay-ms 10`
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  encodeJsonLine,
  type AgentEvent,
  PROTOCOL_VERSION,
} from "@pi-cmux/protocol";

import { parseReplayOptions, type ReplayOptions } from "./replay-options.ts";

function write(text: string): void {
  process.stdout.write(text);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeEvent(
  options: ReplayOptions,
  sequence: number,
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: options.taskId,
    runId: options.runId,
    sequence,
    // A fixed timestamp would make ordering tests vacuous; a real one exercises
    // the same formatting path the adapters use.
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

function emitEvent(event: AgentEvent): void {
  const encoded = encodeJsonLine(event);
  if (encoded.ok) write(encoded.value);
}

/** Replays a fixture file line by line, byte-for-byte. */
async function replayFixture(path: string, delayMs: number): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  // `crlfDelay: Infinity` so a CRLF fixture is not split mid-record.
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    write(`${line}\n`);
    await sleep(delayMs);
  }
}

async function emitSynthetic(options: ReplayOptions): Promise<void> {
  let sequence = 0;

  emitEvent(makeEvent(options, sequence, "status", { state: "RUNNING" }));
  sequence += 1;

  for (let i = 0; i < options.emit; i += 1) {
    await sleep(options.delayMs);

    emitEvent(
      makeEvent(options, sequence, "log", {
        level: "info",
        message: `step ${String(i + 1)} of ${String(options.emit)}`,
      }),
    );

    if (options.duplicateSequence && i === 0) {
      // Same sequence, different content: the store must treat this as a
      // conflict, not as an idempotent retry.
      emitEvent(
        makeEvent(options, sequence, "log", {
          level: "warn",
          message: "duplicate sequence with different content",
        }),
      );
    }

    sequence += 1;
  }

  if (options.outOfOrder) {
    emitEvent(
      makeEvent(options, sequence + 5, "log", {
        level: "info",
        message: "from the future",
      }),
    );
    emitEvent(
      makeEvent(options, sequence, "log", {
        level: "info",
        message: "back in order",
      }),
    );
    sequence += 6;
  }

  for (let i = 0; i < options.malformedLines; i += 1) {
    // Three distinct shapes of broken: truncated object, wrong quoting, and
    // plain prose. Providers have emitted all three.
    write("{ this is not json\n");
    write("{'single': 'quotes'}\n");
    write("Traceback (most recent call last):\n");
  }

  if (options.floodBytes > 0) {
    const chunk = "x".repeat(1024);
    let written = 0;
    while (written < options.floodBytes) {
      emitEvent(
        makeEvent(options, sequence, "log", { level: "debug", message: chunk }),
      );
      sequence += 1;
      written += chunk.length;
    }
  }

  if (!options.noTerminalEvent) {
    emitEvent(
      makeEvent(options, sequence, "status", {
        state: "VALIDATING",
        detail: "worker finished",
      }),
    );
  }

  if (options.partialLine) {
    // No trailing newline: exactly what a killed process leaves behind.
    write('{"protocolVersion":"1","taskId":"AUTH-41","sequ');
  }
}

async function main(): Promise<number> {
  const parsed = parseReplayOptions(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`replay: ${parsed.error}\n`);
    return 64; // EX_USAGE
  }
  const options = parsed.value;

  if (options.ignoreSigterm) {
    // An empty handler is what makes SIGTERM survivable: the supervisor must
    // escalate to SIGKILL, which cannot be trapped.
    process.on("SIGTERM", () => undefined);
    process.on("SIGINT", () => undefined);
  }

  if (options.stderr !== undefined) {
    process.stderr.write(`${options.stderr}\n`);
  }

  await sleep(options.startupDelayMs);

  if (options.fixture !== undefined) {
    await replayFixture(options.fixture, options.delayMs);
  } else {
    await emitSynthetic(options);
  }

  if (options.hang) {
    // Stay alive without burning CPU, so a test can assert the process is
    // still running and then observe it being killed.
    await new Promise<never>(() => {
      setInterval(() => undefined, 1_000);
    });
  }

  return options.exitCode;
}

process.exitCode = await main();
