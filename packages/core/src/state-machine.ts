/**
 * The lifecycle state machine.
 *
 * A pure transition table, deliberately: it is the one part of the control
 * plane where "can this happen?" must be answerable without reasoning about
 * I/O, timing or process state. Everything that moves a run between states goes
 * through `transition`, which returns a `Result` rather than throwing.
 *
 * The rule that shapes the table: **success is never inferred.** There is no
 * edge into `SUCCEEDED` except from `VALIDATING`, and no edge out of `ORPHANED`
 * that does not require an operator (or a reaper) to supply evidence.
 */

import {
  makeError,
  err,
  ok,
  isTerminalRunState,
  type AgentdError,
  type Result,
  type RunState,
} from "@pi-cmux/protocol";

/**
 * Allowed transitions.
 *
 * Notes on the less obvious edges:
 *
 * - `PREPARING → ORPHANED`: a daemon that dies during preparation may have
 *   died between `spawn` returning and the PID being persisted. We cannot
 *   prove no process exists, so the honest state is indeterminate.
 * - `BLOCKED → RUNNING`: a block is resolvable (an approval arrives) without
 *   restarting the run.
 * - `ORPHANED → SUCCEEDED | FAILED | CANCELLED`: reaping. Permitted precisely
 *   so an orphan can be resolved, and only with evidence gathered from disk.
 * - Terminal states have no outgoing edges at all.
 */
const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  QUEUED: ["PREPARING", "CANCELLED", "FAILED"],
  PREPARING: ["RUNNING", "BLOCKED", "CANCELLED", "FAILED", "ORPHANED"],
  RUNNING: ["VALIDATING", "BLOCKED", "CANCELLED", "FAILED", "ORPHANED"],
  BLOCKED: ["RUNNING", "CANCELLED", "FAILED", "ORPHANED"],
  VALIDATING: ["SUCCEEDED", "FAILED", "ORPHANED"],
  ORPHANED: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  CANCELLED: [],
  FAILED: [],
};

export const INITIAL_RUN_STATE: RunState = "QUEUED";

export function allowedTransitionsFrom(state: RunState): readonly RunState[] {
  return TRANSITIONS[state];
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Move a run between states, or explain why not.
 *
 * Returns the target state on success so callers can write
 * `const next = transition(...)` without re-stating it.
 */
export function transition(
  from: RunState,
  to: RunState,
): Result<RunState, AgentdError> {
  if (!canTransition(from, to)) {
    return err(
      makeError(
        "INVALID_STATE_TRANSITION",
        `a run cannot move from ${from} to ${to}`,
        { details: { from, to, allowed: TRANSITIONS[from].join(",") } },
      ),
    );
  }
  return ok(to);
}

/**
 * The state an active run should be moved to when its outcome cannot be
 * determined after a daemon restart.
 *
 * Returns `undefined` for states that need no recovery — already terminal, or
 * never started. A `QUEUED` run is safe to resume: nothing was launched.
 */
export function recoveryStateFor(state: RunState): RunState | undefined {
  if (isTerminalRunState(state)) return undefined;
  if (state === "QUEUED") return undefined;
  if (state === "ORPHANED") return undefined;
  return "ORPHANED";
}

/**
 * Whether a run in this state still owns a process or a worktree lease.
 *
 * `BLOCKED` counts: a worker paused awaiting an approval has not exited, and
 * its worktree is still leased. Treating it as idle would let a daemon restart
 * conclude nothing was running.
 */
export function holdsResources(state: RunState): boolean {
  return (
    state === "PREPARING" ||
    state === "RUNNING" ||
    state === "VALIDATING" ||
    state === "BLOCKED"
  );
}
