/**
 * Bounded process supervision.
 *
 * This is the component that makes "agentd guarantees it happens" true rather
 * than aspirational. Four properties, each one a decision that is easy to get
 * subtly wrong:
 *
 * **1. argv only, no shell.** `spawn(command, args)` with `shell: false`.
 * Nothing is interpolated, so nothing in a task or a repository can become a
 * command. Enforced at lint level too.
 *
 * **2. The child writes to file descriptors, not pipes.** stdout and stderr are
 * opened as files and handed to the child. `agentd` is not in the data path, so
 * a slow or dead daemon cannot block the worker — and after a daemon restart
 * the output is still on disk to be re-read from a recorded offset. With pipes,
 * a restart severs the stream and the run's outcome becomes unknowable.
 *
 * **3. Kills target the process group.** `detached: true` makes the child a
 * group leader, so `kill(-pid)` reaches its children too. A worker that spawns
 * `npm test` and is killed with a plain `child.kill()` leaves that test running
 * forever, holding the worktree.
 *
 * **4. Termination escalates.** SIGTERM, a grace period, then SIGKILL. A worker
 * that traps SIGTERM must still be stoppable, and SIGKILL cannot be trapped.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { open, stat, type FileHandle } from "node:fs/promises";

import {
  makeError,
  err,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import { systemClock, type Clock, type TimerHandle } from "@pi-cmux/testkit";

export type TerminationReason =
  /** The process exited on its own. */
  | "exited"
  /** Cancelled on request. */
  | "cancelled"
  /** The hard timeout elapsed. */
  | "timed_out"
  /** It produced more output than the run is allowed. */
  | "output_limit";

export type ProcessOutcome = Readonly<{
  pid: number;
  startedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: TerminationReason;
  /** Whether the advisory soft timeout elapsed before the process finished. */
  softTimeoutElapsed: boolean;
  /** Bytes observed on stdout, at the last check. */
  stdoutBytes: number;
}>;

export type SupervisorOptions = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  /** Built by `buildWorkerEnvironment`. Never `process.env`. */
  env: Readonly<Record<string, string>>;

  /** The worker appends here directly, via its own fd. */
  stdoutPath: string;
  stderrPath: string;

  /** Advisory. Emits a warning; the run continues. */
  softTimeoutMs: number;
  /** Enforced. The process group is terminated. */
  hardTimeoutMs: number;
  /** Time between SIGTERM and SIGKILL. */
  terminationGraceMs?: number;

  /** Terminate if stdout grows past this. */
  maxOutputBytes?: number;
  /** How often to check the output size. */
  outputCheckIntervalMs?: number;

  clock?: Clock;
  logger?: Logger;
  onSoftTimeout?: () => void;
}>;

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_OUTPUT_CHECK_MS = 1_000;

export interface SupervisedProcess {
  readonly pid: number;
  readonly startedAtMs: number;
  /**
   * Terminate the process group, escalating SIGTERM → SIGKILL.
   *
   * Declared as a property holding a closure, not a method: it captures the
   * run's state and is meant to be passed around freely, so it must not depend
   * on `this` being preserved.
   */
  readonly cancel: () => void;
  /** Resolves once the process has exited and its outcome is known. */
  readonly completed: Promise<ProcessOutcome>;
}

/**
 * Signal an entire process group, tolerating a group that has already gone.
 *
 * The negative pid is the group. `ESRCH` means it exited between our decision
 * and our signal, which is a normal race, not a failure.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // EPERM would mean the group is not ours. Fall back to the child alone
    // rather than giving up on stopping it.
    try {
      process.kill(pid, signal);
    } catch {
      // Nothing further we can do; the caller learns from the exit event.
    }
  }
}

/**
 * Launch a worker under supervision.
 *
 * Failure to spawn is a `Result`, not a throw: a missing binary is an
 * operational condition, and the run needs a terminal state rather than an
 * exception escaping into the daemon's event loop.
 */
export async function superviseProcess(
  options: SupervisorOptions,
): Promise<Result<SupervisedProcess, AgentdError>> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const graceMs = options.terminationGraceMs ?? DEFAULT_GRACE_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputCheckMs =
    options.outputCheckIntervalMs ?? DEFAULT_OUTPUT_CHECK_MS;

  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;

  try {
    // Append mode: a restarted daemon re-attaching to a run must not truncate
    // output the previous incarnation already recorded.
    stdoutHandle = await open(options.stdoutPath, "a", 0o600);
    stderrHandle = await open(options.stderrPath, "a", 0o600);
  } catch (cause) {
    await stdoutHandle?.close();
    await stderrHandle?.close();
    return err(
      makeError("WORKER_SPAWN_FAILED", "could not open worker output files", {
        cause,
      }),
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      // Own process group, so cancellation reaches grandchildren.
      detached: true,
      // stdin closed: a worker must never block waiting for input nobody will
      // send. stdout/stderr are plain fds.
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      shell: false,
    });
  } catch (cause) {
    await stdoutHandle.close();
    await stderrHandle.close();
    return err(
      makeError("WORKER_SPAWN_FAILED", "could not spawn the worker", {
        details: { command: options.command },
        cause,
      }),
    );
  }

  // Attached before any early return. A `ChildProcess` that emits `error` with
  // no listener has that error rethrown by Node as an uncaught exception, and
  // `ENOENT` arrives on a later tick — after the `pid === undefined` bailout
  // below has already returned. Without this, a mistyped command takes the
  // daemon down instead of failing the run.
  child.on("error", () => undefined);

  const pid = child.pid;
  if (pid === undefined) {
    await stdoutHandle.close();
    await stderrHandle.close();
    return err(
      makeError("WORKER_SPAWN_FAILED", "worker could not be started", {
        details: { command: options.command },
      }),
    );
  }

  const startedAtMs = clock.now();
  const runLogger = logger.child({ component: "process-supervisor" });

  let reason: TerminationReason = "exited";
  let softTimeoutElapsed = false;
  let stdoutBytes = 0;
  let settled = false;

  const timers: TimerHandle[] = [];
  const clearTimers = (): void => {
    for (const timer of timers) clock.clearTimeout(timer);
    timers.length = 0;
  };

  /** SIGTERM, then SIGKILL after the grace period. */
  const terminate = (why: TerminationReason): void => {
    if (settled) return;
    // First cause wins: a cancellation during the termination grace period
    // must not relabel a timeout.
    if (reason === "exited") reason = why;

    runLogger.warn("terminating worker process group", { pid, reason: why });
    killGroup(pid, "SIGTERM");

    timers.push(
      clock.setTimeout(() => {
        if (settled) return;
        runLogger.warn("worker ignored SIGTERM; escalating to SIGKILL", {
          pid,
        });
        killGroup(pid, "SIGKILL");
      }, graceMs),
    );
  };

  timers.push(
    clock.setTimeout(() => {
      if (settled) return;
      softTimeoutElapsed = true;
      runLogger.warn("soft timeout elapsed", { pid });
      options.onSoftTimeout?.();
    }, options.softTimeoutMs),
  );

  timers.push(
    clock.setTimeout(() => {
      terminate("timed_out");
    }, options.hardTimeoutMs),
  );

  /** Poll the output size; the daemon is not in the data path, so it must ask. */
  const scheduleOutputCheck = (): void => {
    timers.push(
      clock.setTimeout(() => {
        if (settled) return;
        void stat(options.stdoutPath)
          .then((stats) => {
            stdoutBytes = stats.size;
            if (stdoutBytes > maxOutputBytes) {
              runLogger.warn("worker exceeded its output budget", {
                pid,
                stdoutBytes,
                maxOutputBytes,
              });
              terminate("output_limit");
              return;
            }
            scheduleOutputCheck();
          })
          .catch(() => {
            // The file may have been removed under us; nothing to enforce.
          });
      }, outputCheckMs),
    );
  };
  scheduleOutputCheck();

  const completed = new Promise<ProcessOutcome>((resolve) => {
    child.on("close", (code, signal) => {
      settled = true;
      clearTimers();

      void (async (): Promise<void> => {
        await stdoutHandle.close().catch(() => undefined);
        await stderrHandle.close().catch(() => undefined);

        // One last measurement: the process may have written between the final
        // periodic check and its exit.
        const finalSize = await stat(options.stdoutPath)
          .then((stats) => stats.size)
          .catch(() => stdoutBytes);

        resolve({
          pid,
          startedAtMs,
          durationMs: clock.now() - startedAtMs,
          exitCode: code,
          signal,
          reason,
          softTimeoutElapsed,
          stdoutBytes: finalSize,
        });
      })();
    });

    child.on("error", (error) => {
      // Spawn-time failures surface here on some platforms rather than throwing.
      settled = true;
      clearTimers();
      runLogger.error("worker process error", { pid, error });
      resolve({
        pid,
        startedAtMs,
        durationMs: clock.now() - startedAtMs,
        exitCode: null,
        signal: null,
        reason,
        softTimeoutElapsed,
        stdoutBytes,
      });
    });
  });

  // Deliberately *not* `child.unref()`. Observing the exit is this component's
  // entire purpose: an unreferenced child lets the event loop drain before the
  // `close` event arrives, and the run's outcome is then never recorded.
  // Detaching from a worker is an explicit operation (cancel, or accept the
  // orphan), never a side effect of the daemon having nothing else to do.

  return ok({
    pid,
    startedAtMs,
    cancel: () => {
      terminate("cancelled");
    },
    completed,
  });
}
