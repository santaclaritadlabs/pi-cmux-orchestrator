import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleTask, type AgentTask } from "@pi-cmux/protocol";
import {
  ADVERSARIAL_FIXTURES,
  readFixture,
  temporaryDirectory,
} from "@pi-cmux/testkit";

import {
  capabilities,
  normalizeStream,
  readEvents,
  start,
  type StartArgs,
} from "./runner.ts";

const RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";

function taskWith(overrides: Partial<AgentTask> = {}): AgentTask {
  const base = sampleTask();
  return {
    ...base,
    limits: { softTimeoutMs: 30_000, hardTimeoutMs: 60_000 },
    ...overrides,
  };
}

const startArgsWithoutEnv = {
  task: taskWith(),
  runId: RUN_ID,
  stdoutPath: "/tmp/stdout.ndjson",
  stderrPath: "/tmp/stderr.log",
  cwd: "/tmp",
};

// @ts-expect-error StartArgs requires the sandbox-provided environment.
void (startArgsWithoutEnv satisfies StartArgs);

async function runToCompletion(
  root: string,
  workerArgs: readonly string[],
): Promise<{ stdoutPath: string; exitCode: number | null }> {
  const stdoutPath = path.join(root, "stdout.ndjson");

  const handle = await start(
    {
      task: taskWith(),
      runId: RUN_ID,
      stdoutPath,
      stderrPath: path.join(root, "stderr.log"),
      cwd: root,
      env: {},
    },
    { workerArgs },
  );
  assert.ok(handle.ok, "the worker must start");

  const outcome = await handle.value.completed;
  return { stdoutPath, exitCode: outcome.exitCode };
}

describe("capabilities", () => {
  it("declares what the adapter can actually do", () => {
    const caps = capabilities();
    assert.equal(caps.kind, "fake");
    assert.equal(caps.supportsStructuredOutput, true);
    // Honest: cancellation is signal-based, not a graceful in-band request.
    assert.equal(caps.supportsGracefulCancel, false);
    assert.ok(caps.eventTypes.includes("status"));
  });
});

describe("driving a real process", () => {
  it("starts a worker and normalizes its output", async () => {
    await using dir = await temporaryDirectory();
    const { stdoutPath, exitCode } = await runToCompletion(dir.path, [
      "--emit",
      "4",
    ]);

    assert.equal(exitCode, 0);

    const batch = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(batch.ok);
    // 1 opening status + 4 logs + 1 closing status.
    assert.equal(batch.value.events.length, 6);
    assert.equal(batch.value.results.length, 1);
    assert.equal(batch.value.results[0]?.status, "succeeded");
    assert.equal(batch.value.rejected, 0);
    assert.equal(batch.value.events[0]?.type, "status");
  });

  it("passes no credentials to the worker", async () => {
    // The fake provider needs none, and a worker that does not need a secret
    // must not be handed one (spec §18).
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, ["--emit", "1"]);

    const batch = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(batch.ok);
    const rendered = JSON.stringify(batch.value.events);
    assert.equal(rendered.includes("sk-"), false);
    assert.equal(rendered.includes("ghp_"), false);
  });

  it("cancels a running worker", async () => {
    await using dir = await temporaryDirectory();

    const handle = await start(
      {
        task: taskWith(),
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: {},
      },
      {
        workerArgs: ["--emit", "1", "--hang"],
        supervisor: { terminationGraceMs: 200 },
      },
    );
    assert.ok(handle.ok);

    handle.value.cancel();
    const outcome = await handle.value.completed;
    assert.equal(outcome.reason, "cancelled");
  });

  it("surfaces duplicate terminal results for agentd to reject", async () => {
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, [
      "--emit",
      "1",
      "--duplicate-terminal-result",
    ]);

    const batch = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(batch.ok);
    assert.equal(batch.value.results.length, 2);
    assert.equal(batch.value.rejected, 0);
  });

  it("reports the pid and start time for durable metadata", async () => {
    await using dir = await temporaryDirectory();

    const handle = await start(
      {
        task: taskWith(),
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: {},
      },
      { workerArgs: ["--emit", "1"] },
    );
    assert.ok(handle.ok);

    assert.ok(handle.value.pid > 0);
    assert.ok(handle.value.startedAtMs > 0);
    assert.equal(handle.value.runId, RUN_ID);
    await handle.value.completed;
  });
});

describe("resumable reading", () => {
  it("reads incrementally from an offset", async () => {
    // This is the shape restart recovery uses: the offset comes from durable
    // metadata and reading resumes exactly there.
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, ["--emit", "5"]);

    const first = await readEvents(stdoutPath, 0, { atEof: false });
    assert.ok(first.ok);
    assert.ok(first.value.events.length > 0);

    // A second read from the recorded offset yields nothing new.
    const second = await readEvents(stdoutPath, first.value.offset, {
      atEof: true,
    });
    assert.ok(second.ok);
    assert.equal(second.value.events.length, 0);
  });

  it("refuses an offset past the end of the file", async () => {
    // A shrunken file means the offset is meaningless; continuing would
    // misattribute records to the wrong run.
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, ["--emit", "1"]);

    const bad = await readEvents(stdoutPath, 1_000_000, { atEof: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "STORE_CORRUPT");
  });

  it("reports a missing output file rather than throwing", async () => {
    await using dir = await temporaryDirectory();
    const missing = await readEvents(path.join(dir.path, "nope.ndjson"), 0, {
      atEof: true,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "STORE_IO_FAILED");
  });

  it("holds back a torn final record until the worker has exited", async () => {
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, [
      "--emit",
      "2",
      "--partial-line",
    ]);

    // Mid-run: the fragment is pending, not an error.
    const live = await readEvents(stdoutPath, 0, { atEof: false });
    assert.ok(live.ok);
    assert.equal(live.value.rejected, 0);

    // At EOF: it is taken, and fails to parse, and is counted.
    const final = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(final.ok);
    assert.equal(final.value.rejected, 1);
  });
});

describe("tolerating a broken provider stream", () => {
  it("keeps the valid records around malformed ones", async () => {
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, [
      "--emit",
      "2",
      "--malformed",
      "1",
    ]);

    const batch = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(batch.ok);
    assert.ok(batch.value.events.length >= 4, "valid events must survive");
    assert.ok(batch.value.rejected >= 3, "broken lines must be counted");
  });

  it("preserves arrival order rather than sorting", async () => {
    // Reordering is the store's job. A parser that sorted would hide the
    // anomaly the store needs to see.
    await using dir = await temporaryDirectory();
    const { stdoutPath } = await runToCompletion(dir.path, [
      "--emit",
      "1",
      "--out-of-order",
    ]);

    const batch = await readEvents(stdoutPath, 0, { atEof: true });
    assert.ok(batch.ok);
    const sequences = batch.value.events.map((e) => e.sequence);
    assert.notDeepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
    );
  });

  it("survives every adversarial fixture", async () => {
    for (const name of ADVERSARIAL_FIXTURES) {
      const raw = await readFixture("adversarial", name);
      const batch = normalizeStream(raw);

      assert.ok(batch.events.length > 0, `${name}: some events must survive`);
      for (const event of batch.events) {
        assert.equal(event.protocolVersion, "1");
      }
    }
  });

  it("counts an unknown event type as rejected, not passed through", async () => {
    const raw = await readFixture("adversarial", "unknown-event-type.ndjson");
    const batch = normalizeStream(raw);

    assert.equal(batch.rejected, 1);
    assert.equal(
      batch.events.some((e) => e.sequence === 1),
      false,
    );
  });

  it("cannot be made to forge a record with an escaped newline", async () => {
    const raw = await readFixture("adversarial", "control-characters.ndjson");
    const batch = normalizeStream(raw);

    assert.equal(batch.rejected, 0);
    assert.equal(
      batch.events.some((e) => e.sequence === 999),
      false,
      "an escaped newline inside a string must not create a record",
    );
  });
});
