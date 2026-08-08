/**
 * The local RPC contract.
 *
 * NDJSON over a Unix socket: one JSON object per line, request and response
 * correlated by `id`. No TCP listener exists, by design.
 *
 * **Authentication.** Every method except `daemon.hello` requires a completed
 * handshake. The token is generated per daemon start and written to a `0600`
 * file inside a `0700` directory.
 *
 * Be precise about what that proves: it authenticates *a process able to read a
 * file only this user can read*. It is not proof of which program is calling.
 * Node does not expose `LOCAL_PEERCRED` on macOS, so kernel-level peer
 * verification is unavailable — see docs/threat-model.md, "Known limitations".
 * Filesystem permissions plus a token is the honest boundary, and it is stated
 * rather than implied.
 */

import { z } from "zod";

import {
  LIMITS,
  boundedText,
  runIdSchema,
  toWireError,
  type AgentdError,
} from "@pi-cmux/protocol";

/** Longest single RPC message. Enforced before parsing. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const RPC_METHODS = [
  "daemon.hello",
  "daemon.health",
  "task.create",
  "task.start",
  "task.status",
  "task.cancel",
  "task.result",
  "task.events",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

/** Methods callable before the handshake completes. */
export const UNAUTHENTICATED_METHODS: readonly RpcMethod[] = ["daemon.hello"];

export const rpcRequestSchema = z
  .strictObject({
    id: boundedText(LIMITS.identifierMaxChars),
    method: z.enum(RPC_METHODS),
    // Validated per-method by the handler; kept open here so an unknown method
    // fails with RPC_METHOD_UNKNOWN rather than a shape error.
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .readonly();

export type RpcRequest = Readonly<{
  id: string;
  method: RpcMethod;
  params?: Readonly<Record<string, unknown>>;
}>;

export type RpcResponse =
  | Readonly<{ id: string; ok: true; result: unknown }>
  | Readonly<{
      id: string;
      ok: false;
      error: ReturnType<typeof toWireError>;
    }>;

export function rpcOk(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result };
}

export function rpcErr(id: string, error: AgentdError): RpcResponse {
  // `toWireError` drops `cause`, so nothing from an fs or provider error
  // crosses the socket.
  return { id, ok: false, error: toWireError(error) };
}

// --- per-method parameter schemas ----------------------------------------

export const helloParamsSchema = z
  .strictObject({
    token: z.string().min(1).max(256),
    /** Reported for logging; never trusted for authorisation. */
    client: boundedText(LIMITS.identifierMaxChars).optional(),
  })
  .readonly();

export const runIdParamsSchema = z
  .strictObject({ runId: runIdSchema })
  .readonly();

export const eventsParamsSchema = z
  .strictObject({
    runId: runIdSchema,
    /** Resume point for a reconnecting reader. Exclusive. */
    sinceSequence: z.int().min(-1).optional(),
  })
  .readonly();

export const createParamsSchema = z
  .strictObject({
    // The task is validated by the protocol codec, not here: doing it twice
    // with two schemas is how they drift.
    task: z.record(z.string(), z.unknown()),
  })
  .readonly();
