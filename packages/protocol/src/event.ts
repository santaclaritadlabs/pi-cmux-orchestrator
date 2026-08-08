/**
 * `AgentEvent` — normalized progress from a worker.
 *
 * The envelope is CLAUDE.md's: a flat record with an open `payload`. Keeping
 * the payload open is what makes the contract forward-compatible — a provider
 * gaining a field must not invalidate the envelope — while the *typed* payload
 * schemas below give core and the UI something better than `unknown` to work
 * with. Adapters normalize into the envelope; nothing provider-specific
 * survives past the adapter boundary.
 *
 * Two deliberate deviations from spec §7, recorded in docs/adr/0002:
 *
 *   - `runId` is present (a task can be attempted more than once, and events
 *     must attribute to the attempt, not just the task).
 *   - `agent` is *not* present. It is derivable from the run's metadata, and a
 *     denormalized copy on every event is a field that can drift.
 *
 * Ordering: events are append-only and ordered per run by `sequence`. Ingestion
 * is idempotent — a repeated `sequence` carrying identical content is dropped,
 * a repeated `sequence` carrying different content is a `SEQUENCE_CONFLICT`.
 */

import { z } from "zod";

import {
  LIMITS,
  type DeepExactOptional,
  type Expect,
  type MutuallyAssignable,
  boundedJsonObjectSchema,
  boundedText,
  digestSchema,
  relativePathSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
} from "./primitives.ts";
import { runStateSchema, type RunState } from "./run-state.ts";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./task.ts";

export const EVENT_TYPES = [
  /** Lifecycle transition. Payload carries the new `RunState`. */
  "status",
  /** Human-readable line from the worker. Untrusted content. */
  "log",
  /** A tool invocation started or finished. */
  "tool",
  /** The worker produced a file we are tracking by digest. */
  "artifact",
  /** A test result the worker reported. Claims, not proof. */
  "test",
  /** A policy decision was made. The audit trail. */
  "policy",
  /** Liveness signal; carries no semantics beyond "still alive". */
  "heartbeat",
] as const;

export type AgentEventType = (typeof EVENT_TYPES)[number];

export type AgentEvent = Readonly<{
  protocolVersion: ProtocolVersion;
  taskId: string;
  runId: string;
  /** Monotonic within a run, starting at 0. */
  sequence: number;
  timestamp: string;
  type: AgentEventType;
  payload: Readonly<Record<string, unknown>>;
}>;

const agentEventObject = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    runId: runIdSchema,
    sequence: z.int().min(0),
    timestamp: timestampSchema,
    type: z.enum(EVENT_TYPES),
    payload: boundedJsonObjectSchema,
  })
  .readonly();

export const agentEventSchema = agentEventObject;

type _EventMatchesSchema = Expect<
  MutuallyAssignable<
    DeepExactOptional<z.infer<typeof agentEventObject>>,
    AgentEvent
  >
>;

// --- typed payloads -------------------------------------------------------
//
// Parsed on demand by consumers that care. A payload that fails these schemas
// does not invalidate the event: the envelope is still a valid, orderable
// record and must still be persisted. That separation is what lets a stream
// survive provider protocol drift.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const statusPayloadSchema = z
  .strictObject({
    state: runStateSchema,
    detail: boundedText(LIMITS.freeTextMaxChars).optional(),
  })
  .readonly();

export const logPayloadSchema = z
  .strictObject({
    level: z.enum(LOG_LEVELS),
    /**
     * Worker output. CLAUDE.md treats this as untrusted input, so it is bounded
     * here and redacted before it reaches any log sink.
     */
    message: z.string().max(LIMITS.freeTextMaxChars),
  })
  .readonly();

export const toolPayloadSchema = z
  .strictObject({
    phase: z.enum(["started", "completed"]),
    /** Correlates start with completion. Cursor is known to drop completions. */
    callId: boundedText(LIMITS.identifierMaxChars),
    tool: boundedText(LIMITS.identifierMaxChars),
    exitCode: z.int().optional(),
    durationMs: z.int().min(0).optional(),
  })
  .readonly();

export const artifactPayloadSchema = z
  .strictObject({
    name: boundedText(LIMITS.identifierMaxChars),
    digest: digestSchema,
    path: relativePathSchema,
    bytes: z.int().min(0).optional(),
  })
  .readonly();

export const TEST_STATUSES = ["passed", "failed", "skipped"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const testPayloadSchema = z
  .strictObject({
    name: boundedText(LIMITS.freeTextMaxChars),
    status: z.enum(TEST_STATUSES),
    durationMs: z.int().min(0).optional(),
    message: z.string().max(LIMITS.freeTextMaxChars).optional(),
  })
  .readonly();

export const POLICY_DECISIONS = ["allowed", "denied"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const policyPayloadSchema = z
  .strictObject({
    decision: z.enum(POLICY_DECISIONS),
    /** The rule that decided, so an audit can be traced to a line of policy. */
    rule: boundedText(LIMITS.identifierMaxChars),
    reason: boundedText(LIMITS.freeTextMaxChars),
  })
  .readonly();

export const heartbeatPayloadSchema = z
  .strictObject({
    uptimeMs: z.int().min(0),
  })
  .readonly();

export type StatusPayload = Readonly<{ state: RunState; detail?: string }>;
export type LogPayload = Readonly<{ level: LogLevel; message: string }>;
export type ToolPayload = Readonly<{
  phase: "started" | "completed";
  callId: string;
  tool: string;
  exitCode?: number;
  durationMs?: number;
}>;
export type ArtifactPayload = Readonly<{
  name: string;
  digest: string;
  path: string;
  bytes?: number;
}>;
export type TestPayload = Readonly<{
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
}>;
export type PolicyPayload = Readonly<{
  decision: PolicyDecision;
  rule: string;
  reason: string;
}>;
export type HeartbeatPayload = Readonly<{ uptimeMs: number }>;

/** Maps each event type to the schema its payload should satisfy. */
export const PAYLOAD_SCHEMAS = {
  status: statusPayloadSchema,
  log: logPayloadSchema,
  tool: toolPayloadSchema,
  artifact: artifactPayloadSchema,
  test: testPayloadSchema,
  policy: policyPayloadSchema,
  heartbeat: heartbeatPayloadSchema,
} as const satisfies Record<AgentEventType, z.ZodType>;

/**
 * The event as a discriminated union, for consumers that want exhaustive
 * `switch` handling over typed payloads.
 */
export type TypedAgentEvent =
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "status";
      readonly payload: StatusPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "log";
      readonly payload: LogPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "tool";
      readonly payload: ToolPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "artifact";
      readonly payload: ArtifactPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "test";
      readonly payload: TestPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "policy";
      readonly payload: PolicyPayload;
    })
  | (Omit<AgentEvent, "type" | "payload"> & {
      readonly type: "heartbeat";
      readonly payload: HeartbeatPayload;
    });
