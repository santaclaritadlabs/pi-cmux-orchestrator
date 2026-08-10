import {
  formatStatus,
  type CmuxStatusMessage,
  type CmuxStatusSink,
} from "@pi-cmux/pi-extension";
import type { AgentdError, Result } from "@pi-cmux/protocol";

import type { CmuxClient } from "./client.ts";
import {
  isTerminalRunState,
  notifyTerminalTransition,
  TerminalNotificationGuard,
} from "./notifications.ts";

export type CmuxApiSinkOptions = Readonly<{
  workspaceId: string;
  /** Optional log surface for normalized log events. */
  logSurfaceId?: string;
  /** Send a cmux notification when the run first reaches a terminal state. */
  notifyOnTerminal?: boolean;
}>;

const MAX_STATUS_CHARS = 500;
const MAX_LOG_CHARS = 2_000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Bounded progress projection from event count and lifecycle state. */
export function progressForSnapshot(
  snapshot: CmuxStatusMessage["snapshot"],
): number {
  const state = snapshot.run.state;
  if (isTerminalRunState(state)) return 1;
  if (state === "QUEUED") return 0;

  const events = snapshot.eventCount;
  if (events <= 0) return 0.05;
  return Math.min(0.95, events / (events + 20));
}

function unwrapVoid(result: Result<void, AgentdError>): void {
  if (!result.ok) {
    throw new Error(result.error.safeMessage);
  }
}

function logLineFromSnapshot(
  snapshot: CmuxStatusMessage["snapshot"],
  fallback: string,
): string {
  const event = snapshot.latestEvent;
  if (event?.type !== "log") return fallback;
  const message = event.payload["message"];
  return typeof message === "string" ? message : fallback;
}

export function createCmuxApiSink(
  client: CmuxClient,
  options: CmuxApiSinkOptions,
): CmuxStatusSink {
  const notifyOnTerminal = options.notifyOnTerminal !== false;
  const terminalGuard = new TerminalNotificationGuard();

  return {
    publish: async (message) => {
      const text =
        message.text.length > 0 ? message.text : formatStatus(message.snapshot);
      const boundedText = truncate(text, MAX_STATUS_CHARS);

      unwrapVoid(
        await client.updateStatus({
          workspaceId: options.workspaceId,
          text: boundedText,
        }),
      );

      unwrapVoid(
        await client.updateProgress({
          workspaceId: options.workspaceId,
          value: progressForSnapshot(message.snapshot),
          max: 1,
        }),
      );

      if (
        options.logSurfaceId !== undefined &&
        message.snapshot.latestEvent?.type === "log"
      ) {
        const line = truncate(
          logLineFromSnapshot(message.snapshot, boundedText),
          MAX_LOG_CHARS,
        );
        unwrapVoid(
          await client.appendLog({
            surfaceId: options.logSurfaceId,
            line,
          }),
        );
      }

      if (
        notifyOnTerminal &&
        terminalGuard.shouldNotify(message.snapshot.run.state)
      ) {
        unwrapVoid(
          await notifyTerminalTransition(client, {
            workspaceId: options.workspaceId,
            snapshot: message.snapshot,
            formattedStatus: boundedText,
          }),
        );
      }
    },
  };
}
