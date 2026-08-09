import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  eventsParamsSchema,
  fromWireError,
  MAX_EVENT_PAGE_SIZE,
  rpcRequestSchema,
  rpcResponseSchema,
} from "./rpc.ts";

const runId = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";

describe("local RPC contract", () => {
  it("requires the protocol version on every request and response", () => {
    assert.equal(
      rpcRequestSchema.safeParse({ id: "req-1", method: "daemon.health" })
        .success,
      false,
    );
    assert.equal(
      rpcResponseSchema.safeParse({ id: "req-1", ok: true, result: {} })
        .success,
      false,
    );
  });

  it("bounds event pages at the wire boundary", () => {
    assert.equal(
      eventsParamsSchema.safeParse({
        runId,
        limit: MAX_EVENT_PAGE_SIZE + 1,
      }).success,
      false,
    );
  });

  it("reconstructs error metadata from the trusted code catalogue", () => {
    const wireError = {
      code: "RPC_MALFORMED" as const,
      safeMessage: "safe",
      retryable: true,
      category: "attacker-controlled",
    };
    assert.equal(
      rpcResponseSchema.safeParse({
        protocolVersion: "1",
        id: "req-1",
        ok: false,
        error: wireError,
      }).success,
      true,
    );
    const error = fromWireError(wireError);
    assert.equal(error.retryable, false);
    assert.equal(error.category, "rpc");
  });
});
