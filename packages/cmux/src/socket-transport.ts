import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import { isCmuxRpcResponse, type CmuxRpcRequest } from "./protocol.ts";
import type { CmuxTransport } from "./transport.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type SocketTransportOptions = Readonly<{
  socketPath: string;
  requestTimeoutMs?: number;
}>;

/** Default production cmux socket when CMUX_SOCKET_PATH is unset. */
export const DEFAULT_CMUX_SOCKET_PATH = "/tmp/cmux.sock";

export function resolveCmuxSocketPath(explicit?: string): string {
  return (
    explicit ?? process.env["CMUX_SOCKET_PATH"] ?? DEFAULT_CMUX_SOCKET_PATH
  );
}

export function createSocketTransport(
  options: SocketTransportOptions,
): CmuxTransport {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    rpc: (method, params) =>
      rpcOnce(options.socketPath, method, params, requestTimeoutMs),
    runCli: () =>
      Promise.resolve(
        err(
          makeError(
            "INTERNAL",
            "CLI sidebar commands are not available on socket-only transport",
          ),
        ),
      ),
    close: () => undefined,
  };
}

async function rpcOnce(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  requestTimeoutMs: number,
): Promise<Result<Record<string, unknown>, AgentdError>> {
  const request: CmuxRpcRequest = {
    id: randomUUID(),
    method,
    params,
  };

  let socket: Socket | undefined;
  try {
    socket = await connectSocket(socketPath, requestTimeoutMs);
    const payload = `${JSON.stringify(request)}\n`;
    await writeAll(socket, payload, requestTimeoutMs);

    const raw = await readLine(socket, requestTimeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (cause) {
      return err(
        fromThrown("RPC_MALFORMED", "cmux returned invalid JSON", cause),
      );
    }

    if (!isCmuxRpcResponse(parsed)) {
      return err(makeError("RPC_MALFORMED", "cmux response shape is invalid"));
    }

    if (!parsed.ok) {
      return err(
        makeError(
          "INTERNAL",
          `cmux ${parsed.error.code}: ${parsed.error.message}`,
        ),
      );
    }

    return ok(parsed.result);
  } catch (cause) {
    return err(fromThrown("INTERNAL", "cmux socket request failed", cause));
  } finally {
    socket?.destroy();
  }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("cmux socket connection timed out"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

function writeAll(
  socket: Socket,
  payload: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("cmux socket write timed out"));
    }, timeoutMs);
    socket.write(payload, (error) => {
      clearTimeout(timer);
      if (error !== undefined)
        reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    });
  });
}

function readLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("cmux socket read timed out"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        cleanup();
        reject(new Error("cmux response exceeds size limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };

    const onError = (cause: Error): void => {
      cleanup();
      reject(cause);
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}
