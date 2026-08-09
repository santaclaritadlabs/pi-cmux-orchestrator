/** Local RPC helpers. The versioned wire contract lives in @pi-cmux/protocol. */
import {
  PROTOCOL_VERSION,
  toWireError,
  type AgentdError,
  type RpcResponse,
} from "@pi-cmux/protocol";

export {
  createParamsSchema,
  DEFAULT_EVENT_PAGE_SIZE,
  eventsParamsSchema,
  helloParamsSchema,
  MAX_EVENT_PAGE_SIZE,
  MAX_RPC_MESSAGE_BYTES as MAX_MESSAGE_BYTES,
  rpcRequestSchema,
  RPC_METHODS,
  runIdParamsSchema,
  UNAUTHENTICATED_METHODS,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
} from "@pi-cmux/protocol";

export function rpcOk(id: string, result: unknown): RpcResponse {
  return { protocolVersion: PROTOCOL_VERSION, id, ok: true, result };
}

export function rpcErr(id: string, error: AgentdError): RpcResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    ok: false,
    error: toWireError(error),
  };
}
