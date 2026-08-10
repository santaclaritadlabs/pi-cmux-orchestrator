import { ok, type AgentdError, type Result } from "@pi-cmux/protocol";

import type { CmuxTransport } from "./transport.ts";

export type FakeRpcHandler = (
  method: string,
  params: Record<string, unknown>,
) => Result<Record<string, unknown>, AgentdError>;

/**
 * In-memory transport for tests. Records every RPC and CLI invocation.
 */
export class FakeCmuxTransport implements CmuxTransport {
  public readonly rpcCalls: {
    method: string;
    params: Record<string, unknown>;
  }[] = [];
  public readonly cliCalls: string[][] = [];
  private readonly onRpc: FakeRpcHandler | undefined;

  public constructor(onRpc?: FakeRpcHandler) {
    this.onRpc = onRpc;
  }

  public rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<Record<string, unknown>, AgentdError>> {
    this.rpcCalls.push({ method, params });
    if (this.onRpc !== undefined)
      return Promise.resolve(this.onRpc(method, params));

    switch (method) {
      case "workspace.create":
        return Promise.resolve(
          ok({
            workspace_id: "ws-test-01",
            workspace_ref: "workspace:1",
          }),
        );
      case "workspace.rename":
        return Promise.resolve(ok({}));
      case "surface.list":
        return Promise.resolve(
          ok({
            surfaces: [{ id: "surface-test-01", ref: "surface:1" }],
          }),
        );
      case "surface.create":
        return Promise.resolve(
          ok({
            surface_id: "surface-test-02",
            surface_ref: "surface:2",
          }),
        );
      case "notification.create":
        return Promise.resolve(ok({}));
      default:
        return Promise.resolve(ok({}));
    }
  }

  public runCli(argv: readonly string[]): Promise<Result<void, AgentdError>> {
    this.cliCalls.push([...argv]);
    return Promise.resolve(ok(undefined));
  }

  public close(): void {
    // no-op
  }
}
