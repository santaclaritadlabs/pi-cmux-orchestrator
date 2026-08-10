import type { StatusSnapshot } from "@pi-cmux/pi-extension";
import { ok, type AgentdError, type Result } from "@pi-cmux/protocol";

import type { CmuxClient } from "./client.ts";

export type RunState = StatusSnapshot["run"]["state"];

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "BLOCKED",
  "CANCELLED",
  "FAILED",
  "ORPHANED",
  "SUCCEEDED",
] as const;

const TERMINAL = new Set<RunState>(TERMINAL_RUN_STATES);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL.has(state);
}

export function terminalNotificationMessage(
  snapshot: StatusSnapshot,
  formattedStatus: string,
): string {
  return `${snapshot.run.runId}: ${formattedStatus}`;
}

export async function notifyTerminalTransition(
  client: CmuxClient,
  input: Readonly<{
    workspaceId: string;
    snapshot: StatusSnapshot;
    formattedStatus: string;
  }>,
): Promise<Result<void, AgentdError>> {
  if (!isTerminalRunState(input.snapshot.run.state)) {
    return ok(undefined);
  }

  return await client.notify({
    workspaceId: input.workspaceId,
    message: terminalNotificationMessage(input.snapshot, input.formattedStatus),
  });
}

/** Tracks whether a terminal notification was already sent for one run. */
export class TerminalNotificationGuard {
  private notified = false;

  public shouldNotify(state: RunState): boolean {
    if (!isTerminalRunState(state) || this.notified) return false;
    this.notified = true;
    return true;
  }
}
