/**
 * `RunState` — the lifecycle vocabulary, from spec §10.
 *
 * The *type* lives in the protocol because it crosses the RPC boundary
 * (`task.status` returns it) and is persisted in `state.json`. The *transition
 * table* lives in `packages/core`: what the states are is a contract, how a run
 * moves between them is control-plane logic.
 *
 * `ORPHANED` is the state that makes restart recovery honest. When `agentd`
 * restarts and cannot prove what happened to a worker, the run lands here — it
 * is never resolved to `SUCCEEDED` by inference. CLAUDE.md: "Do not accept a
 * worker claim of success as proof."
 */

import { z } from "zod";

export const RUN_STATES = [
  /** Accepted and persisted; no resources committed yet. */
  "QUEUED",
  /** Worktree, sandbox and policy resolution in progress. */
  "PREPARING",
  /** Worker process is live. */
  "RUNNING",
  /** Stopped awaiting a decision it cannot make itself (e.g. approval). */
  "BLOCKED",
  /** Terminated on request. */
  "CANCELLED",
  /** Terminal failure with an attributable cause. */
  "FAILED",
  /** Worker finished; its claims are being checked before acceptance. */
  "VALIDATING",
  /** Terminal success, after validation. */
  "SUCCEEDED",
  /** Outcome indeterminate after a daemon restart. Requires explicit reaping. */
  "ORPHANED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const runStateSchema = z.enum(RUN_STATES);

/**
 * States from which no further transition is possible.
 *
 * `ORPHANED` is deliberately *not* terminal: an operator (or a later reaper)
 * must resolve it to `FAILED` or `SUCCEEDED` with evidence. Treating it as
 * terminal would bury unresolved runs.
 */
export const TERMINAL_RUN_STATES = [
  "CANCELLED",
  "FAILED",
  "SUCCEEDED",
] as const satisfies readonly RunState[];

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

const TERMINAL_SET: ReadonlySet<RunState> = new Set(TERMINAL_RUN_STATES);

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return TERMINAL_SET.has(state);
}

/** True while the run still owns resources (a process, a worktree lease). */
export function isActiveRunState(state: RunState): boolean {
  return state === "PREPARING" || state === "RUNNING" || state === "VALIDATING";
}
