import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeError } from "./errors.ts";
import {
  allOk,
  andThen,
  err,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  tryCatch,
  tryCatchAsync,
  unwrapOr,
} from "./result.ts";

describe("Result", () => {
  it("narrows through the ok discriminant", () => {
    const success = ok(7);
    assert.equal(isOk(success), true);
    assert.equal(isErr(success), false);
    if (success.ok) assert.equal(success.value, 7);
  });

  it("short-circuits chains on the first failure", () => {
    const failure = err(makeError("SCHEMA_INVALID", "bad payload"));
    let ran = false;
    const chained = andThen(failure, () => {
      ran = true;
      return ok("unreachable");
    });
    assert.equal(ran, false);
    assert.equal(isErr(chained), true);
  });

  it("maps only the matching side", () => {
    assert.deepEqual(
      mapResult(ok(2), (n) => n * 3),
      ok(6),
    );
    assert.deepEqual(
      mapResult(err("boom"), (n: number) => n * 3),
      err("boom"),
    );
    assert.deepEqual(
      mapError(err("boom"), (e) => `${e}!`),
      err("boom!"),
    );
    assert.deepEqual(
      mapError(ok(2), (e: string) => `${e}!`),
      ok(2),
    );
  });

  it("unwrapOr falls back only on failure", () => {
    assert.equal(unwrapOr(ok(1), 99), 1);
    assert.equal(unwrapOr(err("boom"), 99), 99);
  });
});

describe("allOk", () => {
  it("collects every value when all succeed", () => {
    assert.deepEqual(allOk([ok(1), ok(2), ok(3)]), ok([1, 2, 3]));
  });

  it("returns the first failure and stops", () => {
    const first = makeError("SEQUENCE_CONFLICT", "duplicate sequence 4");
    const second = makeError("STORE_CORRUPT", "unparseable state.json");
    const result = allOk([ok(1), err(first), err(second)]);
    assert.equal(isErr(result), true);
    if (!result.ok) assert.equal(result.error, first);
  });

  it("treats an empty batch as success", () => {
    assert.deepEqual(allOk([]), ok([]));
  });
});

describe("tryCatch", () => {
  it("converts a throw into a typed failure", () => {
    const result = tryCatch(
      () => JSON.parse("{ not json") as unknown,
      (cause) =>
        makeError("RPC_MALFORMED", "message is not valid JSON", { cause }),
    );
    assert.equal(isErr(result), true);
    if (!result.ok) {
      assert.equal(result.error.code, "RPC_MALFORMED");
      assert.equal(result.error.safeMessage, "message is not valid JSON");
    }
  });

  it("passes a non-throwing call straight through", () => {
    const result = tryCatch(
      () => JSON.parse('{"a":1}') as unknown,
      () => makeError("RPC_MALFORMED", "unused"),
    );
    assert.deepEqual(result, ok({ a: 1 }));
  });

  it("handles rejected promises in the async variant", async () => {
    const result = await tryCatchAsync(
      () => Promise.reject(new Error("ENOENT")),
      (cause) => makeError("STORE_IO_FAILED", "read failed", { cause }),
    );
    assert.equal(isErr(result), true);
    if (!result.ok) assert.equal(result.error.retryable, true);
  });

  it("does not swallow a thrown non-Error", async () => {
    const result = await tryCatchAsync(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is exactly what this test covers: provider CLIs and JSON parsers do throw bare values.
      () => Promise.reject("a bare string"),
      (cause) => makeError("INTERNAL", "unexpected", { cause }),
    );
    assert.equal(isErr(result), true);
    if (!result.ok) assert.equal(result.error.cause, "a bare string");
  });
});
