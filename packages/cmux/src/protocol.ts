/** cmux control socket JSON-RPC envelope (v2). */

export type CmuxRpcRequest = Readonly<{
  id: string;
  method: string;
  params: Record<string, unknown>;
}>;

export type CmuxRpcSuccess = Readonly<{
  ok: true;
  result: Record<string, unknown>;
  id?: string;
}>;

export type CmuxRpcFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: string; message: string }>;
  id?: string;
}>;

export type CmuxRpcResponse = CmuxRpcSuccess | CmuxRpcFailure;

export function isCmuxRpcResponse(value: unknown): value is CmuxRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["ok"] === true) {
    return typeof record["result"] === "object" && record["result"] !== null;
  }
  if (record["ok"] === false) {
    const error = record["error"];
    return (
      typeof error === "object" &&
      error !== null &&
      typeof (error as Record<string, unknown>)["code"] === "string" &&
      typeof (error as Record<string, unknown>)["message"] === "string"
    );
  }
  return false;
}
