/**
 * Error taxonomy.
 *
 * Every expected failure in the system carries one of these codes. The codes
 * are a *stable public contract*: they appear in `AgentResult.failure.code`, in
 * audit events, and in RPC responses, so renaming one is a protocol change.
 *
 * Two properties are derived from the code rather than supplied at the call
 * site, so they cannot drift between callers:
 *
 *   - `retryable` — whether re-issuing the same request could plausibly
 *     succeed. Policy denials are never retryable; transient I/O is.
 *   - `category` — the layer that owns the failure, for metrics and triage.
 *
 * `safeMessage` is the only free-form field and it is exposed over RPC and
 * written to logs. It must describe *what* failed in terms of our own domain,
 * never echo untrusted repository content, provider output, or secrets. Put
 * variable data in `details`, which is restricted to scalars.
 */

export type ErrorCategory =
  | "protocol"
  | "policy"
  | "lifecycle"
  | "execution"
  | "storage"
  | "rpc"
  | "internal";

type ErrorSpec = Readonly<{
  retryable: boolean;
  category: ErrorCategory;
}>;

/**
 * The closed catalogue. `ErrorCode` is derived from these keys, so adding a
 * code here is the only way to create one.
 */
const ERROR_SPECS = {
  // --- protocol: the message itself is not something we accept -------------
  /** `protocolVersion` is absent or names a version this build cannot serve. */
  PROTOCOL_VERSION_UNSUPPORTED: { retryable: false, category: "protocol" },
  /** Runtime schema validation rejected the payload. */
  SCHEMA_INVALID: { retryable: false, category: "protocol" },
  /** Event `type` outside the known union. Fails closed, per CLAUDE.md. */
  UNKNOWN_EVENT_TYPE: { retryable: false, category: "protocol" },
  /** A second terminal `AgentResult` arrived for a task that already has one. */
  DUPLICATE_TERMINAL_RESULT: { retryable: false, category: "protocol" },
  /** Two different events claim the same `sequence` within one run. */
  SEQUENCE_CONFLICT: { retryable: false, category: "protocol" },

  // --- policy: the request is well-formed but not permitted ----------------
  /** The policy engine denied the task. Default outcome when no rule allows. */
  POLICY_DENIED: { retryable: false, category: "policy" },
  /** A path resolved outside its assigned worktree or allowlist. */
  PATH_ESCAPE: { retryable: false, category: "policy" },
  /** The task requested a capability this worker/profile does not offer. */
  CAPABILITY_UNSUPPORTED: { retryable: false, category: "policy" },
  /**
   * Isolation was required and could not be provided. CLAUDE.md: "If required
   * isolation is unavailable, reject the task; do not silently fall back."
   */
  SANDBOX_UNAVAILABLE: { retryable: false, category: "policy" },
  /** Network was requested but the effective policy denies it. */
  NETWORK_DENIED: { retryable: false, category: "policy" },
  /**
   * The repository declares configuration that executes a command — hooks, a
   * filesystem monitor, a content filter, a textconv driver. Checking out such
   * a repository runs its code. CLAUDE.md: "Never execute repository hooks or
   * package lifecycle scripts implicitly."
   */
  REPO_UNSAFE: { retryable: false, category: "policy" },

  // --- workspace: the Git worktree assigned to a task ----------------------
  /**
   * The worktree is already claimed by another run. Two writers never share a
   * working directory (spec §12), so this is a refusal, not a queue.
   */
  WORKTREE_CONFLICT: { retryable: false, category: "lifecycle" },
  /**
   * Cleanup was asked to remove a worktree whose ownership could not be
   * proven. CLAUDE.md: "never delete a worktree whose identity or task
   * ownership cannot be proven." Requires an operator, not a retry.
   */
  WORKTREE_OWNERSHIP_UNPROVEN: { retryable: false, category: "lifecycle" },
  /** A `git` invocation exited nonzero, timed out, or could not be spawned. */
  GIT_COMMAND_FAILED: { retryable: false, category: "execution" },

  // --- lifecycle: the run's state does not permit the operation ------------
  /** A state transition not present in the state machine table was attempted. */
  INVALID_STATE_TRANSITION: { retryable: false, category: "lifecycle" },
  RUN_NOT_FOUND: { retryable: false, category: "lifecycle" },
  TASK_NOT_FOUND: { retryable: false, category: "lifecycle" },
  RUN_ALREADY_EXISTS: { retryable: false, category: "lifecycle" },
  /** Another process holds the run's lock. Retry after it releases. */
  RUN_LOCKED: { retryable: true, category: "lifecycle" },
  /**
   * Another daemon already owns this runtime directory, or its ownership could
   * not be disproven. Two daemons sharing a run store would split clients and
   * interleave writes into the same lifecycle history, so the second one
   * refuses to start. Not retryable: it needs an operator to stop the other
   * daemon. A crash releases the underlying OS lock automatically.
   */
  DAEMON_ALREADY_RUNNING: { retryable: false, category: "lifecycle" },
  /** The daemon has begun draining and will not accept new execution. */
  DAEMON_SHUTTING_DOWN: { retryable: true, category: "lifecycle" },
  /** Boot recovery could not restore a safe, fully-owned runtime. */
  RECOVERY_INCOMPLETE: { retryable: false, category: "lifecycle" },
  /**
   * The run's true outcome could not be determined after a restart. Never
   * resolved to success by inference — see the ORPHANED state.
   */
  ORPHANED_RUN: { retryable: false, category: "lifecycle" },

  // --- execution: the worker process misbehaved ----------------------------
  WORKER_SPAWN_FAILED: { retryable: true, category: "execution" },
  WORKER_EXITED_NONZERO: { retryable: false, category: "execution" },
  /**
   * The provider's own permission system refused an action mid-run — not
   * `POLICY_DENIED`, which is agentd's admission-time decision before a
   * worker ever starts. A provider CLI can exit 0 (and even claim its own
   * `"SUCCESS"` in a terminal envelope) after this happens, so it is the one
   * failure mode a caller must detect from the transcript, not the exit
   * code or the provider's own verdict.
   */
  WORKER_PERMISSION_DENIED: { retryable: false, category: "execution" },
  /** Soft timeout: advisory, the run continues until the hard limit. */
  TIMEOUT_SOFT: { retryable: true, category: "execution" },
  /** Hard timeout: the process group was terminated. */
  TIMEOUT_HARD: { retryable: true, category: "execution" },
  CANCELLED: { retryable: false, category: "execution" },
  /** The worker exceeded the per-run byte or line budget for its output. */
  OUTPUT_LIMIT_EXCEEDED: { retryable: false, category: "execution" },
  /** A stream line could not be parsed as an event. Individually recoverable. */
  MALFORMED_WORKER_OUTPUT: { retryable: false, category: "execution" },
  /** Retained for protocol-v1 compatibility with pre-AgentResult workers. */
  MISSING_TERMINAL_EVENT: { retryable: false, category: "execution" },
  /** The process ended without emitting its one required AgentResult. */
  MISSING_TERMINAL_RESULT: { retryable: false, category: "execution" },

  // --- storage: durable state could not be read or written -----------------
  STORE_IO_FAILED: { retryable: true, category: "storage" },
  /** On-disk state exists but does not validate. Never silently repaired. */
  STORE_CORRUPT: { retryable: false, category: "storage" },

  // --- rpc: the local socket conversation ----------------------------------
  /** Called a method before completing `daemon.hello`, or with a bad token. */
  RPC_UNAUTHENTICATED: { retryable: false, category: "rpc" },
  RPC_METHOD_UNKNOWN: { retryable: false, category: "rpc" },
  RPC_MESSAGE_TOO_LARGE: { retryable: false, category: "rpc" },
  RPC_MALFORMED: { retryable: false, category: "rpc" },

  // --- internal: a defect on our side --------------------------------------
  /** Reserved for genuine bugs. Should never reach a user-visible surface. */
  INTERNAL: { retryable: false, category: "internal" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_SPECS;

export const ERROR_CODES = Object.keys(ERROR_SPECS) as readonly ErrorCode[];

/** Scalars only: `details` is embedded in logs and RPC responses verbatim. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

export type AgentdError = Readonly<{
  code: ErrorCode;
  /** Safe to expose over RPC and to log. Never contains untrusted content. */
  safeMessage: string;
  retryable: boolean;
  category: ErrorCategory;
  details?: ErrorDetails;
  /**
   * The underlying throwable, kept for local debugging only. It is stripped by
   * `toWireError` and must never be logged raw — an `Error` from `node:fs` or a
   * provider CLI can carry paths, argv, and environment fragments.
   */
  cause?: unknown;
}>;

export function makeError(
  code: ErrorCode,
  safeMessage: string,
  options: { details?: ErrorDetails; cause?: unknown } = {},
): AgentdError {
  const spec = ERROR_SPECS[code];
  return {
    code,
    safeMessage,
    retryable: spec.retryable,
    category: spec.category,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_SPECS[code].retryable;
}

export function categoryOf(code: ErrorCode): ErrorCategory {
  return ERROR_SPECS[code].category;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_SPECS, value);
}

export function isAgentdError(value: unknown): value is AgentdError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isErrorCode(candidate["code"]) &&
    typeof candidate["safeMessage"] === "string" &&
    typeof candidate["retryable"] === "boolean"
  );
}

/** The shape that crosses the RPC boundary: `cause` is dropped. */
export type WireError = Readonly<{
  code: ErrorCode;
  safeMessage: string;
  retryable: boolean;
  category: ErrorCategory;
  details?: ErrorDetails;
}>;

export function toWireError(error: AgentdError): WireError {
  return {
    code: error.code,
    safeMessage: error.safeMessage,
    retryable: error.retryable,
    category: error.category,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/**
 * Wrap an unknown throwable from a boundary we do not own.
 *
 * Deliberately does not interpolate the throwable into `safeMessage`: a
 * message from `node:fs` or a provider CLI is untrusted content. It is kept in
 * `cause` for local inspection and dropped on the wire.
 */
export function fromThrown(
  code: ErrorCode,
  safeMessage: string,
  cause: unknown,
  details?: ErrorDetails,
): AgentdError {
  return makeError(code, safeMessage, {
    cause,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Signals a defect in our own code, not an operational condition. Throwing this
 * is correct; catching it to continue is not.
 */
export class InvariantViolation extends Error {
  public constructor(message: string) {
    super(`invariant violated: ${message}`);
    this.name = "InvariantViolation";
  }
}

export function invariant(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value: never, context: string): never {
  throw new InvariantViolation(
    `${context}: unhandled variant ${JSON.stringify(value)}`,
  );
}
