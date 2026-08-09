/** Supervised, non-interactive Codex CLI runner. */
import { appendFile, open } from "node:fs/promises";

import {
  NdjsonStream,
  makeError,
  parseAgentResult,
  PROTOCOL_VERSION,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type AgentdError,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import {
  superviseProcess,
  type ProcessOutcome,
  type SupervisorOptions,
} from "@pi-cmux/process-supervisor";
import { err, ok, type Result } from "@pi-cmux/protocol";
import { CodexEventNormalizer } from "./normalizer.ts";

export type AgentCapabilities = Readonly<{
  kind: "codex";
  supportsGracefulCancel: false;
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

export type CodexRunnerOptions = Readonly<{
  logger?: Logger;
  supervisor?: Partial<SupervisorOptions>;
  /** Override the executable for hermetic tests; defaults to `codex`. */
  command?: string;
}>;

export function capabilities(): AgentCapabilities {
  return {
    kind: "codex",
    supportsGracefulCancel: false,
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

/** Start `codex exec --json`; all provider arguments are an argv array. */
export async function start(
  args: StartArgs,
  options: CodexRunnerOptions = {},
): Promise<Result<RunHandle, AgentdError>> {
  const logger = (options.logger ?? nullLogger).child({
    component: "adapter:codex",
    runId: args.runId,
    taskId: args.task.taskId,
  });
  const workerArgv = [
    options.command ?? "codex",
    "exec",
    "--json",
    ...(args.task.constraints.mayWrite
      ? ["--full-auto"]
      : ["--sandbox", "read-only"]),
    args.task.objective,
  ];
  const [command, ...argv] = [...(args.argvPrefix ?? []), ...workerArgv];
  const supervised = await superviseProcess({
    command: command ?? "codex",
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

  // Codex emits provider records, not AgentResult. Append one only after the
  // process has closed; agentd still validates it and overwrites observations.
  const completed = supervised.value.completed.then(async (outcome) => {
    const succeeded = outcome.reason === "exited" && outcome.exitCode === 0;
    const result: AgentResult = {
      protocolVersion: PROTOCOL_VERSION,
      taskId: args.task.taskId,
      runId: args.runId,
      status: succeeded ? "succeeded" : "failed",
      summary: succeeded
        ? "Codex completed"
        : "Codex did not complete successfully",
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes: { worktreePath: args.task.workspace.worktreePath, dirty: false },
      warnings: [],
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
  logger.info("codex worker started", { pid: supervised.value.pid });
  return ok({
    ...supervised.value,
    runId: args.runId,
    taskId: args.task.taskId,
    completed,
  });
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
    const normalizer = new CodexEventNormalizer({
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
  const normalizer = new CodexEventNormalizer(options);
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
