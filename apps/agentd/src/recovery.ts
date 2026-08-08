/**
 * Boot recovery.
 *
 * When the daemon starts, some runs on disk may claim to be mid-flight. For
 * each one there are exactly three honest answers, and the point of this module
 * is to never give a fourth:
 *
 *   - **dead** — the process is gone and left no result. `ORPHANED`.
 *   - **unknown** — the pid exists but its start time cannot be confirmed.
 *     Also `ORPHANED`. An unverifiable process is not evidence of success.
 *   - **alive** — the worker outlived the daemon that launched it. Its process
 *     group is stopped, and the run is `ORPHANED` too. See below.
 *
 * `ORPHANED` is not terminal. Resolving it requires evidence, which is what
 * keeps "the daemon restarted, so presumably it worked" out of the audit trail.
 *
 * ## Why a surviving worker is stopped rather than adopted
 *
 * Adopting it is not available to us. A process can only be waited on by its
 * parent, so a daemon that did not spawn this worker cannot observe its exit or
 * learn its exit code; it could tail the output file, but it would never find
 * out that the run had ended. Recording it as "still running" — which is what
 * this module used to do — therefore produced a run that stayed RUNNING for
 * ever, with nothing left in the system that would ever move it.
 *
 * Leaving it alive is worse than it looks. Its hard timeout died with the
 * daemon, so it becomes exactly the unbounded subprocess CLAUDE.md prohibits,
 * still writing into a worktree whose claim no longer has an owner.
 *
 * So it is stopped, and the run is marked indeterminate — which is the truth:
 * the work may have been partly done, and no one can say how far it got. Real
 * adoption needs the exit status to outlive the daemon, which means a sidecar
 * that reaps the worker and persists its outcome independently. That is a
 * deliberate later change, not something to fake here.
 */

import { recoveryStateFor, type RunStore } from "@pi-cmux/core";
import {
  killGroup,
  pidExists,
  verifyWorkerAlive,
  type Liveness,
} from "@pi-cmux/process-supervisor";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import {
  err,
  makeError,
  ok,
  isTerminalRunState,
  type AgentdError,
  type Result,
  type RunState,
} from "@pi-cmux/protocol";

export type RecoveredRun = Readonly<{
  runId: string;
  previousState: RunState;
  newState: RunState;
  liveness: Liveness | "not-launched";
}>;

export type TerminatedRun = Readonly<{
  runId: string;
  pid: number;
  /**
   * False when the process outlived even SIGKILL — an unkillable worker (a
   * process wedged in uninterruptible I/O, say). Reported rather than hidden:
   * it is the one case where an operator must intervene by hand.
   */
  stopped: boolean;
}>;

export type RecoveryReport = Readonly<{
  inspected: number;
  orphaned: readonly RecoveredRun[];
  /** Runs whose worker was still alive and had to be stopped. ⊆ `orphaned`. */
  terminated: readonly TerminatedRun[];
  untouched: number;
}>;

export type RecoveryOptions = Readonly<{
  store: RunStore;
  logger?: Logger;
  now?: () => number;
  /** How long a surviving worker gets to honour SIGTERM before SIGKILL. */
  terminationGraceMs?: number;
  /** Test seam, so the grace period costs no real time. */
  sleep?: (ms: number) => Promise<void>;
}>;

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 100;

/**
 * Stop a worker this daemon did not launch, escalating if it does not go.
 *
 * The same SIGTERM-then-SIGKILL shape the supervisor uses, but driven by
 * polling `pidExists` rather than a child exit event: we are not this
 * process's parent, so there is no exit event to wait for.
 */
async function stopSurvivingWorker(
  pid: number,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  killGroup(pid, "SIGTERM");

  for (let waited = 0; waited < graceMs; waited += TERMINATION_POLL_MS) {
    if (!pidExists(pid)) return true;
    await sleep(TERMINATION_POLL_MS);
  }

  if (!pidExists(pid)) return true;

  killGroup(pid, "SIGKILL");
  await sleep(TERMINATION_POLL_MS);
  return !pidExists(pid);
}

/**
 * Classify every run on disk and orphan the ones we cannot vouch for.
 *
 * Runs are walked oldest-first, which the ULID run IDs give for free.
 */
export async function recoverRuns(
  options: RecoveryOptions,
): Promise<Result<RecoveryReport, AgentdError>> {
  const { store } = options;
  const logger = (options.logger ?? nullLogger).child({
    component: "recovery",
  });
  const now = options.now ?? Date.now;

  const graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const sleep =
    options.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    });

  const listed = await store.listRunIds();
  if (!listed.ok) {
    logger.error("could not list runs during recovery", {
      code: listed.error.code,
    });
    return listed;
  }

  const orphaned: RecoveredRun[] = [];
  const terminated: TerminatedRun[] = [];
  let untouched = 0;
  let failure: AgentdError | undefined;

  for (const runId of listed.value) {
    const state = await store.readState(runId);
    if (!state.ok) {
      // Unreadable state is not something to repair. It is reported and left
      // alone: rewriting it would fabricate history.
      logger.error("run state could not be read during recovery", {
        runId,
        code: state.error.code,
      });
      failure ??= state.error;
      continue;
    }

    const previousState = state.value.state;

    // Every run lock on disk is a leftover, whatever the run's state.
    //
    // A lock means "a daemon is working this run", and at boot that is false by
    // construction: we hold the daemon lock, and we have started nothing. So
    // the locks are cleared unconditionally rather than only on the runs this
    // pass rewrites — otherwise a daemon that died in the window between a run
    // going terminal and its lock being released would leave that lock behind
    // for ever, on a run no later recovery pass ever looks at again.
    const released = await store.releaseLock(runId);
    if (!released.ok) {
      failure ??= released.error;
      logger.error("could not clear a run lock during recovery", {
        runId,
        code: released.error.code,
      });
    }

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
    if (!metadata.ok) {
      failure ??= metadata.error;
      logger.error("run metadata could not be read during recovery", {
        runId,
        code: metadata.error.code,
      });
      continue;
    }
    const pid = metadata.value.pid;
    const startedAtMs = metadata.value.processStartedAtMs;

    if (pid === undefined || startedAtMs === undefined) {
      // The run was mid-flight but never recorded a process. It cannot be
      // resumed and cannot be proved to have run.
      const transitioned = await store.transitionState(runId, target);
      if (!transitioned.ok) {
        failure ??= transitioned.error;
        continue;
      }
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
      // Nothing in this daemon can supervise a process it did not spawn, so
      // the worker is stopped rather than left to run unbounded. See the note
      // at the top of this file.
      logger.warn("stopping a worker that outlived its daemon", { runId, pid });
      const stopped = await stopSurvivingWorker(pid, graceMs, sleep);
      terminated.push({ runId, pid, stopped });

      if (!stopped) {
        logger.error("a surviving worker could not be stopped", { runId, pid });
        failure ??= makeError(
          "RECOVERY_INCOMPLETE",
          "a surviving worker could not be stopped during recovery",
          { details: { runId, pid } },
        );
      }
    }

    const transitioned = await store.transitionState(runId, target);
    if (!transitioned.ok) {
      failure ??= transitioned.error;
      continue;
    }
    orphaned.push({ runId, previousState, newState: target, liveness });

    logger.warn("run orphaned during recovery", {
      runId,
      pid,
      previousState,
      liveness,
    });
  }

  const report: RecoveryReport = {
    inspected: listed.value.length,
    orphaned,
    terminated,
    untouched,
  };
  return failure === undefined ? ok(report) : err(failure);
}
