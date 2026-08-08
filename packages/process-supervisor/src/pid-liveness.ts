/**
 * "Is our worker still running?"
 *
 * `kill(pid, 0)` answers a different question than the one recovery needs. It
 * says whether *a* process with that number exists — and PIDs are recycled. On
 * a busy machine, a daemon that was down for an hour can easily find pid 4711
 * alive and belonging to someone else's text editor.
 *
 * So liveness is two checks:
 *
 *   1. does the pid exist at all;
 *   2. did it start when we recorded our worker starting.
 *
 * The second reads the process's start time from `ps`. If `ps` cannot answer,
 * the result is `"unknown"`, never `"alive"` — an unverifiable process must not
 * be treated as ours.
 *
 * That degradation is quiet, which makes the choice of `ps` field load-bearing:
 * a field the platform rejects turns every surviving worker into an orphan with
 * nothing in the outcome to say why. See `pidStartTimeMs`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Tolerance when matching a recorded start time against `ps`. */
export const START_TIME_TOLERANCE_MS = 5_000;

export type Liveness = "alive" | "dead" | "unknown";

/**
 * Whether *some* process holds this pid.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but belongs to another user —
 * which, for our purposes, means it is not ours.
 */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return false;
    return false;
  }
}

/** Runs `ps -p <pid> -o <field>=` with an argv array and no shell. */
async function psField(
  pid: number,
  field: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", `${field}=`],
      { timeout: 5_000 },
    );
    const value = stdout.trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Parse `etime`, which both BSD and GNU `ps` render as `[[dd-]hh:]mm:ss`.
 */
function parseEtime(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (match === null) return undefined;

  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/**
 * When a pid started, in epoch milliseconds.
 *
 * `lstart` first: it is an absolute timestamp, so no arithmetic against the
 * current clock is needed and a clock adjustment between the two readings
 * cannot skew the answer. `etime` is the fallback.
 *
 * Note there is deliberately no use of `etimes` (plural). It is a GNU/procps
 * extension that macOS `ps` rejects outright — and because an unanswerable
 * query degrades to `"unknown"`, relying on it silently orphaned every
 * surviving worker on the project's primary development platform.
 *
 * Returns `undefined` when the process is gone or `ps` cannot answer.
 */
export async function pidStartTimeMs(
  pid: number,
  now: () => number = Date.now,
): Promise<number | undefined> {
  const lstart = await psField(pid, "lstart");
  if (lstart !== undefined) {
    const parsed = Date.parse(lstart);
    if (Number.isFinite(parsed)) return parsed;
  }

  const etime = await psField(pid, "etime");
  if (etime !== undefined) {
    const seconds = parseEtime(etime);
    if (seconds !== undefined) return now() - seconds * 1_000;
  }

  return undefined;
}

/**
 * Whether the pid we recorded is still the process we launched.
 *
 * Returns `"unknown"` rather than guessing when the pid exists but its start
 * time cannot be confirmed. A caller must treat `"unknown"` the same as an
 * indeterminate outcome — that is what `ORPHANED` is for.
 */
export async function verifyWorkerAlive(
  pid: number,
  recordedStartedAtMs: number,
  now: () => number = Date.now,
  toleranceMs: number = START_TIME_TOLERANCE_MS,
): Promise<Liveness> {
  if (!pidExists(pid)) return "dead";

  const observedStartMs = await pidStartTimeMs(pid, now);
  if (observedStartMs === undefined) {
    // The pid exists but we cannot prove it is ours.
    return "unknown";
  }

  const drift = Math.abs(observedStartMs - recordedStartedAtMs);

  // A pid that exists but started at a different time is a recycled number
  // belonging to someone else. Reporting it dead is correct: *our* process is.
  return drift <= toleranceMs ? "alive" : "dead";
}
