/**
 * Supervised, non-interactive Claude Code CLI runner.
 *
 * `--bare` is not an optimization here, it is the security boundary: without
 * it, `claude -p` auto-discovers hooks, skills, plugins, MCP servers, auto
 * memory and `CLAUDE.md` from the host and the target repository, which is
 * exactly the "silently load an MCP server / hook / plugin" path CLAUDE.md
 * forbids for untrusted repository content. `--bare` also means the CLI
 * cannot fall back to an interactive OAuth/keychain login, so auth must be
 * supplied as `ANTHROPIC_API_KEY` through the allowlisted environment —
 * consistent with "no host credentials into an untrusted worker".
 */
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
  buildWorkerEnvironment,
  superviseProcess,
  type ProcessOutcome,
  type SupervisorOptions,
} from "@pi-cmux/process-supervisor";
import { err, ok, type Result } from "@pi-cmux/protocol";
import { ClaudeEventNormalizer } from "./normalizer.ts";

export type AgentCapabilities = Readonly<{
  kind: "claude";
  /**
   * Confirmed both from docs.claude.com ("Run Claude Code programmatically")
   * and a live SIGTERM against a running `claude -p ... --output-format
   * stream-json` process (2026-08-08, CLI v2.1.226, stdout to a plain file):
   * the process exits 143 with a clean, non-truncated NDJSON tail — a
   * supervised shutdown, not a crash.
   */
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

export type ClaudeRunnerOptions = Readonly<{
  logger?: Logger;
  supervisor?: Partial<SupervisorOptions>;
  /** Override the executable for hermetic tests; defaults to `claude`. */
  command?: string;
}>;

export function capabilities(): AgentCapabilities {
  return {
    kind: "claude",
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
  env?: Readonly<Record<string, string>>;
  argvPrefix?: readonly string[];
}>;

/** Start `claude -p --output-format stream-json`; all provider arguments are an argv array. */
export async function start(
  args: StartArgs,
  options: ClaudeRunnerOptions = {},
): Promise<Result<RunHandle, AgentdError>> {
  const logger = (options.logger ?? nullLogger).child({
    component: "adapter:claude",
    runId: args.runId,
    taskId: args.task.taskId,
  });
  const workerArgv = [
    options.command ?? "claude",
    "-p",
    args.task.objective,
    "--output-format",
    "stream-json",
    "--verbose",
    "--bare",
    "--permission-mode",
    args.task.constraints.mayWrite ? "acceptEdits" : "dontAsk",
  ];
  const [command, ...argv] = [...(args.argvPrefix ?? []), ...workerArgv];
  const supervised = await superviseProcess({
    command: command ?? "claude",
    args: argv,
    cwd: args.cwd,
    env:
      args.env === undefined
        ? buildWorkerEnvironment({
            source: process.env,
            // CLAUDE_CODE_OAUTH_TOKEN is documented as a valid long-lived
            // auth token for the Claude Code CLI generally; it is allowlisted
            // defensively but ANTHROPIC_API_KEY is the confirmed path in
            // `--bare` mode specifically (bare mode never reads the OAuth
            // keychain).
            allow: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
          })
        : { ...args.env },
    stdoutPath: args.stdoutPath,
    stderrPath: args.stderrPath,
    softTimeoutMs: args.task.limits.softTimeoutMs,
    hardTimeoutMs: args.task.limits.hardTimeoutMs,
    logger,
    ...options.supervisor,
  });
  if (!supervised.ok) return supervised;

  // Claude Code emits provider records, not AgentResult. Append one only
  // after the process has closed; agentd still validates it and overwrites
  // observations.
  const completed = supervised.value.completed.then(async (outcome) => {
    const succeeded = outcome.reason === "exited" && outcome.exitCode === 0;
    const result: AgentResult = {
      protocolVersion: PROTOCOL_VERSION,
      taskId: args.task.taskId,
      runId: args.runId,
      status: succeeded ? "succeeded" : "failed",
      summary: succeeded
        ? "Claude Code completed"
        : "Claude Code did not complete successfully",
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
  logger.info("claude worker started", { pid: supervised.value.pid });
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
    const normalizer = new ClaudeEventNormalizer({
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
  const normalizer = new ClaudeEventNormalizer(options);
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
