/**
 * Argument parsing for the fake worker.
 *
 * Split from `replay.ts` so the parser is unit-testable without spawning a
 * process. Parsing is strict — an unknown flag is an error rather than being
 * ignored — because a test that silently loses a failure-mode flag would pass
 * for the wrong reason.
 */

import { err, ok, type Result } from "@pi-cmux/protocol";

export type ReplayOptions = Readonly<{
  /** NDJSON file to replay verbatim. Mutually exclusive with `emit`. */
  fixture?: string;
  /** Number of synthetic, schema-valid events to emit. */
  emit: number;
  runId: string;
  taskId: string;
  /** Assigned worktree, copied into the worker's terminal result claim. */
  worktreePath: string;
  /** Delay between records; lets a test cancel mid-stream deterministically. */
  delayMs: number;
  /** Delay before the first record. */
  startupDelayMs: number;
  exitCode: number;

  // --- failure modes, each mapping to a case CLAUDE.md requires covered ---
  /** Never exit. Exercises the hard timeout. */
  hang: boolean;
  /** Ignore SIGTERM, forcing the supervisor to escalate to SIGKILL. */
  ignoreSigterm: boolean;
  /** Finish with a truncated record, as a killed process would. */
  partialLine: boolean;
  /** Emit no terminal result, so completion cannot be inferred from the stream. */
  noTerminalResult: boolean;
  /** Emit the terminal result twice, which the adapter must reject. */
  duplicateTerminalResult: boolean;
  /** Inject this many unparseable lines among the valid ones. */
  malformedLines: number;
  /** Emit at least this many bytes, to trip the output ceiling. */
  floodBytes: number;
  /**
   * Write at least this many bytes to stderr.
   *
   * The stdout flood models a talkative worker; this models the other disk
   * exhaustion path — a crash loop or a provider dumping diagnostics — which
   * carries no protocol content and so is bounded separately.
   */
  floodStderrBytes: number;
  /** Emit a duplicate sequence number. */
  duplicateSequence: boolean;
  /** Emit sequence numbers out of order. */
  outOfOrder: boolean;
  /** Text to write on stderr. */
  stderr?: string;
}>;

const DEFAULTS: ReplayOptions = {
  emit: 3,
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  taskId: "AUTH-41",
  worktreePath: "/tmp/pi-cmux-fake-worktree",
  delayMs: 0,
  startupDelayMs: 0,
  exitCode: 0,
  hang: false,
  ignoreSigterm: false,
  partialLine: false,
  noTerminalResult: false,
  duplicateTerminalResult: false,
  malformedLines: 0,
  floodBytes: 0,
  floodStderrBytes: 0,
  duplicateSequence: false,
  outOfOrder: false,
};

const BOOLEAN_FLAGS = {
  "--hang": "hang",
  "--ignore-sigterm": "ignoreSigterm",
  "--partial-line": "partialLine",
  "--no-terminal-result": "noTerminalResult",
  "--duplicate-terminal-result": "duplicateTerminalResult",
  "--duplicate-sequence": "duplicateSequence",
  "--out-of-order": "outOfOrder",
} as const;

const NUMBER_FLAGS = {
  "--emit": "emit",
  "--delay-ms": "delayMs",
  "--startup-delay-ms": "startupDelayMs",
  "--exit-code": "exitCode",
  "--malformed": "malformedLines",
  "--flood-bytes": "floodBytes",
  "--flood-stderr-bytes": "floodStderrBytes",
} as const;

const STRING_FLAGS = {
  "--fixture": "fixture",
  "--run-id": "runId",
  "--task-id": "taskId",
  "--stderr": "stderr",
  "--worktree-path": "worktreePath",
} as const;

function isKeyOf<T extends object>(
  obj: T,
  key: string,
): key is string & keyof T {
  return Object.hasOwn(obj, key);
}

export function parseReplayOptions(
  argv: readonly string[],
): Result<ReplayOptions, string> {
  const options: Record<string, unknown> = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) break;

    if (isKeyOf(BOOLEAN_FLAGS, flag)) {
      options[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }

    if (isKeyOf(NUMBER_FLAGS, flag)) {
      i += 1;
      const raw = argv[i];
      if (raw === undefined) return err(`${flag} requires a value`);
      const value = Number(raw);
      if (!Number.isInteger(value)) {
        return err(`${flag} requires an integer, got '${raw}'`);
      }
      options[NUMBER_FLAGS[flag]] = value;
      continue;
    }

    if (isKeyOf(STRING_FLAGS, flag)) {
      i += 1;
      const raw = argv[i];
      if (raw === undefined) return err(`${flag} requires a value`);
      options[STRING_FLAGS[flag]] = raw;
      continue;
    }

    return err(`unknown flag '${flag}'`);
  }

  // Assertion immediately after validation: every key came from one of the
  // three flag tables, each of which is keyed by a field of ReplayOptions.
  return ok(options as ReplayOptions);
}
