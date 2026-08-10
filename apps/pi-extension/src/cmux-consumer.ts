import {
  err,
  makeError,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import {
  formatStatus,
  type PiAgentdBridge,
  type StatusSnapshot,
  type WatchOptions,
} from "./index.ts";

/**
 * The deliberately small boundary consumed by a cmux pane/status surface.
 *
 * cmux remains an optional visual client: this sink receives projections only
 * and has no methods for creating, starting, or cancelling runs. A concrete
 * cmux extension can implement this contract with its pane/status API without
 * making cmux a runtime dependency of agentd or the bridge.
 */
export type CmuxStatusMessage = Readonly<{
  runId: string;
  text: string;
  snapshot: StatusSnapshot;
}>;

export type CmuxStatusSink = Readonly<{
  publish: (message: CmuxStatusMessage) => void | Promise<void>;
}>;

export type CmuxConsumerOptions = Readonly<{
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Called when a single `publish` fails; the watch loop keeps polling.
   *
   * cmux is the visual plane and must never be a required dependency (see
   * CLAUDE.md): a transient sink failure (socket restart, cmux CLI down for a
   * moment) must not halt status projection for the rest of the run, which is
   * what `bridge.watch` would otherwise do — it stops on the first `onSnapshot`
   * rejection. Opt-in rather than a bundled logger, since this package must
   * not carry an observability dependency of its own.
   */
  onPublishError?: (error: unknown) => void;
}>;

/**
 * Adapts the headless Pi bridge watch stream to a cmux visual sink.
 * It never owns task lifecycle and never invokes cmux control operations.
 */
export class CmuxStatusConsumer {
  private readonly bridge: Pick<PiAgentdBridge, "watch">;
  private readonly sink: CmuxStatusSink;

  public constructor(
    bridge: Pick<PiAgentdBridge, "watch">,
    sink: CmuxStatusSink,
  ) {
    this.bridge = bridge;
    this.sink = sink;
  }

  public async follow(
    runId: string,
    options: CmuxConsumerOptions = {},
  ): Promise<Result<void, AgentdError>> {
    if (runId.length === 0) {
      return err(makeError("SCHEMA_INVALID", "cmux run id is required"));
    }
    const watchOptions: WatchOptions = {
      ...(options.intervalMs === undefined
        ? {}
        : { intervalMs: options.intervalMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onSnapshot: async (snapshot) => {
        try {
          await this.sink.publish({
            runId,
            text: formatStatus(snapshot),
            snapshot,
          });
        } catch (cause) {
          options.onPublishError?.(cause);
        }
      },
    };
    return await this.bridge.watch(runId, watchOptions);
  }
}

/**
 * A minimal writer-backed sink for a cmux pane. The writer is supplied by the
 * host integration (for example, a pane's append/status callback); no shell,
 * socket, or cmux executable is invoked here.
 */
export function createCmuxTextSink(writer: {
  write: (text: string) => void | Promise<void>;
}): CmuxStatusSink {
  return {
    publish: async ({ text }) => {
      await writer.write(`${text}\n`);
    },
  };
}
