/**
 * The fake `AgentRunner`.
 *
 * P1's only execution path. It drives a *real* child process — the testkit
 * replay worker — through the *real* supervisor, and normalizes its NDJSON into
 * `AgentEvent`s exactly as a provider adapter will. Only the provider is fake.
 *
 * This file is also the shape every P3 adapter follows, so two boundaries are
 * worth naming:
 *
 *   - An adapter **normalizes**; it does not decide. No scheduling, no policy,
 *     no worktree creation, no reaching into another run.
 *   - An adapter **tolerates its provider**. A malformed line is skipped and
 *     counted. A line whose envelope is invalid is skipped and counted. Neither
 *     ends the stream, because a provider's bad record must not cost us the
 *     records after it.
 */

import { open } from "node:fs/promises";

import {
  makeError,
  parseAgentEvent,
  type AgentEvent,
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
import { replayWorkerPath } from "@pi-cmux/testkit";
import { err, ok, type Result } from "@pi-cmux/protocol";

import { NdjsonStream } from "./ndjson-stream.ts";

export type AgentCapabilities = Readonly<{
  kind: "fake";
  /** Whether the provider can be told to stop without being killed. */
  supportsGracefulCancel: boolean;
  supportsStructuredOutput: boolean;
  /** Payload types this adapter can emit. */
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
  /** Lines that could not be decoded or did not validate as an event. */
  rejected: number;
  /** Byte offset to resume reading from. */
  offset: number;
}>;

export type FakeRunnerOptions = Readonly<{
  /** Flags for the replay worker; how a test picks a failure mode. */
  workerArgs?: readonly string[];
  logger?: Logger;
  supervisor?: Partial<SupervisorOptions>;
}>;

export function capabilities(): AgentCapabilities {
  return {
    kind: "fake",
    // The replay worker exits on SIGTERM unless told not to, but there is no
    // in-band "please stop" message. Cancellation is signal-based.
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
  /**
   * Environment supplied by the sandbox placement. When absent the adapter
   * builds its own allowlisted environment, which carries no credentials.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Command prefix from the sandbox placement — the wrapper that actually
   * enforces isolation. It is prepended to the worker's argv as part of the
   * same argument array, so there is still no shell anywhere in the chain.
   */
  argvPrefix?: readonly string[];
}>;

/**
 * Launch the fake worker under supervision.
 *
 * The environment is built by allowlist and carries no credentials: the fake
 * provider needs none, and a worker that does not need a secret must not be
 * handed one (spec §18).
 */
export async function start(
  args: StartArgs,
  options: FakeRunnerOptions = {},
): Promise<Result<RunHandle, AgentdError>> {
  const logger = (options.logger ?? nullLogger).child({
    component: "adapter:fake",
    runId: args.runId,
    taskId: args.task.taskId,
  });

  // A sandbox that wraps the worker becomes argv[0]; the worker's own command
  // follows it unchanged. An empty prefix means nothing wraps it.
  const workerArgv = [
    process.execPath,
    replayWorkerPath(),
    ...(options.workerArgs ?? ["--emit", "3"]),
  ];
  const prefix = args.argvPrefix ?? [];
  const [command, ...argv] =
    prefix.length > 0 ? [...prefix, ...workerArgv] : workerArgv;

  const supervised = await superviseProcess({
    command: command ?? process.execPath,
    args: argv,
    cwd: args.cwd,
    env:
      args.env === undefined
        ? buildWorkerEnvironment({
            source: process.env,
            // PATH and HOME only; no provider credentials of any kind.
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

  logger.info("fake worker started", { pid: supervised.value.pid });

  return ok({
    runId: args.runId,
    taskId: args.task.taskId,
    pid: supervised.value.pid,
    startedAtMs: supervised.value.startedAtMs,
    cancel: supervised.value.cancel,
    completed: supervised.value.completed,
  });
}

/**
 * Read new bytes from a worker's stdout file and normalize them.
 *
 * Reading from the **file**, not a pipe, is what makes this resumable: `offset`
 * comes from durable metadata, so a daemon that restarts mid-run picks up
 * exactly where it left off and the store's idempotency covers any overlap.
 */
export async function readEvents(
  stdoutPath: string,
  offset: number,
  options: { atEof?: boolean } = {},
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
    if (offset > stats.size) {
      // The file shrank. Either it was truncated or this is a different run's
      // file; either way the recorded offset is meaningless and continuing
      // would misattribute records.
      return err(
        makeError("STORE_CORRUPT", "worker output is shorter than the offset", {
          details: { offset, size: stats.size },
        }),
      );
    }

    const length = stats.size - offset;
    const stream = new NdjsonStream();
    const records: { value: unknown }[] = [];
    let rejected = 0;

    if (length > 0) {
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, offset);

      const pushed = stream.push(buffer.toString("utf8"));
      records.push(...pushed.records);
      rejected += pushed.rejected;
    }

    // Only once the producer has definitely finished may the trailing fragment
    // be treated as a record. While the worker is live those bytes stay
    // pending — a half-written line is not a short one.
    if (options.atEof === true) {
      const finished = stream.finish();
      records.push(...finished.records);
      rejected += finished.rejected;
    }

    const { events, invalid } = validateRecords(records);

    return ok({
      events,
      rejected: rejected + invalid,
      // `stream.offset` counts only bytes consumed as complete records, so a
      // pending fragment is re-read next time rather than skipped.
      offset: offset + stream.offset,
    });
  } finally {
    await handle.close();
  }
}

/**
 * Validate decoded records into events.
 *
 * A JSON object that is not one of our events is counted, not fatal: providers
 * emit their own bookkeeping records, and P3 adapters map those before they get
 * here. Dropping the rest of the stream over one would be a provider outage.
 */
function validateRecords(records: readonly { value: unknown }[]): {
  events: AgentEvent[];
  invalid: number;
} {
  const events: AgentEvent[] = [];
  let invalid = 0;

  for (const record of records) {
    const parsed = parseAgentEvent(record.value);
    if (parsed.ok) {
      events.push(parsed.value);
    } else {
      invalid += 1;
    }
  }

  return { events, invalid };
}

/**
 * Normalize a complete NDJSON blob into events.
 *
 * The simple path, for a worker that has already exited: everything on disk is
 * final, so the trailing fragment can be taken as a record if it parses.
 */
export function normalizeStream(raw: string): NormalizedBatch {
  const stream = new NdjsonStream();
  const pushed = stream.push(raw);
  const finished = stream.finish();

  const { events, invalid } = validateRecords([
    ...pushed.records,
    ...finished.records,
  ]);

  return {
    events,
    rejected: pushed.rejected + finished.rejected + invalid,
    offset: stream.offset,
  };
}
