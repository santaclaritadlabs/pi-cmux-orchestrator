import { z } from "zod";

import {
  ERROR_CODES,
  makeError,
  type AgentdError,
  type ErrorCode,
  type ErrorDetails,
} from "./errors.ts";
import { runIdSchema, LIMITS, boundedText } from "./primitives.ts";
import { PROTOCOL_VERSION } from "./task.ts";

/** Longest request or response frame accepted over the local RPC socket. */
export const MAX_RPC_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_EVENT_PAGE_SIZE = 100;
export const MAX_EVENT_PAGE_SIZE = 100;

export const RPC_METHODS = [
  "daemon.hello",
  "daemon.health",
  "worker.capabilities",
  "task.create",
  "task.start",
  "task.status",
  "task.cancel",
  "task.result",
  "task.events",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const UNAUTHENTICATED_METHODS: readonly RpcMethod[] = ["daemon.hello"];

export const rpcRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    id: boundedText(LIMITS.identifierMaxChars),
    method: z.enum(RPC_METHODS),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .readonly();
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

const wireErrorSchema = z
  .strictObject({
    code: z.enum(ERROR_CODES),
    safeMessage: boundedText(LIMITS.summaryMaxChars),
    retryable: z.boolean(),
    category: z.string().min(1).max(32),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .readonly();

export const rpcResponseSchema = z
  .union([
    z
      .strictObject({
        protocolVersion: z.literal(PROTOCOL_VERSION),
        id: boundedText(LIMITS.identifierMaxChars),
        ok: z.literal(true),
        result: z.unknown(),
      })
      .readonly(),
    z
      .strictObject({
        protocolVersion: z.literal(PROTOCOL_VERSION),
        id: boundedText(LIMITS.identifierMaxChars),
        ok: z.literal(false),
        error: wireErrorSchema,
      })
      .readonly(),
  ])
  .readonly();

export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export function fromWireError(
  error: Readonly<{
    code: ErrorCode;
    safeMessage: string;
    details?: ErrorDetails | undefined;
  }>,
): AgentdError {
  return makeError(error.code, error.safeMessage, {
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export const helloParamsSchema = z
  .strictObject({
    token: z.string().min(1).max(256),
    client: boundedText(LIMITS.identifierMaxChars).optional(),
  })
  .readonly();

export const runIdParamsSchema = z
  .strictObject({ runId: runIdSchema })
  .readonly();

export const eventsParamsSchema = z
  .strictObject({
    runId: runIdSchema,
    sinceSequence: z.int().min(-1).optional(),
    limit: z.int().min(1).max(MAX_EVENT_PAGE_SIZE).optional(),
  })
  .readonly();

export const createParamsSchema = z
  .strictObject({ task: z.record(z.string(), z.unknown()) })
  .readonly();
