/**
 * Supervised, non-interactive Antigravity CLI (`agy`) runner.
 *
 * Invocation follows the official headless-mode reference at
 * https://antigravity.google/docs/cli/headless (fetched 2026-08-08):
 * `agy -p "<prompt>" --output-format stream-json`, exit 0 for a successful
 * run *or* a soft-denied permission, non-zero for a hard failure.
 *
 * Authentication: the docs state headless mode "uses your cached
 * credentials" from a prior interactive login and do not document an
 * environment variable for CI/non-interactive auth. Rather than guess a
 * variable name, this runner allowlists no provider-specific credential by
 * default; callers that have confirmed a real mechanism can still supply it
 * through `args.env`.
 *
 * Verified 2026-08-08 against the installed `agy` v1.1.11 binary with stdout
 * redirected to a plain file (`agy -p "..." --output-format stream-json >
 * file`) — agentd's actual spawn model, never a pty. Third-party reports
 * (a community "agy-headless-bridge" tool, Windows-specific) describe `agy`
 * producing no output at all when stdout is not a TTY; that did not
 * reproduce here; NDJSON came through normally. Worth re-checking if a
 * future `agy` version or a non-macOS host behaves differently, but this is
 * not currently treated as a blocking risk.
 */
import { appendFile, open, readFile } from "node:fs/promises";

import {
  NdjsonStream,
  err,
  makeError,
  ok,
  parseAgentResult,
  PROTOCOL_VERSION,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import {
  superviseProcess,
  type ProcessOutcome,
  type SupervisorOptions,
} from "@pi-cmux/process-supervisor";
import {
  AntigravityEventNormalizer,
  normalizeAntigravityStream,
} from "./normalizer.ts";

export type AgentCapabilities = Readonly<{
  kind: "antigravity";
  /** SIGINT during headless mode yields a documented `INTERRUPTED` status. */
  supportsGracefulCancel: true;
  supportsStructuredOutput: true;
  eventTypes: readonly AgentEvent["type"][];
}>;

export type RunHandle = Readonly<{
  runId: string;
  taskId: string;
  pid: number;
  startedAtMs: number;
  cancel: () => void;
  completed: Promise<ProcessOutcome>;
}>;

export type NormalizedBatch = Readonly<{
  events: readonly AgentEvent[];
  results: readonly AgentResult[];
  rejected: number;
  offset: number;
}>;

export type AntigravityRunnerOptions = Readonly<{
  logger?: Logger;
  supervisor?: Partial<SupervisorOptions>;
  /** Override the executable for hermetic tests; defaults to `agy`. */
  command?: string;
}>;

export function capabilities(): AgentCapabilities {
  return {
    kind: "antigravity",
    supportsGracefulCancel: true,
    supportsStructuredOutput: true,
    eventTypes: [
      "status",
      "log",
      "tool",
      "artifact",
      "test",
      "policy",
      "heartbeat",
    ],
  };
}

export type StartArgs = Readonly<{
  task: AgentTask;
  runId: string;
  stdoutPath: string;
  stderrPath: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  argvPrefix?: readonly string[];
}>;

/** Start `agy -p <objective> --output-format stream-json`. */
export async function start(
  args: StartArgs,
  options: AntigravityRunnerOptions = {},
): Promise<Result<RunHandle, AgentdError>> {
  const logger = (options.logger ?? nullLogger).child({
    component: "adapter:antigravity",
    runId: args.runId,
    taskId: args.task.taskId,
  });
  const workerArgv = [
    options.command ?? "agy",
    "-p",
    args.task.objective,
    "--output-format",
    "stream-json",
    ...(args.task.constraints.mayWrite
      ? ["--dangerously-skip-permissions"]
      : []),
  ];
  const [command, ...argv] = [...(args.argvPrefix ?? []), ...workerArgv];
  const supervised = await superviseProcess({
    command: command ?? "agy",
    args: argv,
    cwd: args.cwd,
    env: { ...args.env },
    stdoutPath: args.stdoutPath,
    stderrPath: args.stderrPath,
    softTimeoutMs: args.task.limits.softTimeoutMs,
    hardTimeoutMs: args.task.limits.hardTimeoutMs,
    logger,
    ...options.supervisor,
  });
  if (!supervised.ok) return supervised;

  // Antigravity emits provider records, not AgentResult. Append one only
  // after the process has closed; agentd still validates it and overwrites
  // observations.
  //
  // Exit code alone is not proof of success: a denied tool call still lets
  // `agy` exit 0, and even its own `result` envelope can claim
  // `status: "SUCCESS"` afterward (see
  // fixtures/antigravity/captured-tool-error-example.ndjson). The only
  // signal that does not lie is the step-level `state: "ERROR"` on a `tool`
  // step, which the normalizer already tracks — so an exit-0 run is
  // re-checked against the full transcript before it is trusted, and a run
  // that saw a denied tool call is reported `"blocked"` rather than
  // `"succeeded"`.
  const completed = supervised.value.completed.then(async (outcome) => {
    const exitedZero = outcome.reason === "exited" && outcome.exitCode === 0;
    const sawToolError = exitedZero
      ? await detectToolError(args.stdoutPath, args.task.taskId, args.runId)
      : false;
    const status = exitedZero
      ? sawToolError
        ? "blocked"
        : "succeeded"
      : "failed";
    const result: AgentResult = {
      protocolVersion: PROTOCOL_VERSION,
      taskId: args.task.taskId,
      runId: args.runId,
      status,
      summary:
        status === "succeeded"
          ? "Antigravity completed"
          : status === "blocked"
            ? "Antigravity denied a tool call during the run"
            : "Antigravity did not complete successfully",
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes: { worktreePath: args.task.workspace.worktreePath, dirty: false },
      warnings: [],
      ...(status === "succeeded"
        ? {}
        : {
            failure:
              status === "blocked"
                ? {
                    code: "WORKER_PERMISSION_DENIED" as const,
                    safeMessage: "a tool call was denied during the run",
                    retryable: false,
                  }
                : {
                    code: "WORKER_EXITED_NONZERO" as const,
                    safeMessage: "Antigravity did not complete successfully",
                    retryable: false,
                  },
          }),
    };
    const parsed = parseAgentResult(result);
    if (parsed.ok)
      await appendFile(
        args.stdoutPath,
        `${JSON.stringify(parsed.value)}\n`,
        "utf8",
      );
    return outcome;
  });
  logger.info("antigravity worker started", { pid: supervised.value.pid });
  return ok({
    ...supervised.value,
    runId: args.runId,
    taskId: args.task.taskId,
    completed,
  });
}

/**
 * Re-normalizes the whole transcript once, at process completion, purely to
 * answer "did any tool step ever report an error" — one full re-parse is
 * cheap next to the process that just ran, and simpler than threading a
 * long-lived normalizer instance through `readEvents`'s incremental,
 * offset-based reads. A read failure (e.g. no output was ever produced)
 * falls back to `false`: the exit-code-derived status stands on its own in
 * that case, same as before this check existed.
 */
async function detectToolError(
  stdoutPath: string,
  taskId: string,
  runId: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(stdoutPath, "utf8");
  } catch {
    return false;
  }
  return normalizeAntigravityStream(raw, { taskId, runId }).sawToolError;
}

export type ReadEventsOptions = Readonly<{
  atEof?: boolean;
  taskId: string;
  runId: string;
}>;

export async function readEvents(
  stdoutPath: string,
  offset: number,
  options: ReadEventsOptions,
): Promise<Result<NormalizedBatch, AgentdError>> {
  let handle;
  try {
    handle = await open(stdoutPath, "r");
  } catch (cause) {
    return err(
      makeError("STORE_IO_FAILED", "could not open worker output", { cause }),
    );
  }
  try {
    const stats = await handle.stat();
    if (offset > stats.size)
      return err(
        makeError("STORE_CORRUPT", "worker output is shorter than the offset", {
          details: { offset, size: stats.size },
        }),
      );
    const length = stats.size - offset;
    const buffer = Buffer.allocUnsafe(length);
    if (length > 0) await handle.read(buffer, 0, length, offset);
    const stream = new NdjsonStream();
    const pushed =
      length > 0
        ? stream.push(buffer.toString("utf8"))
        : {
            records: [],
            rejected: 0,
            consumedBytes: 0,
            pendingBytes: 0,
            overflowed: false,
          };
    const finished = options.atEof === true ? stream.finish() : undefined;
    const results: AgentResult[] = [];
    const providerRecords: unknown[] = [];
    for (const record of [...pushed.records, ...(finished?.records ?? [])]) {
      const parsed = parseAgentResult(record.value);
      if (parsed.ok) results.push(parsed.value);
      else providerRecords.push(record.value);
    }
    const normalizer = new AntigravityEventNormalizer({
      taskId: options.taskId,
      runId: options.runId,
    });
    const translated = normalizer.push(
      providerRecords.map((value) => `${JSON.stringify(value)}\n`).join(""),
    );
    const tail =
      finished === undefined
        ? { events: [], rejected: 0 }
        : normalizer.finish();
    return ok({
      events: [...translated.events, ...tail.events],
      results,
      rejected:
        pushed.rejected +
        (finished?.rejected ?? 0) +
        translated.rejected +
        tail.rejected,
      offset: offset + stream.offset,
    });
  } finally {
    await handle.close();
  }
}

export function normalizeStream(
  raw: string,
  options: { taskId: string; runId: string },
): NormalizedBatch {
  const framing = new NdjsonStream();
  const pushedRecords = framing.push(raw);
  const finishedRecords = framing.finish();
  const records = [...pushedRecords.records, ...finishedRecords.records];
  const results: AgentResult[] = [];
  const provider = records.flatMap((record) => {
    const parsed = parseAgentResult(record.value);
    if (parsed.ok) {
      results.push(parsed.value);
      return [];
    }
    return [record.value];
  });
  const normalizer = new AntigravityEventNormalizer(options);
  const pushed = normalizer.push(
    provider.map((value) => `${JSON.stringify(value)}\n`).join(""),
  );
  const finished = normalizer.finish();
  return {
    events: [...pushed.events, ...finished.events],
    results,
    rejected:
      pushedRecords.rejected +
      finishedRecords.rejected +
      pushed.rejected +
      finished.rejected,
    offset: framing.offset,
  };
}
