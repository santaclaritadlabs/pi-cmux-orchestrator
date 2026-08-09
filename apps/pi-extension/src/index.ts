/** First-party Pi integration. It talks to agentd; it never starts workers. */
import { z } from "zod";

import { connectToDaemon, type DaemonClient } from "@pi-cmux/agentd";
import {
  DEFAULT_EVENT_PAGE_SIZE,
  err,
  fromThrown,
  makeError,
  ok,
  parseAgentEvent,
  parseAgentResult,
  parseAgentTask,
  runIdSchema,
  type AgentEvent,
  type AgentResult,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

export type RunRecord = Readonly<{
  runId: string;
  taskId: string;
  state:
    | "QUEUED"
    | "PREPARING"
    | "RUNNING"
    | "BLOCKED"
    | "CANCELLED"
    | "FAILED"
    | "VALIDATING"
    | "SUCCEEDED"
    | "ORPHANED";
  createdAt: string;
  updatedAt: string;
}>;

export type DaemonHealth = Readonly<{
  status: "ok";
  pid: number;
  liveRuns: number;
  uptimeMs: number;
}>;

const runRecordSchema = z
  .strictObject({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    state: z.enum([
      "QUEUED",
      "PREPARING",
      "RUNNING",
      "BLOCKED",
      "CANCELLED",
      "FAILED",
      "VALIDATING",
      "SUCCEEDED",
      "ORPHANED",
    ]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .readonly();

const daemonHealthSchema = z
  .strictObject({
    status: z.literal("ok"),
    pid: z.int().positive(),
    liveRuns: z.int().nonnegative(),
    uptimeMs: z.number().nonnegative(),
  })
  .readonly();

export type PiConnectionOptions = Readonly<{
  socketPath: string;
  token?: string;
  tokenPath?: string;
  requestTimeoutMs?: number;
}>;

export type StatusSnapshot = Readonly<{
  run: RunRecord;
  latestEvent?: AgentEvent;
  eventCount: number;
}>;

export type WatchOptions = Readonly<{
  intervalMs?: number;
  signal?: AbortSignal;
  onSnapshot: (snapshot: StatusSnapshot) => void | Promise<void>;
}>;

function invalidResponse(label: string): Result<never, AgentdError> {
  return err(makeError("RPC_MALFORMED", `${label} response was invalid`));
}

function parseRunRecord(value: unknown): Result<RunRecord, AgentdError> {
  const parsed = runRecordSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : invalidResponse("agentd run");
}

function parseHealth(value: unknown): Result<DaemonHealth, AgentdError> {
  const parsed = daemonHealthSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : invalidResponse("agentd health");
}

function parseRunResult(value: unknown): Result<AgentResult, AgentdError> {
  const parsed = parseAgentResult(value);
  return parsed.ok ? parsed : invalidResponse("agentd result");
}

function isTerminal(state: RunRecord["state"]): boolean {
  return (
    state === "BLOCKED" ||
    state === "CANCELLED" ||
    state === "FAILED" ||
    state === "ORPHANED" ||
    state === "SUCCEEDED"
  );
}

function sleep(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      finish();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validRunId(runId: string): boolean {
  return runIdSchema.safeParse(runId).success;
}

export class PiAgentdBridge {
  private readonly daemon: DaemonClient;

  private constructor(daemon: DaemonClient) {
    this.daemon = daemon;
  }

  static async connect(
    options: PiConnectionOptions,
  ): Promise<Result<PiAgentdBridge, AgentdError>> {
    const connected = await connectToDaemon({
      ...options,
      client: "pi-extension",
    });
    return connected.ok ? ok(new PiAgentdBridge(connected.value)) : connected;
  }

  static fromClient(client: DaemonClient): PiAgentdBridge {
    return new PiAgentdBridge(client);
  }

  close(): void {
    this.daemon.close();
  }

  async createTask(task: unknown): Promise<Result<RunRecord, AgentdError>> {
    const valid = parseAgentTask(task);
    if (!valid.ok) return valid;
    const response = await this.daemon.call("task.create", {
      task: valid.value,
    });
    return response.ok ? parseRunRecord(response.value) : response;
  }

  async createAndStart(task: unknown): Promise<Result<RunRecord, AgentdError>> {
    const created = await this.createTask(task);
    if (!created.ok) return created;
    return await this.start(created.value.runId);
  }

  async health(): Promise<Result<DaemonHealth, AgentdError>> {
    const response = await this.daemon.call("daemon.health");
    return response.ok ? parseHealth(response.value) : response;
  }

  async start(runId: string): Promise<Result<RunRecord, AgentdError>> {
    const response = await this.daemon.call("task.start", { runId });
    return response.ok ? parseRunRecord(response.value) : response;
  }

  async status(runId: string): Promise<Result<RunRecord, AgentdError>> {
    const response = await this.daemon.call("task.status", { runId });
    return response.ok ? parseRunRecord(response.value) : response;
  }

  async cancel(runId: string): Promise<Result<RunRecord, AgentdError>> {
    const response = await this.daemon.call("task.cancel", { runId });
    return response.ok ? parseRunRecord(response.value) : response;
  }

  async result(runId: string): Promise<Result<AgentResult, AgentdError>> {
    const response = await this.daemon.call("task.result", { runId });
    return response.ok ? parseRunResult(response.value) : response;
  }

  async events(
    runId: string,
    sinceSequence = -1,
    limit = DEFAULT_EVENT_PAGE_SIZE,
  ): Promise<Result<readonly AgentEvent[], AgentdError>> {
    if (!validRunId(runId)) return invalidResponse("agentd run id");
    const response = await this.daemon.call("task.events", {
      runId,
      sinceSequence,
      limit,
    });
    if (!response.ok) return response;
    if (!Array.isArray(response.value)) return invalidResponse("agentd events");
    const events: AgentEvent[] = [];
    let previous = sinceSequence;
    for (const value of response.value) {
      const parsed = parseAgentEvent(value);
      if (
        !parsed.ok ||
        parsed.value.runId !== runId ||
        parsed.value.sequence <= previous
      )
        return invalidResponse("agentd event");
      previous = parsed.value.sequence;
      events.push(parsed.value);
    }
    return ok(events);
  }

  /** Build a bounded status projection suitable for a cmux status pane. */
  async snapshot(
    runId: string,
    sinceSequence = -1,
  ): Promise<Result<StatusSnapshot, AgentdError>> {
    const [run, events] = await Promise.all([
      this.status(runId),
      this.events(runId, sinceSequence),
    ]);
    if (!run.ok) return run;
    if (!events.ok) return events;
    if (events.value.some((event) => event.taskId !== run.value.taskId))
      return invalidResponse("agentd event");
    return ok({
      run: run.value,
      ...(events.value.length > 0
        ? { latestEvent: events.value[events.value.length - 1] }
        : {}),
      eventCount: events.value.length,
    });
  }

  /** Poll a run for a Pi/cmux status surface without owning task lifecycle. */
  async watch(
    runId: string,
    options: WatchOptions,
  ): Promise<Result<void, AgentdError>> {
    const intervalMs = options.intervalMs ?? 250;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 25 ||
      intervalMs > 60_000
    ) {
      return err(
        makeError("SCHEMA_INVALID", "status polling interval is invalid"),
      );
    }
    let sinceSequence = -1;
    while (options.signal?.aborted !== true) {
      const snapshot = await this.snapshot(runId, sinceSequence);
      if (!snapshot.ok) return snapshot;
      try {
        await options.onSnapshot(snapshot.value);
      } catch (cause) {
        return err(fromThrown("INTERNAL", "the status consumer failed", cause));
      }
      const latest = snapshot.value.latestEvent?.sequence;
      if (latest !== undefined) sinceSequence = latest;
      if (isTerminal(snapshot.value.run.state)) return ok(undefined);
      await sleep(intervalMs, options.signal);
    }
    return ok(undefined);
  }
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const event = snapshot.latestEvent;
  const detail =
    event === undefined
      ? "no events"
      : `${event.type} #${String(event.sequence)}`;
  return `${snapshot.run.state} ${snapshot.run.runId} · ${detail}`;
}

export {
  CmuxStatusConsumer,
  createCmuxTextSink,
  type CmuxConsumerOptions,
  type CmuxStatusMessage,
  type CmuxStatusSink,
} from "./cmux-consumer.ts";
