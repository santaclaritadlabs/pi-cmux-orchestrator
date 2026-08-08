import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakeClock, systemClock, temporaryDirectory } from "./harness.ts";

describe("fake clock", () => {
  it("does not move on its own", () => {
    const clock = createFakeClock(1_000);
    assert.equal(clock.now(), 1_000);
    assert.equal(clock.now(), 1_000);
  });

  it("fires timers that come due, in due-time order", async () => {
    const clock = createFakeClock(0);
    const fired: string[] = [];

    clock.setTimeout(() => fired.push("late"), 300);
    clock.setTimeout(() => fired.push("early"), 100);
    clock.setTimeout(() => fired.push("never"), 5_000);

    await clock.advance(1_000);

    assert.deepEqual(fired, ["early", "late"]);
    assert.equal(clock.now(), 1_000);
    assert.equal(clock.pending(), 1);
  });

  it("runs a timer scheduled by another timer within the same advance", async () => {
    // The supervisor schedules the hard timeout from inside the soft-timeout
    // handler, so this ordering has to work.
    const clock = createFakeClock(0);
    const fired: string[] = [];

    clock.setTimeout(() => {
      fired.push("soft");
      clock.setTimeout(() => fired.push("hard"), 100);
    }, 100);

    await clock.advance(500);
    assert.deepEqual(fired, ["soft", "hard"]);
  });

  it("does not fire a timer that has been cleared", async () => {
    const clock = createFakeClock(0);
    let fired = false;
    const handle = clock.setTimeout(() => (fired = true), 100);

    clock.clearTimeout(handle);
    await clock.advance(1_000);

    assert.equal(fired, false);
    assert.equal(clock.pending(), 0);
  });

  it("resolves sleep only once time has advanced past it", async () => {
    const clock = createFakeClock(0);
    let resolved = false;
    void clock.sleep(500).then(() => (resolved = true));

    await clock.advance(499);
    assert.equal(resolved, false);

    await clock.advance(1);
    // Let the `then` callback run.
    await Promise.resolve();
    assert.equal(resolved, true);
  });

  it("can be set backwards, to exercise clock regression", () => {
    const clock = createFakeClock(1_000);
    clock.set(500);
    assert.equal(clock.now(), 500);
  });
});

describe("system clock", () => {
  it("actually cancels a cleared timer", async () => {
    // A no-op clearTimeout would leak timers and fire work after cancellation.
    let fired = false;
    const handle = systemClock.setTimeout(() => (fired = true), 10);
    systemClock.clearTimeout(handle);

    await systemClock.sleep(40);
    assert.equal(fired, false);
  });

  it("fires a timer that is not cleared", async () => {
    let fired = false;
    systemClock.setTimeout(() => (fired = true), 5);
    await systemClock.sleep(50);
    assert.equal(fired, true);
  });
});

describe("temporary directory", () => {
  it("removes itself on dispose, even after a throw", async () => {
    const { stat } = await import("node:fs/promises");
    let recorded = "";

    await assert.rejects(async () => {
      await using dir = await temporaryDirectory();
      recorded = dir.path;
      await stat(recorded);
      throw new Error("boom");
    });

    assert.notEqual(recorded, "");
    await assert.rejects(() => stat(recorded), /ENOENT/);
  });
});
