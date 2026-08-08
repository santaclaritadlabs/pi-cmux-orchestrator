/**
 * The local RPC server.
 *
 * A Unix socket, `0600`, inside a `0700` directory. No TCP listener exists.
 *
 * Per connection the server holds exactly one piece of state: whether
 * `daemon.hello` has succeeded. Every other method is refused until it has.
 * See `rpc.ts` for what that authentication does and does not prove.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";

import type { Orchestrator } from "./orchestrator.ts";
import type { DaemonPaths } from "./paths.ts";
import {
  MAX_MESSAGE_BYTES,
  UNAUTHENTICATED_METHODS,
  createParamsSchema,
  eventsParamsSchema,
  helloParamsSchema,
  rpcErr,
  rpcOk,
  rpcRequestSchema,
  runIdParamsSchema,
  type RpcResponse,
} from "./rpc.ts";

export type ServerOptions = Readonly<{
  paths: DaemonPaths;
  orchestrator: Orchestrator;
  logger?: Logger;
  /** Supplied only by tests that need a predictable token. */
  token?: string;
}>;

export interface DaemonServer {
  readonly socketPath: string;
  readonly token: string;
  /** Stop admitting connections without waiting for existing clients. */
  stopAccepting(): void;
  close(): Promise<void>;
}

/** Constant-time comparison, so a token cannot be recovered by timing. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. Compare lengths first and still run the constant-time compare.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function startServer(
  options: ServerOptions,
): Promise<Result<DaemonServer, AgentdError>> {
  const logger = (options.logger ?? nullLogger).child({ component: "rpc" });
  const token = options.token ?? randomBytes(32).toString("base64url");

  // A stale socket from a crashed daemon would make `listen` fail with
  // EADDRINUSE. Removing it is safe only because the caller already holds the
  // daemon lock (see `daemon-lock.ts`): a socket at this path with no live
  // owner behind it is therefore known to be a leftover, not a live daemon's.
  // Without that lock this unlink would be a takeover, not a cleanup.
  await unlink(options.paths.socketPath).catch(() => undefined);

  try {
    await writeFile(options.paths.tokenPath, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    // The mode argument is subject to the umask; set it explicitly.
    await chmod(options.paths.tokenPath, 0o600);
  } catch (cause) {
    return err(
      fromThrown("STORE_IO_FAILED", "could not write the auth token", cause),
    );
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleConnection(socket, options.orchestrator, token, logger);
  });
  const sockets = new Set<Socket>();
  let accepting = true;
  let closed = false;
  server.once("close", () => {
    closed = true;
  });

  const listening = await new Promise<Result<undefined, AgentdError>>(
    (resolve) => {
      server.once("error", (cause) => {
        resolve(
          err(
            fromThrown("INTERNAL", "the RPC socket could not be bound", cause, {
              socketPath: options.paths.socketPath,
            }),
          ),
        );
      });
      server.listen(options.paths.socketPath, () => {
        resolve(ok(undefined));
      });
    },
  );

  if (!listening.ok) return listening;

  // `listen` creates the socket with the process umask applied. Narrow it
  // explicitly rather than hoping the umask was restrictive.
  await chmod(options.paths.socketPath, 0o600);

  logger.info("rpc socket listening", { socketPath: options.paths.socketPath });

  const stopAccepting = (): void => {
    if (!accepting) return;
    accepting = false;
    server.close();
  };

  return ok({
    socketPath: options.paths.socketPath,
    token,
    stopAccepting,
    close: async (): Promise<void> => {
      stopAccepting();
      for (const socket of sockets) socket.destroy();
      if (!closed)
        await new Promise<void>((resolve) => server.once("close", resolve));
      await unlink(options.paths.socketPath).catch(() => undefined);
      await unlink(options.paths.tokenPath).catch(() => undefined);
    },
  });
}

function handleConnection(
  socket: Socket,
  orchestrator: Orchestrator,
  token: string,
  logger: Logger,
): void {
  let authenticated = false;
  let buffer = "";

  socket.setEncoding("utf8");

  const reply = (response: RpcResponse): void => {
    socket.write(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;

    // The ceiling applies to the *buffer*, not to a parsed message: a client
    // streaming without newlines is otherwise an unbounded allocation.
    if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
      reply(
        rpcErr(
          "unknown",
          makeError("RPC_MESSAGE_TOO_LARGE", "the request exceeds the limit"),
        ),
      );
      socket.destroy();
      return;
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      void dispatch(line).then(reply, (error: unknown) => {
        logger.error("rpc dispatch failed", { error });
        reply(rpcErr("unknown", makeError("INTERNAL", "request failed")));
      });
    }
  });

  socket.on("error", (error) => {
    logger.warn("rpc connection error", { error });
  });

  /**
   * Recover the request id before validating anything else.
   *
   * A response the client cannot correlate is worse than no response: the
   * caller waits forever on an id that will never come back. So the id is read
   * best-effort from the raw object — the same reason `protocolVersion` is
   * checked before shape.
   */
  function correlationId(decoded: unknown): string {
    if (typeof decoded !== "object" || decoded === null) return "unknown";
    const id: unknown = (decoded as Record<string, unknown>)["id"];
    return typeof id === "string" && id.length > 0 && id.length <= 128
      ? id
      : "unknown";
  }

  async function dispatch(line: string): Promise<RpcResponse> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return rpcErr(
        "unknown",
        makeError("RPC_MALFORMED", "the request is not valid JSON"),
      );
    }

    const request = rpcRequestSchema.safeParse(decoded);
    if (!request.success) {
      return rpcErr(
        correlationId(decoded),
        makeError("RPC_MALFORMED", "the request envelope is invalid"),
      );
    }

    const { id, method, params } = request.data;

    if (!authenticated && !UNAUTHENTICATED_METHODS.includes(method)) {
      return rpcErr(
        id,
        makeError("RPC_UNAUTHENTICATED", "call daemon.hello first"),
      );
    }

    switch (method) {
      case "daemon.hello": {
        const parsed = helloParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(
            id,
            makeError("RPC_MALFORMED", "daemon.hello requires a token"),
          );
        }
        if (!tokensMatch(parsed.data.token, token)) {
          logger.warn("rejected a handshake with a bad token");
          return rpcErr(
            id,
            makeError("RPC_UNAUTHENTICATED", "the token is not valid"),
          );
        }
        authenticated = true;
        return rpcOk(id, { protocolVersion: "1", pid: process.pid });
      }

      case "daemon.health":
        return rpcOk(id, {
          status: "ok",
          pid: process.pid,
          liveRuns: orchestrator.liveRunIds().length,
          uptimeMs: Math.round(process.uptime() * 1000),
        });

      case "task.create": {
        const parsed = createParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(
            id,
            makeError("RPC_MALFORMED", "task.create requires a task"),
          );
        }
        const created = await orchestrator.createTask(parsed.data.task);
        return created.ok
          ? rpcOk(id, created.value)
          : rpcErr(id, created.error);
      }

      case "task.start": {
        const parsed = runIdParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(id, makeError("RPC_MALFORMED", "a runId is required"));
        }
        const started = await orchestrator.startRun(parsed.data.runId);
        return started.ok
          ? rpcOk(id, started.value)
          : rpcErr(id, started.error);
      }

      case "task.status": {
        const parsed = runIdParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(id, makeError("RPC_MALFORMED", "a runId is required"));
        }
        const status = await orchestrator.status(parsed.data.runId);
        return status.ok ? rpcOk(id, status.value) : rpcErr(id, status.error);
      }

      case "task.cancel": {
        const parsed = runIdParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(id, makeError("RPC_MALFORMED", "a runId is required"));
        }
        const cancelled = await orchestrator.cancelRun(parsed.data.runId);
        return cancelled.ok
          ? rpcOk(id, cancelled.value)
          : rpcErr(id, cancelled.error);
      }

      case "task.result": {
        const parsed = runIdParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(id, makeError("RPC_MALFORMED", "a runId is required"));
        }
        const result = await orchestrator.result(parsed.data.runId);
        return result.ok ? rpcOk(id, result.value) : rpcErr(id, result.error);
      }

      case "task.events": {
        const parsed = eventsParamsSchema.safeParse(params);
        if (!parsed.success) {
          return rpcErr(id, makeError("RPC_MALFORMED", "a runId is required"));
        }
        const events = await orchestrator.events(
          parsed.data.runId,
          parsed.data.sinceSequence ?? -1,
        );
        return events.ok ? rpcOk(id, events.value) : rpcErr(id, events.error);
      }

      default:
        return rpcErr(id, makeError("RPC_METHOD_UNKNOWN", "no such method"));
    }
  }
}
