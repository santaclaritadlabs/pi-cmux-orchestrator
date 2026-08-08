import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RUN_STATES,
  isTerminalRunState,
  type RunState,
} from "@pi-cmux/protocol";

import {
  allowedTransitionsFrom,
  canTransition,
  holdsResources,
  recoveryStateFor,
  transition,
} from "./state-machine.ts";

describe("transition table", () => {
  it("permits the happy path end to end", () => {
    const path: RunState[] = [
      "QUEUED",
      "PREPARING",
      "RUNNING",
      "VALIDATING",
      "SUCCEEDED",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      assert.ok(from !== undefined && to !== undefined);
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
    }
  });

  it("rejects every transition not in the table", () => {
    // Exhaustive: any pair the table does not list must be refused. This is the
    // test that catches an accidentally-widened table.
    for (const from of RUN_STATES) {
      const allowed = new Set(allowedTransitionsFrom(from));
      for (const to of RUN_STATES) {
        const result = transition(from, to);
        assert.equal(
          result.ok,
          allowed.has(to),
          `${from} -> ${to} disagreed with the table`,
        );
      }
    }
  });

  it("explains a refusal without throwing", () => {
    const result = transition("SUCCEEDED", "RUNNING");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_STATE_TRANSITION");
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.details?.["from"], "SUCCEEDED");
  });
});

describe("success is never reachable by accident", () => {
  it("has exactly two edges into SUCCEEDED", () => {
    const sources = RUN_STATES.filter((from) =>
      canTransition(from, "SUCCEEDED"),
    );
    // VALIDATING is the normal path; ORPHANED is explicit reaping with
    // evidence. Nothing else may declare success.
    assert.deepEqual([...sources].sort(), ["ORPHANED", "VALIDATING"]);
  });

  it("cannot reach SUCCEEDED directly from RUNNING", () => {
    // A worker claiming success is not proof; the result must be validated.
    assert.equal(canTransition("RUNNING", "SUCCEEDED"), false);
  });

  it("gives terminal states no outgoing edges", () => {
    for (const state of RUN_STATES) {
      if (!isTerminalRunState(state)) continue;
      assert.deepEqual(
        allowedTransitionsFrom(state),
        [],
        `${state} must be final`,
      );
    }
  });
});

describe("ORPHANED", () => {
  it("is reachable from every state that can own a live process", () => {
    for (const state of RUN_STATES) {
      if (!holdsResources(state)) continue;
      assert.equal(
        canTransition(state, "ORPHANED"),
        true,
        `${state} must be able to become indeterminate`,
      );
    }
  });

  it("is not terminal: an orphan must be resolved explicitly", () => {
    assert.equal(isTerminalRunState("ORPHANED"), false);
    assert.notDeepEqual(allowedTransitionsFrom("ORPHANED"), []);
  });

  it("is not reachable from QUEUED, where nothing was launched", () => {
    assert.equal(canTransition("QUEUED", "ORPHANED"), false);
  });
});

describe("recovery classification", () => {
  it("orphans anything that was mid-flight", () => {
    assert.equal(recoveryStateFor("PREPARING"), "ORPHANED");
    assert.equal(recoveryStateFor("RUNNING"), "ORPHANED");
    assert.equal(recoveryStateFor("VALIDATING"), "ORPHANED");
    assert.equal(recoveryStateFor("BLOCKED"), "ORPHANED");
  });

  it("leaves terminal runs untouched", () => {
    for (const state of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      assert.equal(recoveryStateFor(state), undefined);
    }
  });

  it("leaves a queued run resumable", () => {
    // Nothing was launched, so there is nothing indeterminate about it.
    assert.equal(recoveryStateFor("QUEUED"), undefined);
  });

  it("does not re-orphan an existing orphan", () => {
    assert.equal(recoveryStateFor("ORPHANED"), undefined);
  });

  it("only ever produces a legal transition", () => {
    for (const from of RUN_STATES) {
      const to = recoveryStateFor(from);
      if (to === undefined) continue;
      assert.equal(
        canTransition(from, to),
        true,
        `recovery would attempt an illegal ${from} -> ${to}`,
      );
    }
  });
});
