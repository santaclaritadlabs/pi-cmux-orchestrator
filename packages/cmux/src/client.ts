import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import { resolveSocketMode } from "./security.ts";
import { posixShellJoin } from "./shell-quote.ts";
import { createCompositeTransport, type CmuxTransport } from "./transport.ts";
import { resolveCmuxSocketPath } from "./socket-transport.ts";

export type CmuxWorkspaceRef = Readonly<{
  workspaceId: string;
}>;

export type CmuxSurfaceRef = Readonly<{
  workspaceId: string;
  surfaceId: string;
}>;

export type CreateWorkspaceInput = Readonly<{
  runId: string;
  title: string;
}>;

export type CreateSurfaceInput = Readonly<{
  workspaceId: string;
  title: string;
  /** argv for a tail/log surface; no shell interpolation. */
  command?: readonly string[];
}>;

/**
 * Minimal cmux API surface the bridge needs. Maps to cmux CLI/socket primitives
 * (workspace creation, surfaces, status, progress, logs, notifications).
 */
export type CmuxClient = Readonly<{
  createWorkspace: (
    input: CreateWorkspaceInput,
  ) => Promise<Result<CmuxWorkspaceRef, AgentdError>>;
  createSurface: (
    input: CreateSurfaceInput,
  ) => Promise<Result<CmuxSurfaceRef, AgentdError>>;
  updateStatus: (
    input: Readonly<{ workspaceId: string; text: string }>,
  ) => Promise<Result<void, AgentdError>>;
  updateProgress: (
    input: Readonly<{ workspaceId: string; value: number; max?: number }>,
  ) => Promise<Result<void, AgentdError>>;
  appendLog: (
    input: Readonly<{ surfaceId: string; line: string }>,
  ) => Promise<Result<void, AgentdError>>;
  notify: (
    input: Readonly<{ workspaceId: string; message: string }>,
  ) => Promise<Result<void, AgentdError>>;
  close: () => void;
}>;

export type CmuxClientOptions = Readonly<{
  socketPath?: string | undefined;
  socketMode?: string | undefined;
  transport?: CmuxTransport;
  cliPath?: string | undefined;
}>;

function readString(
  result: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = result[key];
  return typeof value === "string" ? value : undefined;
}

function buildCmuxClient(transport: CmuxTransport): CmuxClient {
  return {
    createWorkspace: async (input) => {
      const created = await transport.rpc("workspace.create", {});
      if (!created.ok) return created;

      const workspaceId =
        readString(created.value, "workspace_id") ??
        readString(created.value, "workspace_ref");
      if (workspaceId === undefined) {
        return err(
          makeError("RPC_MALFORMED", "cmux workspace.create returned no id"),
        );
      }

      const renamed = await transport.rpc("workspace.rename", {
        workspace_id: workspaceId,
        title: input.title,
      });
      if (!renamed.ok) return renamed;

      return ok({ workspaceId });
    },

    createSurface: async (input) => {
      const listed = await transport.rpc("surface.list", {
        workspace_id: input.workspaceId,
      });
      if (!listed.ok) return listed;

      const surfaces = listed.value["surfaces"];
      const first =
        Array.isArray(surfaces) && surfaces.length > 0
          ? (surfaces[0] as Record<string, unknown>)
          : undefined;
      const paneId =
        first === undefined
          ? undefined
          : (readString(first, "pane_id") ?? readString(first, "pane_ref"));

      const created = await transport.rpc("surface.create", {
        workspace_id: input.workspaceId,
        ...(paneId === undefined ? {} : { pane_id: paneId }),
        type: "terminal",
        title: input.title,
      });
      if (!created.ok) return created;

      const surfaceId =
        readString(created.value, "surface_id") ??
        readString(created.value, "surface_ref");
      if (surfaceId === undefined) {
        return err(
          makeError("RPC_MALFORMED", "cmux surface.create returned no id"),
        );
      }

      if (input.command !== undefined && input.command.length > 0) {
        const commandLine = posixShellJoin(input.command);
        const sent = await transport.rpc("surface.send_text", {
          workspace_id: input.workspaceId,
          surface_id: surfaceId,
          text: `${commandLine}\n`,
        });
        if (!sent.ok) return sent;
      }

      return ok({ workspaceId: input.workspaceId, surfaceId });
    },

    updateStatus: async (input) => {
      const key = `agentd-${input.workspaceId}`;
      return await transport.runCli([
        "set-status",
        key,
        input.text,
        "--workspace",
        input.workspaceId,
      ]);
    },

    updateProgress: async (input) => {
      const clamped = Math.min(1, Math.max(0, input.value));
      const argv = [
        "set-progress",
        String(clamped),
        "--workspace",
        input.workspaceId,
      ];
      if (input.max !== undefined) {
        argv.push("--label", `${String(input.value)}/${String(input.max)}`);
      }
      return await transport.runCli(argv);
    },

    appendLog: async (input) => {
      return await transport.runCli([
        "log",
        "--append",
        input.line,
        "--surface",
        input.surfaceId,
      ]);
    },

    notify: async (input) => {
      const sent = await transport.rpc("notification.create", {
        title: input.message,
        body: input.message,
        workspace_id: input.workspaceId,
      });
      return sent.ok ? ok(undefined) : sent;
    },

    close: () => {
      transport.close();
    },
  };
}

export function createCmuxClient(options: CmuxClientOptions = {}): CmuxClient {
  const mode = resolveSocketMode(options.socketMode);
  if (!mode.ok) {
    throw new Error(mode.error.safeMessage);
  }

  const socketPath = resolveCmuxSocketPath(options.socketPath);
  const transport =
    options.transport ??
    createCompositeTransport({
      socketPath,
      ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    });

  return buildCmuxClient(transport);
}
