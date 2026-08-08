import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import {
  decodeJsonLine,
  parseAgentEvent,
  parseAgentResult,
} from "@pi-cmux/protocol";

import { replayWorkerPath } from "./harness.ts";
import { parseReplayOptions } from "./replay-options.ts";

type RunOutcome = Readonly<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

/** Spawns the fake worker with an argv array — never a shell string. */
function runWorker(
  args: readonly string[],
  onSpawn?: (kill: (signal: NodeJS.Signals) => void) => void,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [replayWorkerPath(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    onSpawn?.((signal) => child.kill(signal));
  });
}

function validEvents(stdout: string): number {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeJsonLine(line))
    .filter((decoded) => decoded.ok && parseAgentEvent(decoded.value).ok)
    .length;
}

function validResults(stdout: string): number {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeJsonLine(line))
    .filter((decoded) => decoded.ok && parseAgentResult(decoded.value).ok)
    .length;
}

function eventSequences(stdout: string): number[] {
  const sequences: number[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const decoded = decodeJsonLine(line);
    if (!decoded.ok) continue;
    const event = parseAgentEvent(decoded.value);
    if (event.ok) sequences.push(event.value.sequence);
  }
  return sequences;
}

describe("option parsing", () => {
  it("applies defaults", () => {
    const parsed = parseReplayOptions([]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.emit, 3);
    assert.equal(parsed.value.hang, false);
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    // A silently dropped failure-mode flag would make a test pass for the
    // wrong reason.
    const parsed = parseReplayOptions(["--not-a-flag"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /unknown flag/);
  });

  it("rejects a flag missing its value", () => {
    assert.equal(parseReplayOptions(["--emit"]).ok, false);
  });

  it("rejects a non-integer where an integer is required", () => {
    assert.equal(parseReplayOptions(["--emit", "abc"]).ok, false);
    assert.equal(parseReplayOptions(["--emit", "1.5"]).ok, false);
  });
});

describe("the fake worker behaves like a real process", () => {
  it("emits schema-valid events and exits zero", async () => {
    const outcome = await runWorker(["--emit", "4"]);
    assert.equal(outcome.code, 0);
    // 1 opening status + 4 logs + 1 closing status.
    assert.equal(validEvents(outcome.stdout), 6);
    assert.equal(validResults(outcome.stdout), 1);
  });

  it("honours a requested exit code", async () => {
    const outcome = await runWorker(["--emit", "1", "--exit-code", "3"]);
    assert.equal(outcome.code, 3);
  });

  it("rejects bad arguments with EX_USAGE", async () => {
    const outcome = await runWorker(["--bogus"]);
    assert.equal(outcome.code, 64);
    assert.match(outcome.stderr, /unknown flag/);
  });

  it("writes to stderr without disturbing the event stream", async () => {
    const outcome = await runWorker([
      "--emit",
      "1",
      "--stderr",
      "npm warn deprecated",
    ]);
    assert.match(outcome.stderr, /npm warn deprecated/);
    assert.equal(validEvents(outcome.stdout), 3);
  });
});

describe("failure modes", () => {
  it("emits malformed lines alongside valid ones", async () => {
    const outcome = await runWorker(["--emit", "1", "--malformed", "1"]);

    const lines = outcome.stdout.split("\n").filter((l) => l.trim() !== "");
    const broken = lines.filter((line) => !decodeJsonLine(line).ok);

    assert.equal(broken.length, 3, "three distinct broken shapes");
    // The valid records must still be there: a parser has to skip the bad
    // lines rather than abandon the stream.
    assert.ok(validEvents(outcome.stdout) >= 3);
  });

  it("ends with a truncated record when asked", async () => {
    const outcome = await runWorker(["--emit", "1", "--partial-line"]);
    assert.equal(
      outcome.stdout.endsWith("\n"),
      false,
      "a killed process leaves no trailing newline",
    );

    const lines = outcome.stdout.split("\n");
    const last = lines[lines.length - 1] ?? "";
    assert.equal(decodeJsonLine(last).ok, false);
  });

  it("omits the terminal result when asked", async () => {
    const withTerminal = await runWorker(["--emit", "1"]);
    const without = await runWorker(["--emit", "1", "--no-terminal-result"]);
    assert.equal(
      validEvents(without.stdout),
      validEvents(withTerminal.stdout) - 1,
    );
    assert.equal(validResults(withTerminal.stdout), 1);
    assert.equal(validResults(without.stdout), 0);
  });

  it("can emit a duplicate terminal result", async () => {
    const outcome = await runWorker([
      "--emit",
      "1",
      "--duplicate-terminal-result",
    ]);
    assert.equal(validResults(outcome.stdout), 2);
  });

  it("emits a duplicate sequence with differing content", async () => {
    const outcome = await runWorker(["--emit", "2", "--duplicate-sequence"]);
    const sequences = eventSequences(outcome.stdout);

    assert.notEqual(
      new Set(sequences).size,
      sequences.length,
      "a duplicate sequence must actually appear",
    );
  });

  it("emits sequences out of order", async () => {
    const outcome = await runWorker(["--emit", "1", "--out-of-order"]);
    const sequences = eventSequences(outcome.stdout);

    assert.notDeepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
      "the stream must not already be ordered",
    );
  });

  it("floods output past a byte target", async () => {
    const outcome = await runWorker(["--emit", "0", "--flood-bytes", "20000"]);
    assert.ok(outcome.stdout.length > 20_000);
  });
});

describe("signal handling", () => {
  it("dies on SIGTERM by default", async () => {
    const outcome = await runWorker(["--emit", "1", "--hang"], (kill) => {
      setTimeout(() => {
        kill("SIGTERM");
      }, 150);
    });
    assert.equal(outcome.signal, "SIGTERM");
  });

  it("survives SIGTERM with --ignore-sigterm, requiring SIGKILL", async () => {
    // This is the case that makes the supervisor's escalation path testable:
    // a worker that traps SIGTERM must still be stoppable.
    const outcome = await runWorker(
      ["--emit", "1", "--hang", "--ignore-sigterm"],
      (kill) => {
        setTimeout(() => {
          kill("SIGTERM");
        }, 150);
        setTimeout(() => {
          kill("SIGKILL");
        }, 500);
      },
    );
    assert.equal(outcome.signal, "SIGKILL");
  });
});
