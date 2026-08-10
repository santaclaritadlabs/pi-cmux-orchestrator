import type { AgentdError, Result } from "@pi-cmux/protocol";

import { runCmuxCli } from "./cli-transport.ts";
import { createSocketTransport } from "./socket-transport.ts";

/** Pluggable cmux control plane: JSON-RPC socket plus CLI sidebar helpers. */
export type CmuxTransport = Readonly<{
  rpc: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<Record<string, unknown>, AgentdError>>;
  runCli: (argv: readonly string[]) => Promise<Result<void, AgentdError>>;
  close: () => void;
}>;

export type CompositeTransportOptions = Readonly<{
  socketPath: string;
  cliPath?: string;
  requestTimeoutMs?: number;
}>;

/** Socket RPC for workspace/surface/notify; CLI for sidebar status/progress. */
export function createCompositeTransport(
  options: CompositeTransportOptions,
): CmuxTransport {
  const socket = createSocketTransport({
    socketPath: options.socketPath,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  return {
    rpc: (method, params) => socket.rpc(method, params),
    runCli: (argv) =>
      runCmuxCli(argv, {
        ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
        env: { CMUX_SOCKET_PATH: options.socketPath },
      }),
    close: () => {
      socket.close();
    },
  };
}

export type { FakeCmuxTransport } from "./fake-transport.ts";
