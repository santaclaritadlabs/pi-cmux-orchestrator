/**
 * Boot recovery.
 *
 * When the daemon starts, some runs on disk may claim to be mid-flight. For
 * each one there are exactly three honest answers, and the point of this module
 * is to never give a fourth:
 *
 *   - **alive** — the recorded pid exists *and* started when we recorded it
 *     starting. The run continues; its output is re-read from the persisted
 *     offset, which the store's idempotency makes safe.
 *   - **dead** — the process is gone and left no result. `ORPHANED`.
 *   - **unknown** — the pid exists but its start time cannot be confirmed.
 *     Also `ORPHANED`. An unverifiable process is not evidence of success.
 *
 * `ORPHANED` is not terminal. Resolving it requires evidence, which is what
 * keeps "the daemon restarted, so presumably it worked" out of the audit trail.
 */

import { recoveryStateFor, type RunStore } from "@pi-cmux/core";
import { verifyWorkerAlive, type Liveness } from "@pi-cmux/process-supervisor";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import { isTerminalRunState, type RunState } from "@pi-cmux/protocol";

export type RecoveredRun = Readonly<{
  runId: string;
  previousState: RunState;
  newState: RunState;
  liveness: Liveness | "not-launched";
}>;

export type RecoveryReport = Readonly<{
  inspected: number;
  orphaned: readonly RecoveredRun[];
  stillRunning: readonly string[];
  untouched: number;
}>;

export type RecoveryOptions = Readonly<{
  store: RunStore;
  logger?: Logger;
  now?: () => number;
}>;

/**
 * Classify every run on disk and orphan the ones we cannot vouch for.
 *
 * Runs are walked oldest-first, which the ULID run IDs give for free.
 */
export async function recoverRuns(
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  const { store } = options;
  const logger = (options.logger ?? nullLogger).child({
    component: "recovery",
  });
  const now = options.now ?? Date.now;

  const listed = await store.listRunIds();
  if (!listed.ok) {
    logger.error("could not list runs during recovery", {
      code: listed.error.code,
    });
    return { inspected: 0, orphaned: [], stillRunning: [], untouched: 0 };
  }

  const orphaned: RecoveredRun[] = [];
  const stillRunning: string[] = [];
  let untouched = 0;

  for (const runId of listed.value) {
    const state = await store.readState(runId);
    if (!state.ok) {
      // Unreadable state is not something to repair. It is reported and left
      // alone: rewriting it would fabricate history.
      logger.error("run state could not be read during recovery", {
        runId,
        code: state.error.code,
      });
      continue;
    }

    const previousState = state.value.state;

    if (isTerminalRunState(previousState) || previousState === "ORPHANED") {
      untouched += 1;
      continue;
    }

    const target = recoveryStateFor(previousState);
    if (target === undefined) {
      // QUEUED: nothing was launched, so nothing is indeterminate.
      untouched += 1;
      continue;
    }

    const metadata = await store.readMetadata(runId);
    const pid = metadata.ok ? metadata.value.pid : undefined;
    const startedAtMs = metadata.ok
      ? metadata.value.processStartedAtMs
      : undefined;

    if (pid === undefined || startedAtMs === undefined) {
      // The run was mid-flight but never recorded a process. It cannot be
      // resumed and cannot be proved to have run.
      await store.transitionState(runId, target);
      orphaned.push({
        runId,
        previousState,
        newState: target,
        liveness: "not-launched",
      });
      continue;
    }

    const liveness = await verifyWorkerAlive(pid, startedAtMs, now);

    if (liveness === "alive") {
      // The worker outlived the daemon. Its output is still being written to a
      // file we can read, so the run is genuinely resumable.
      logger.info("run survived the daemon restart", { runId, pid });
      stillRunning.push(runId);
      continue;
    }

    await store.transitionState(runId, target);
    orphaned.push({ runId, previousState, newState: target, liveness });

    logger.warn("run orphaned during recovery", {
      runId,
      pid,
      previousState,
      liveness,
    });
  }

  return {
    inspected: listed.value.length,
    orphaned,
    stillRunning,
    untouched,
  };
}
