/** First-party command adapter for a concrete Pi extension runtime. */
import { PiAgentdBridge, type PiConnectionOptions } from "./index.ts";
import {
  makeError,
  ok,
  runIdSchema,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/** Minimal host contract implemented by Pi's runtime. */
export type PiExtensionHost = Readonly<{
  registerCommand: (
    name: string,
    handler: (input: PiCommandInput) => Promise<PiCommandResponse>,
  ) => void;
  unregisterCommand?: (name: string) => void;
  onShutdown?: (handler: () => void) => void;
}>;

export type PiCommandInput = Readonly<{
  args: readonly string[];
  signal?: AbortSignal;
}>;

export type PiCommandResponse = Readonly<{
  ok: boolean;
  value?: unknown;
  error?: AgentdError;
}>;

export const PI_COMMANDS = [
  "agentd.health",
  "agentd.capabilities",
  "agentd.create",
  "agentd.createAndStart",
  "agentd.start",
  "agentd.status",
  "agentd.cancel",
  "agentd.result",
  "agentd.events",
] as const;
export type PiCommandName = (typeof PI_COMMANDS)[number];

const MAX_COMMAND_JSON_BYTES = 1024 * 1024;

function commandError(safeMessage: string): PiCommandResponse {
  return { ok: false, error: makeError("SCHEMA_INVALID", safeMessage) };
}

function oneArgument(input: PiCommandInput): string | undefined {
  return input.args.length === 1 ? input.args[0] : undefined;
}

function runIdArgument(input: PiCommandInput): string | undefined {
  const value = oneArgument(input);
  return value !== undefined && runIdSchema.safeParse(value).success
    ? value
    : undefined;
}

function jsonArgument(input: PiCommandInput): unknown {
  const raw = oneArgument(input);
  if (
    raw === undefined ||
    Buffer.byteLength(raw, "utf8") > MAX_COMMAND_JSON_BYTES
  )
    return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function response(result: Result<unknown, AgentdError>): PiCommandResponse {
  return result.ok ? { ok: true, value: result.value } : result;
}

/** Register agentd commands without giving the Pi runtime worker control. */
export function registerPiExtension(
  host: PiExtensionHost,
  bridge: PiAgentdBridge,
): () => void {
  const handlers: Readonly<
    Record<PiCommandName, (input: PiCommandInput) => Promise<PiCommandResponse>>
  > = {
    "agentd.health": async (input) =>
      input.args.length === 0
        ? response(await bridge.health())
        : commandError("agentd.health takes no arguments"),
    "agentd.capabilities": async (input) =>
      input.args.length === 0
        ? response(await bridge.capabilities())
        : commandError("agentd.capabilities takes no arguments"),
    "agentd.create": async (input) => {
      const value = jsonArgument(input);
      return value === undefined
        ? commandError("agentd.create expects one JSON task argument")
        : response(await bridge.createTask(value));
    },
    "agentd.createAndStart": async (input) => {
      const value = jsonArgument(input);
      return value === undefined
        ? commandError("agentd.createAndStart expects one JSON task argument")
        : response(await bridge.createAndStart(value));
    },
    "agentd.start": async (input) => {
      const runId = runIdArgument(input);
      return runId === undefined
        ? commandError("agentd.start expects one run id argument")
        : response(await bridge.start(runId));
    },
    "agentd.status": async (input) => {
      const runId = runIdArgument(input);
      return runId === undefined
        ? commandError("agentd.status expects one run id argument")
        : response(await bridge.status(runId));
    },
    "agentd.cancel": async (input) => {
      const runId = runIdArgument(input);
      return runId === undefined
        ? commandError("agentd.cancel expects one run id argument")
        : response(await bridge.cancel(runId));
    },
    "agentd.result": async (input) => {
      const runId = runIdArgument(input);
      return runId === undefined
        ? commandError("agentd.result expects one run id argument")
        : response(await bridge.result(runId));
    },
    "agentd.events": async (input) => {
      const runId = runIdArgument(input);
      return runId === undefined
        ? commandError("agentd.events expects one run id argument")
        : response(await bridge.events(runId));
    },
  };

  for (const name of PI_COMMANDS) host.registerCommand(name, handlers[name]);
  const dispose = (): void => {
    for (const name of PI_COMMANDS) host.unregisterCommand?.(name);
    bridge.close();
  };
  host.onShutdown?.(dispose);
  return dispose;
}

/** Connect to agentd and install the command surface in one operation. */
export async function activatePiExtension(
  host: PiExtensionHost,
  options: PiConnectionOptions,
): Promise<Result<() => void, AgentdError>> {
  const connected = await PiAgentdBridge.connect(options);
  if (!connected.ok) return connected;
  return ok(registerPiExtension(host, connected.value));
}
