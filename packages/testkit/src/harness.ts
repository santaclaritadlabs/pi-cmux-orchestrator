/**
 * Deterministic time and disposable directories.
 *
 * Timeouts and recovery are the behaviours P1 most needs to test, and both are
 * untestable against a real clock without sleeping. Everything that observes
 * time in this project takes a `Clock`, so a test can advance it by an hour in
 * a microsecond.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Clock {
  now(): number;
  /** Resolves after `ms` of *clock* time, not wall time. */
  sleep(ms: number): Promise<void>;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = Readonly<{ id: number }>;

/**
 * The real clock.
 *
 * Node's `setTimeout` returns an opaque `Timeout` object, but the `Clock`
 * interface hands out plain numeric handles so a fake can produce them too.
 * The mapping is kept here rather than leaking `Timeout` into the interface.
 */
function createSystemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 1;

  return {
    now: () => Date.now(),

    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),

    setTimeout(handler, ms) {
      const id = nextId;
      nextId += 1;

      // Deliberately *not* `unref`'d. These timers carry the hard timeout, and
      // an unreferenced timer is one Node may never run — a timeout enforcer
      // that silently declines to fire is worse than none. Shutdown clears
      // timers explicitly instead.
      const timer = setTimeout(() => {
        timers.delete(id);
        handler();
      }, ms);

      timers.set(id, timer);
      return { id };
    },

    clearTimeout(handle) {
      const timer = timers.get(handle.id);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(handle.id);
    },
  };
}

export const systemClock: Clock = createSystemClock();

type ScheduledTimer = Readonly<{
  id: number;
  dueAt: number;
  handler: () => void;
}>;

export interface FakeClock extends Clock {
  /** Advance time, firing every timer that becomes due, in order. */
  advance(ms: number): Promise<void>;
  set(epochMs: number): void;
  pending(): number;
}

/**
 * A clock a test drives by hand.
 *
 * `advance` fires due timers in due-time order and awaits a microtask between
 * each, so a handler that schedules another timer behaves the way it would at
 * runtime rather than being deferred to the next `advance`.
 */
export function createFakeClock(startEpochMs = 1_754_000_000_000): FakeClock {
  let current = startEpochMs;
  let nextId = 1;
  let timers: ScheduledTimer[] = [];

  return {
    now: () => current,

    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        this.setTimeout(() => {
          resolve();
        }, ms);
      });
    },

    setTimeout(handler: () => void, ms: number): TimerHandle {
      const id = nextId;
      nextId += 1;
      timers.push({ id, dueAt: current + ms, handler });
      return { id };
    },

    clearTimeout(handle: TimerHandle): void {
      timers = timers.filter((timer) => timer.id !== handle.id);
    },

    async advance(ms: number): Promise<void> {
      const target = current + ms;

      for (;;) {
        const due = timers
          .filter((timer) => timer.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt);

        const next = due[0];
        if (next === undefined) break;

        timers = timers.filter((timer) => timer.id !== next.id);
        current = next.dueAt;
        next.handler();
        // Let any promise the handler resolved settle before the next timer.
        await Promise.resolve();
      }

      current = target;
    },

    set(epochMs: number): void {
      current = epochMs;
    },

    pending: () => timers.length,
  };
}

/**
 * A disposable directory, removed when the returned handle is disposed.
 *
 * Uses `await using` so cleanup happens even when a test throws — a leaked
 * temp directory containing a fake run store is the kind of thing that makes a
 * later test pass for the wrong reason.
 */
export async function temporaryDirectory(
  prefix = "pi-cmux-test-",
): Promise<{ path: string } & AsyncDisposable> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    path: directory,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Absolute path to the compiled fake worker, for spawning in tests. */
export function replayWorkerPath(): string {
  return path.join(import.meta.dirname, "replay.js");
}
