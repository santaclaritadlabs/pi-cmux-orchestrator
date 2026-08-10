/** Adapter from Pi's ExtensionAPI to the orchestrator's narrow host contract. */
import { resolveDaemonPaths } from "@pi-cmux/agentd";
import { activatePiExtension } from "./api.ts";
import type {
  PiCommandInput,
  PiCommandResponse,
  PiExtensionHost,
} from "./api.ts";
import type { PiConnectionOptions } from "./index.ts";

export type PiCommandContext = Readonly<{
  signal?: AbortSignal;
  ui: Readonly<{
    notify: (message: string, level: "info" | "warning" | "error") => void;
  }>;
}>;

export type PiCommandDefinition = Readonly<{
  description: string;
  handler: (args: string, context: PiCommandContext) => void | Promise<void>;
}>;

export type PiExtensionRuntime = Readonly<{
  registerCommand: (name: string, definition: PiCommandDefinition) => void;
  on: (event: "session_shutdown", handler: () => void | Promise<void>) => void;
}>;

const MAX_NOTIFICATION_BYTES = 4_096;

function commandInput(raw: string): PiCommandInput {
  const trimmed = raw.trim();
  return { args: trimmed === "" ? [] : [trimmed] };
}

function responseText(response: PiCommandResponse): string {
  if (!response.ok) {
    const error = response.error;
    return error === undefined ? "the command failed" : error.safeMessage;
  }

  let serialized: string;
  try {
    const encoded: unknown = JSON.stringify(response.value);
    serialized = typeof encoded === "string" ? encoded : "undefined";
  } catch {
    serialized = "the command returned a non-serializable value";
  }

  return Buffer.byteLength(serialized, "utf8") <= MAX_NOTIFICATION_BYTES
    ? serialized
    : `${serialized.slice(0, MAX_NOTIFICATION_BYTES - 1)}…`;
}

/**
 * Keep Pi-specific command and lifecycle APIs at the edge of the bridge.
 * `PiExtensionHost` remains usable by other first-party hosts and tests.
 */
export function createPiExtensionHost(
  runtime: PiExtensionRuntime,
): PiExtensionHost {
  return {
    registerCommand: (name, handler) => {
      runtime.registerCommand(name, {
        description: `agentd: ${name}`,
        handler: async (raw, context) => {
          const response = await handler({
            ...commandInput(raw),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          context.ui.notify(
            responseText(response),
            response.ok ? "info" : "error",
          );
        },
      });
    },
    onShutdown: (handler) => {
      runtime.on("session_shutdown", handler);
    },
  };
}

function connectionOptions(): PiConnectionOptions {
  const paths = resolveDaemonPaths();
  return {
    socketPath: process.env["AGENTD_SOCKET_PATH"] ?? paths.socketPath,
    tokenPath: process.env["AGENTD_TOKEN_PATH"] ?? paths.tokenPath,
  };
}

/** Default entrypoint loaded by Pi after the installer creates its pointer. */
export default async function piExtension(
  runtime: PiExtensionRuntime,
): Promise<void> {
  const activated = await activatePiExtension(
    createPiExtensionHost(runtime),
    connectionOptions(),
  );
  if (!activated.ok) throw new Error(activated.error.safeMessage);
}
