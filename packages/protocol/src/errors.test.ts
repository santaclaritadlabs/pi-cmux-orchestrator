import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ERROR_CODES,
  InvariantViolation,
  assertNever,
  categoryOf,
  fromThrown,
  invariant,
  isAgentdError,
  isErrorCode,
  isRetryable,
  makeError,
  toWireError,
} from "./errors.ts";

describe("error taxonomy", () => {
  it("derives retryable from the code, not the call site", () => {
    assert.equal(makeError("POLICY_DENIED", "denied").retryable, false);
    assert.equal(makeError("STORE_IO_FAILED", "io").retryable, true);
    assert.equal(isRetryable("RUN_LOCKED"), true);
    assert.equal(isRetryable("SCHEMA_INVALID"), false);
  });

  it("never marks a policy failure retryable", () => {
    // Retrying a denial must not be able to eventually succeed: that would turn
    // a fail-closed decision into a race.
    for (const code of ERROR_CODES) {
      if (categoryOf(code) === "policy") {
        assert.equal(isRetryable(code), false, `${code} must not be retryable`);
      }
    }
  });

  it("omits absent optional fields rather than setting them undefined", () => {
    const error = makeError("RUN_NOT_FOUND", "no such run");
    assert.equal(Object.hasOwn(error, "details"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
  });

  it("carries details when supplied", () => {
    const error = makeError("TIMEOUT_HARD", "hard timeout elapsed", {
      details: { hardTimeoutMs: 30_000, runId: "run_01J" },
    });
    assert.deepEqual(error.details, {
      hardTimeoutMs: 30_000,
      runId: "run_01J",
    });
  });

  it("recognises only catalogued codes", () => {
    assert.equal(isErrorCode("POLICY_DENIED"), true);
    assert.equal(isErrorCode("NOT_A_REAL_CODE"), false);
    assert.equal(isErrorCode(undefined), false);
    // Must not be fooled by inherited Object.prototype keys.
    assert.equal(isErrorCode("toString"), false);
    assert.equal(isErrorCode("constructor"), false);
  });

  it("identifies its own errors structurally", () => {
    assert.equal(isAgentdError(makeError("INTERNAL", "boom")), true);
    assert.equal(isAgentdError(new Error("boom")), false);
    assert.equal(isAgentdError(null), false);
    assert.equal(isAgentdError({ code: "POLICY_DENIED" }), false);
  });
});

describe("wire serialisation", () => {
  it("strips cause so provider/fs internals cannot leak over RPC", () => {
    const cause = new Error("ENOENT: open '/Users/someone/.ssh/id_ed25519'");
    const error = fromThrown(
      "STORE_IO_FAILED",
      "could not read run state",
      cause,
    );

    assert.equal(error.cause, cause);

    const wire = toWireError(error);
    assert.equal(Object.hasOwn(wire, "cause"), false);
    assert.equal(
      JSON.stringify(wire).includes("id_ed25519"),
      false,
      "wire error must not carry the underlying throwable's message",
    );
  });

  it("does not interpolate the throwable into safeMessage", () => {
    const cause = new Error("token sk-abcdef1234567890 rejected");
    const error = fromThrown(
      "WORKER_SPAWN_FAILED",
      "worker failed to start",
      cause,
    );
    assert.equal(error.safeMessage, "worker failed to start");
    assert.equal(error.safeMessage.includes("sk-"), false);
  });

  it("round-trips through JSON without losing contract fields", () => {
    const wire = toWireError(
      makeError("SANDBOX_UNAVAILABLE", "required isolation unavailable", {
        details: { requested: "required" },
      }),
    );
    const parsed: unknown = JSON.parse(JSON.stringify(wire));
    assert.deepEqual(parsed, wire);
  });
});

describe("invariants", () => {
  it("throws for programmer defects rather than returning a Result", () => {
    assert.throws(() => {
      invariant(false, "sequence must increase");
    }, InvariantViolation);
    assert.doesNotThrow(() => {
      invariant(true, "fine");
    });
  });

  it("assertNever reports the unhandled variant", () => {
    assert.throws(
      () => assertNever("surprise" as never, "AgentEvent"),
      /AgentEvent: unhandled variant "surprise"/,
    );
  });
});
