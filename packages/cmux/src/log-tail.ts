import {
  err,
  makeError,
  ok,
  runIdSchema,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import type { CmuxClient, CmuxSurfaceRef } from "./client.ts";

/**
 * Log tail surfaces follow agentd output; they do not host worker processes.
 *
 * Closing a cmux workspace or surface stops only the tail viewer. The agentd run
 * and its worker keep executing independently (spec §13).
 */
export const LOG_TAIL_INDEPENDENCE =
  "Closing a cmux workspace does not cancel the agentd run; workers are supervised by agentd, not cmux." as const;

/** argv for `agentd logs --follow <runId>` — no shell interpolation. */
export function createLogTailCommand(runId: string): readonly string[] {
  if (!runIdSchema.safeParse(runId).success) {
    throw new Error("agentd run id is invalid");
  }
  return ["agentd", "logs", "--follow", runId];
}

/** Validates run id and returns argv, or a typed protocol error. */
export function buildLogTailCommand(
  runId: string,
): Result<readonly string[], AgentdError> {
  if (!runIdSchema.safeParse(runId).success) {
    return err(makeError("SCHEMA_INVALID", "agentd run id is invalid"));
  }
  return ok(createLogTailCommand(runId));
}

export type AttachLogTailSurfaceInput = Readonly<{
  workspaceId: string;
  runId: string;
  title: string;
}>;

/**
 * Attach a terminal surface that tails agentd logs for one run.
 * The worker process is never embedded in the cmux pane.
 */
export async function attachLogTailSurface(
  client: CmuxClient,
  input: AttachLogTailSurfaceInput,
): Promise<Result<CmuxSurfaceRef, AgentdError>> {
  const command = buildLogTailCommand(input.runId);
  if (!command.ok) return err(command.error);

  return await client.createSurface({
    workspaceId: input.workspaceId,
    title: input.title,
    command: command.value,
  });
}
