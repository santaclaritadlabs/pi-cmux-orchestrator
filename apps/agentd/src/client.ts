/**
 * A minimal RPC client.
 *
 * Used by the CLI and by tests, and the shape the Pi extension will follow in
 * P4. It performs the handshake on connect, so no caller can accidentally
 * assume an unauthenticated socket works.
 */

import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import type { RpcMethod } from "./rpc.ts";

type Pending = Readonly<{
  resolve: (value: Result<unknown, AgentdError>) => void;
}>;

export interface DaemonClient {
  call(
    method: RpcMethod,
    params?: Record<string, unknown>,
  ): Promise<Result<unknown, AgentdError>>;
  close(): void;
}

/** How long a single call waits before giving up on the daemon. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export async function connectToDaemon(options: {
  socketPath: string;
  token?: string;
  tokenPath?: string;
  client?: string;
  requestTimeoutMs?: number;
}): Promise<Result<DaemonClient, AgentdError>> {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let token = options.token;
  if (token === undefined) {
    if (options.tokenPath === undefined) {
      return err(makeError("RPC_UNAUTHENTICATED", "no token was supplied"));
    }
    try {
      token = (await readFile(options.tokenPath, "utf8")).trim();
    } catch (cause) {
      return err(
        fromThrown(
          "RPC_UNAUTHENTICATED",
          "the auth token could not be read; is the daemon running?",
          cause,
        ),
      );
    }
  }

  const socket = await new Promise<Socket | undefined>((resolve) => {
    const candidate = connect(options.socketPath);
    candidate.once("connect", () => {
      resolve(candidate);
    });
    candidate.once("error", () => {
      resolve(undefined);
    });
  });

  if (socket === undefined) {
    return err(
      makeError("RPC_MALFORMED", "could not connect to the daemon socket", {
        details: { socketPath: options.socketPath },
      }),
    );
  }

  socket.setEncoding("utf8");

  const pending = new Map<string, Pending>();
  let buffer = "";
  let nextId = 1;

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        continue;
      }

      const response = decoded as {
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: AgentdError;
      };
      const responseId = response.id ?? "";
      const waiter = pending.get(responseId);
      if (waiter === undefined) continue;
      pending.delete(responseId);

      waiter.resolve(
        response.ok === true
          ? ok(response.result)
          : err(
              response.error ??
                makeError("INTERNAL", "the daemon returned no error detail"),
            ),
      );
    }
  });

  // A response the client never receives must not become an infinite wait.
  // The daemon correlates errors back to the request id, so this should only
  // fire if the daemon dies mid-call — which is exactly when a caller most
  // needs to be told something, rather than hanging.
  const settleAllPending = (error: AgentdError): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.resolve(err(error));
    }
  };

  socket.on("close", () => {
    settleAllPending(
      makeError("RPC_MALFORMED", "the daemon closed the connection"),
    );
  });

  const call = async (
    method: RpcMethod,
    params?: Record<string, unknown>,
  ): Promise<Result<unknown, AgentdError>> => {
    const id = `req-${String(nextId)}`;
    nextId += 1;

    return await new Promise<Result<unknown, AgentdError>>((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve(
          err(
            makeError("INTERNAL", "the daemon did not answer in time", {
              details: { method, timeoutMs: requestTimeoutMs },
            }),
          ),
        );
      }, requestTimeoutMs);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });

      socket.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  };

  const hello = await call("daemon.hello", {
    token,
    ...(options.client === undefined ? {} : { client: options.client }),
  });
  if (!hello.ok) {
    socket.destroy();
    return hello;
  }

  return ok({
    call,
    close: () => {
      socket.destroy();
    },
  });
}
