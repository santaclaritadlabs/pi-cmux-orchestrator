import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import {
  pidExists,
  pidStartTimeMs,
  verifyWorkerAlive,
} from "./pid-liveness.ts";

/** A real, long-lived child to interrogate. */
function spawnSleeper(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
  });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  return {
    pid,
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}

describe("pid existence", () => {
  it("sees our own process", () => {
    assert.equal(pidExists(process.pid), true);
  });

  it("rejects nonsense pids without throwing", () => {
    assert.equal(pidExists(0), false);
    assert.equal(pidExists(-1), false);
    assert.equal(pidExists(1.5), false);
    assert.equal(pidExists(Number.NaN), false);
  });

  it("reports a pid that almost certainly does not exist", () => {
    assert.equal(pidExists(999_999), false);
  });
});

describe("process start time", () => {
  it("reads a real process's start time", async () => {
    // The bug this covers: `ps -o etimes=` is a GNU extension that macOS
    // rejects, so this returned undefined on the primary dev platform and
    // every surviving worker was orphaned.
    const started = Date.now();
    const sleeper = spawnSleeper();
    try {
      const observed = await pidStartTimeMs(sleeper.pid);
      assert.notEqual(observed, undefined, "ps must answer on this platform");
      // `lstart` has one-second resolution, so allow a couple of seconds.
      assert.ok(
        Math.abs((observed ?? 0) - started) < 3_000,
        `start time drifted too far: ${String(observed)} vs ${String(started)}`,
      );
    } finally {
      sleeper.kill();
    }
  });

  it("returns undefined for a process that is gone", async () => {
    assert.equal(await pidStartTimeMs(999_999), undefined);
  });
});

describe("worker liveness", () => {
  it("confirms a process we recorded ourselves", async () => {
    const started = Date.now();
    const sleeper = spawnSleeper();
    try {
      const liveness = await verifyWorkerAlive(sleeper.pid, started);
      assert.equal(
        liveness,
        "alive",
        "a live worker must be recognised, or every restart orphans it",
      );
    } finally {
      sleeper.kill();
    }
  });

  it("reports a recycled pid as dead, not alive", async () => {
    // The pid exists, but it started at a wildly different time, so it is not
    // the process we launched.
    const sleeper = spawnSleeper();
    try {
      const liveness = await verifyWorkerAlive(sleeper.pid, 1_000_000);
      assert.equal(liveness, "dead");
    } finally {
      sleeper.kill();
    }
  });

  it("reports a vanished process as dead", async () => {
    assert.equal(await verifyWorkerAlive(999_999, Date.now()), "dead");
  });

  it("respects the tolerance window", async () => {
    const started = Date.now();
    const sleeper = spawnSleeper();
    try {
      // Recorded 30s early: outside a 5s tolerance.
      assert.equal(
        await verifyWorkerAlive(sleeper.pid, started - 30_000),
        "dead",
      );
      // ...but inside a 60s one.
      assert.equal(
        await verifyWorkerAlive(
          sleeper.pid,
          started - 30_000,
          Date.now,
          60_000,
        ),
        "alive",
      );
    } finally {
      sleeper.kill();
    }
  });
});
