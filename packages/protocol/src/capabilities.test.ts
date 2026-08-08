import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITIES,
  isCapability,
  unknownCapabilities,
} from "./capabilities.ts";
import { LIMITS } from "./primitives.ts";
import { parseAgentTask } from "./codec.ts";
import { sampleTask } from "./samples.ts";

describe("the capability registry", () => {
  it("is closed", () => {
    assert.equal(isCapability("repo.read"), true);
    assert.equal(isCapability("repo.write"), true);
    assert.equal(isCapability("not.a.capability"), false);
    // Near-misses are still misses: matching is exact, never prefix or fuzzy.
    assert.equal(isCapability("repo"), false);
    assert.equal(isCapability("repo.read "), false);
    assert.equal(isCapability("REPO.READ"), false);
  });

  it("reports every unrecognised capability, not just the first", () => {
    const unknown = unknownCapabilities([
      "repo.read",
      "one.bad",
      "test.run",
      "another.bad",
    ]);
    assert.deepEqual(unknown, ["one.bad", "another.bad"]);
  });

  it("accepts an empty request", () => {
    assert.deepEqual(unknownCapabilities([]), []);
  });

  it("fits the schema's capability limit", () => {
    // A registry larger than the bound would make the full set unrequestable,
    // so the two limits would disagree with nothing to catch it.
    //
    // Both sides are widened to `number` deliberately. As tuple-literal types
    // the comparison is decidable at compile time, and the lint rule that
    // flags always-true conditions would reject the assertion outright — which
    // would delete the very check that stops being true once the registry grows.
    const registrySize: number = CAPABILITIES.length;
    const limit: number = LIMITS.maxCapabilities;

    assert.ok(
      registrySize <= limit,
      `registry has ${String(registrySize)} entries but the schema admits ` +
        `at most ${String(limit)}`,
    );
  });

  it("has no duplicates", () => {
    assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length);
  });

  it("lets the task schema carry every registered capability at once", () => {
    // Guards the same disagreement from the other side: the schema must admit
    // a task that asks for everything the registry defines.
    const base = sampleTask();
    const parsed = parseAgentTask(
      JSON.parse(
        JSON.stringify({
          ...base,
          constraints: { ...base.constraints, capabilities: [...CAPABILITIES] },
        }),
      ),
    );
    assert.equal(parsed.ok, true);
  });
});
