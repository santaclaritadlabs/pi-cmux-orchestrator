import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { replayWorkerPath, temporaryDirectory } from "@pi-cmux/testkit";

import { buildWorkerEnvironment } from "./environment.ts";
import { pidExists } from "./pid-liveness.ts";
import {
  superviseProcess,
  type ProcessOutcome,
  type SupervisorOptions,
} from "./supervisor.ts";

type RunOptions = Partial<SupervisorOptions> & { args?: readonly string[] };

/**
 * Supervise the fake worker in a scratch directory.
 *
 * Real timers on purpose: these tests are about a real process's real
 * lifecycle, and a fake clock cannot make a real SIGKILL land.
 */
async function run(
  root: string,
  overrides: RunOptions = {},
): Promise<{ outcome: ProcessOutcome; stdout: string; stderr: string }> {
  const stdoutPath = path.join(root, "stdout.ndjson");
  const stderrPath = path.join(root, "stderr.log");

  // `args` is pulled out before spreading: leaving it in would overwrite the
  // constructed argv and hand the worker's flags straight to `node`.
  const { args = ["--emit", "2"], ...rest } = overrides;

  const supervised = await superviseProcess({
    command: process.execPath,
    args: [replayWorkerPath(), ...args],
    cwd: root,
    env: buildWorkerEnvironment({ source: process.env }),
    stdoutPath,
    stderrPath,
    softTimeoutMs: 60_000,
    hardTimeoutMs: 60_000,
    terminationGraceMs: 300,
    ...rest,
  });

  assert.ok(supervised.ok, "spawn must succeed");
  const outcome = await supervised.value.completed;

  return {
    outcome,
    stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
    stderr: await readFile(stderrPath, "utf8").catch(() => ""),
  };
}

/**
 * Wait until the worker has produced output.
 *
 * Signalling a Node process the instant it is spawned races its own startup:
 * `process.on("SIGTERM", ...)` is not registered yet, so even a worker built
 * to ignore SIGTERM dies to it. Tests about signal *handling* must wait for
 * the handler to exist.
 */
async function waitForOutput(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const size = await readFile(filePath, "utf8")
      .then((text) => text.length)
      .catch(() => 0);
    if (size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("worker produced no output before the deadline");
}

describe("normal completion", () => {
  it("runs to completion and reports the exit code", async () => {
    await using dir = await temporaryDirectory();
    const { outcome, stdout } = await run(dir.path);

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.signal, null);
    assert.equal(outcome.softTimeoutElapsed, false);
    assert.ok(outcome.pid > 0);
    assert.ok(stdout.includes('"protocolVersion":"1"'));
  });

  it("reports a nonzero exit without reinterpreting it", async () => {
    const scratch = await temporaryDirectory();
    await using dir = scratch;
    const { outcome } = await run(dir.path, {
      args: ["--emit", "1", "--exit-code", "7"],
    });

    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.reason, "exited");
  });

  it("persists the complete output of a bounded worker", async () => {
    await using dir = await temporaryDirectory();
    const { outcome, stdout } = await run(dir.path, { args: ["--emit", "5"] });

    // The durable file and the supervisor's accounting must agree.
    assert.ok(stdout.length > 0);
    assert.equal(outcome.stdoutBytes, Buffer.byteLength(stdout, "utf8"));
  });

  it("keeps stderr separate from the event stream", async () => {
    await using dir = await temporaryDirectory();
    const { stdout, stderr } = await run(dir.path, {
      args: ["--emit", "1", "--stderr", "npm warn deprecated"],
    });

    assert.match(stderr, /npm warn deprecated/);
    assert.equal(stdout.includes("npm warn"), false);
  });

  it("appends rather than truncating, so a re-attach keeps history", async () => {
    await using dir = await temporaryDirectory();
    const first = await run(dir.path, { args: ["--emit", "1"] });
    const second = await run(dir.path, { args: ["--emit", "1"] });

    assert.ok(
      second.stdout.length > first.stdout.length,
      "the second run must not have truncated the first's output",
    );
  });
});

describe("cancellation", () => {
  it("stops a running worker and labels the outcome", async () => {
    await using dir = await temporaryDirectory();

    const supervised = await superviseProcess({
      command: process.execPath,
      args: [replayWorkerPath(), "--emit", "1", "--hang"],
      cwd: dir.path,
      env: buildWorkerEnvironment({ source: process.env }),
      stdoutPath: path.join(dir.path, "stdout.ndjson"),
      stderrPath: path.join(dir.path, "stderr.log"),
      softTimeoutMs: 60_000,
      hardTimeoutMs: 60_000,
      terminationGraceMs: 300,
    });
    assert.ok(supervised.ok);

    const pid = supervised.value.pid;
    assert.equal(pidExists(pid), true);
    await waitForOutput(path.join(dir.path, "stdout.ndjson"));

    supervised.value.cancel();
    const outcome = await supervised.value.completed;

    assert.equal(outcome.reason, "cancelled");
    assert.equal(outcome.signal, "SIGTERM");
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    // A worker that traps SIGTERM must still be stoppable. This is the case
    // that a plain `child.kill()` gets wrong.
    await using dir = await temporaryDirectory();

    const supervised = await superviseProcess({
      command: process.execPath,
      args: [replayWorkerPath(), "--emit", "1", "--hang", "--ignore-sigterm"],
      cwd: dir.path,
      env: buildWorkerEnvironment({ source: process.env }),
      stdoutPath: path.join(dir.path, "stdout.ndjson"),
      stderrPath: path.join(dir.path, "stderr.log"),
      softTimeoutMs: 60_000,
      hardTimeoutMs: 60_000,
      terminationGraceMs: 200,
    });
    assert.ok(supervised.ok);
    await waitForOutput(path.join(dir.path, "stdout.ndjson"));

    supervised.value.cancel();
    const outcome = await supervised.value.completed;

    assert.equal(outcome.signal, "SIGKILL");
    assert.equal(outcome.reason, "cancelled");
  });

  it("leaves no process behind", async () => {
    await using dir = await temporaryDirectory();

    const supervised = await superviseProcess({
      command: process.execPath,
      args: [replayWorkerPath(), "--hang", "--ignore-sigterm"],
      cwd: dir.path,
      env: buildWorkerEnvironment({ source: process.env }),
      stdoutPath: path.join(dir.path, "stdout.ndjson"),
      stderrPath: path.join(dir.path, "stderr.log"),
      softTimeoutMs: 60_000,
      hardTimeoutMs: 60_000,
      terminationGraceMs: 200,
    });
    assert.ok(supervised.ok);

    const pid = supervised.value.pid;
    await waitForOutput(path.join(dir.path, "stdout.ndjson"));
    supervised.value.cancel();
    await supervised.value.completed;

    assert.equal(pidExists(pid), false, "the worker must be gone");
  });
});

describe("timeouts", () => {
  it("fires the soft timeout without stopping the run", async () => {
    await using dir = await temporaryDirectory();
    let softFired = false;

    const { outcome } = await run(dir.path, {
      args: ["--emit", "2", "--delay-ms", "120"],
      softTimeoutMs: 50,
      hardTimeoutMs: 60_000,
      onSoftTimeout: () => {
        softFired = true;
      },
    });

    assert.equal(softFired, true, "the soft timeout callback must fire");
    assert.equal(outcome.softTimeoutElapsed, true);
    // Advisory only: the process still finished on its own.
    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.exitCode, 0);
  });

  it("terminates a hung worker at the hard timeout", async () => {
    await using dir = await temporaryDirectory();
    const { outcome } = await run(dir.path, {
      args: ["--emit", "1", "--hang"],
      softTimeoutMs: 50,
      hardTimeoutMs: 200,
    });

    assert.equal(outcome.reason, "timed_out");
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.softTimeoutElapsed, true);
  });

  it("kills a hung worker that also ignores SIGTERM", async () => {
    await using dir = await temporaryDirectory();
    const { outcome } = await run(dir.path, {
      args: ["--hang", "--ignore-sigterm"],
      softTimeoutMs: 10_000,
      hardTimeoutMs: 150,
      terminationGraceMs: 200,
    });

    assert.equal(outcome.reason, "timed_out");
    assert.equal(outcome.signal, "SIGKILL");
  });

  it("does not fire a timeout for a process that already finished", async () => {
    await using dir = await temporaryDirectory();
    const { outcome } = await run(dir.path, {
      args: ["--emit", "1"],
      softTimeoutMs: 5_000,
      hardTimeoutMs: 5_000,
    });

    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.softTimeoutElapsed, false);
  });
});

describe("output limits", () => {
  it("terminates a worker that floods its output budget", async () => {
    await using dir = await temporaryDirectory();
    const { outcome, stdout } = await run(dir.path, {
      args: ["--emit", "0", "--flood-bytes", "3000000", "--hang"],
      maxOutputBytes: 100_000,
      hardTimeoutMs: 30_000,
      softTimeoutMs: 30_000,
    });

    assert.equal(outcome.reason, "output_limit");
    assert.ok(outcome.stdoutBytes > 100_000);
    assert.ok(Buffer.byteLength(stdout, "utf8") <= 100_000);
  });

  it("terminates a worker that floods stderr", async () => {
    // stdout stays tiny throughout, so a supervisor that only meters stdout
    // sees a well-behaved worker while the disk fills up underneath it.
    await using dir = await temporaryDirectory();
    const { outcome, stderr } = await run(dir.path, {
      args: ["--emit", "0", "--flood-stderr-bytes", "3000000", "--hang"],
      maxOutputBytes: 10_000_000,
      maxStderrBytes: 100_000,
      hardTimeoutMs: 30_000,
      softTimeoutMs: 30_000,
    });

    assert.equal(outcome.reason, "output_limit");
    assert.equal(outcome.outputLimitStream, "stderr");
    assert.ok(outcome.stderrBytes > 100_000);
    // The stream that behaved is not blamed for the one that did not.
    assert.ok(outcome.stdoutBytes < 100_000);
    assert.ok(Buffer.byteLength(stderr, "utf8") <= 100_000);
  });

  it("catches a short stderr burst even when the worker exits immediately", async () => {
    await using dir = await temporaryDirectory();
    const { outcome, stderr } = await run(dir.path, {
      args: ["--emit", "0", "--flood-stderr-bytes", "3000000"],
      maxOutputBytes: 10_000_000,
      maxStderrBytes: 100_000,
      hardTimeoutMs: 30_000,
      softTimeoutMs: 30_000,
    });

    assert.equal(outcome.reason, "output_limit");
    assert.equal(outcome.outputLimitStream, "stderr");
    assert.ok(outcome.stderrBytes > 100_000);
    assert.ok(Buffer.byteLength(stderr, "utf8") <= 100_000);
  });

  it("names stdout as the stream that overflowed", async () => {
    await using dir = await temporaryDirectory();
    const { outcome } = await run(dir.path, {
      args: ["--emit", "0", "--flood-bytes", "3000000", "--hang"],
      maxOutputBytes: 100_000,
      hardTimeoutMs: 30_000,
      softTimeoutMs: 30_000,
    });

    assert.equal(outcome.reason, "output_limit");
    assert.equal(outcome.outputLimitStream, "stdout");
  });

  it("leaves a well-behaved worker alone", async () => {
    await using dir = await temporaryDirectory();
    const { outcome } = await run(dir.path, {
      args: ["--emit", "3"],
      maxOutputBytes: 10_000_000,
    });

    assert.equal(outcome.reason, "exited");
  });
});

describe("spawn failures are results, not throws", () => {
  it("reports a missing binary", async () => {
    await using dir = await temporaryDirectory();

    const supervised = await superviseProcess({
      command: path.join(dir.path, "definitely-not-a-binary"),
      args: [],
      cwd: dir.path,
      env: buildWorkerEnvironment(),
      stdoutPath: path.join(dir.path, "stdout.ndjson"),
      stderrPath: path.join(dir.path, "stderr.log"),
      softTimeoutMs: 1_000,
      hardTimeoutMs: 1_000,
    });

    // Node surfaces ENOENT asynchronously via 'error' on POSIX, so the spawn
    // call itself may succeed. Either way the run must reach a terminal
    // outcome rather than hanging or throwing.
    if (supervised.ok) {
      const outcome = await supervised.value.completed;
      assert.equal(outcome.exitCode, null);
    } else {
      assert.equal(supervised.error.code, "WORKER_SPAWN_FAILED");
      assert.equal(supervised.error.retryable, true);
    }
  });

  it("reports an unwritable output path", async () => {
    const supervised = await superviseProcess({
      command: process.execPath,
      args: ["--version"],
      cwd: "/",
      env: buildWorkerEnvironment(),
      stdoutPath: "/definitely/not/a/directory/stdout.ndjson",
      stderrPath: "/definitely/not/a/directory/stderr.log",
      softTimeoutMs: 1_000,
      hardTimeoutMs: 1_000,
    });

    assert.equal(supervised.ok, false);
    assert.equal(supervised.error.code, "WORKER_SPAWN_FAILED");
  });
});
