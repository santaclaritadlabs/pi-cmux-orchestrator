import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { parseAgentEvent, sampleTask, type AgentTask } from "@pi-cmux/protocol";
import { temporaryDirectory } from "@pi-cmux/testkit";

import {
  READ_ONLY_PROFILE,
  decide,
  policyEvent,
  ruleNames,
  type PolicyProfile,
} from "./decide.ts";

/** A task whose worktree really exists, so containment rules can run. */
async function taskIn(
  root: string,
  overrides: Partial<AgentTask> = {},
): Promise<AgentTask> {
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(worktree, "src"), { recursive: true });

  const base = sampleTask();
  return {
    ...base,
    workspace: { ...base.workspace, worktreePath: worktree },
    constraints: {
      ...base.constraints,
      mayWrite: false,
      allowedPaths: [path.join(worktree, "src")],
    },
    ...overrides,
  };
}

describe("the default is deny", () => {
  it("admits a task only when every rule allows it", async () => {
    await using dir = await temporaryDirectory();
    const decision = await decide(await taskIn(dir.path));

    assert.equal(decision.ok, true);
    assert.equal(decision.value.allowed, true);
  });

  it("admits the Codex worker once the P3 adapter is enabled", async () => {
    await using dir = await temporaryDirectory();
    const task = await taskIn(dir.path, {
      worker: { kind: "codex", profile: "default" },
    });

    const decision = await decide(task);
    assert.equal(decision.ok, true);
  });

  it("admits the Claude, Cursor, and Antigravity workers once P5 reviews them", async () => {
    await using dir = await temporaryDirectory();
    // `worker.kind-requires-sandbox` demands `sandbox: "required"`, and
    // `constraints.sandbox` in turn demands `profile.sandboxAvailable` — so
    // admitting these kinds today needs a profile no phase actually ships
    // yet, representing the day a real isolating provider is registered.
    // See "allows what a later phase enables, without changing the rules"
    // below for the same pattern.
    const isolatedProfile: PolicyProfile = {
      ...READ_ONLY_PROFILE,
      sandboxAvailable: true,
    };
    for (const kind of ["claude", "cursor", "antigravity"] as const) {
      const base = await taskIn(dir.path, {
        worker: { kind, profile: "default" },
      });
      const task: AgentTask = {
        ...base,
        constraints: { ...base.constraints, sandbox: "required" },
      };

      const decision = await decide(task, isolatedProfile);
      assert.equal(decision.ok, true, `expected ${kind} to be admitted`);
    }
  });

  it("denies Claude, Cursor, and Antigravity without a required sandbox", async () => {
    // The confirmed gap this rule closes: nothing today isolates these
    // workers from the host, so admitting them without demanding real
    // isolation would run an unmodified provider CLI directly on the host.
    await using dir = await temporaryDirectory();
    for (const kind of ["claude", "cursor", "antigravity"] as const) {
      for (const sandbox of ["preferred", "none"] as const) {
        const task = await taskIn(dir.path, {
          worker: { kind, profile: "default" },
          constraints: { ...(await taskIn(dir.path)).constraints, sandbox },
        });

        const decision = await decide(task);
        assert.equal(decision.ok, false, `expected ${kind}/${sandbox} denied`);
        assert.equal(
          decision.error.details?.["rule"],
          "worker.kind-requires-sandbox",
        );
      }
    }
  });

  it("is never retryable — a denial must not be beatable by looping", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    // A worker kind outside the reviewed set can only reach `decide` through
    // a stale schema or a cast — parseAgentTask's closed union already
    // excludes it — but the runtime check in worker.kind-supported guards it
    // anyway, so this still exercises a real denial rather than a vacuous one.
    const task = {
      ...base,
      worker: { kind: "unreviewed-worker-kind", profile: "default" },
    } as unknown as AgentTask;

    const decision = await decide(task);
    assert.equal(decision.ok, false);
    assert.equal(decision.error.retryable, false);
  });

  it("reports the first applicable denial, the most specific one", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      worker: { kind: "claude", profile: "default" },
      constraints: {
        ...base.constraints,
        // Required, so worker.kind-requires-sandbox does not mask the
        // ordering this test actually exercises.
        sandbox: "required",
        mayWrite: true,
        network: "allow",
        networkAllowlist: [],
      },
    };

    const decision = await decide(task);
    assert.equal(decision.ok, false);
    // constraints.writes comes before constraints.network in the table, and
    // claude is now a reviewed worker kind so it no longer masks this case.
    assert.equal(decision.error.details?.["rule"], "constraints.writes");
  });
});

describe("P1 refuses everything it cannot yet do safely", () => {
  const cases: readonly [string, (t: AgentTask) => AgentTask, string][] = [
    [
      "writes",
      (t) => ({ ...t, constraints: { ...t.constraints, mayWrite: true } }),
      "constraints.writes",
    ],
    [
      "commits",
      (t) => ({
        ...t,
        constraints: { ...t.constraints, mayWrite: true, mayCommit: true },
      }),
      "constraints.writes",
    ],
    [
      "network",
      (t) => ({
        ...t,
        constraints: {
          ...t.constraints,
          network: "allowlist",
          networkAllowlist: ["registry.npmjs.org"],
        },
      }),
      "constraints.network",
    ],
    [
      "a required sandbox",
      (t) => ({ ...t, constraints: { ...t.constraints, sandbox: "required" } }),
      "constraints.sandbox",
    ],
  ];

  for (const [label, mutate, expectedRule] of cases) {
    it(`denies ${label}`, async () => {
      await using dir = await temporaryDirectory();
      const decision = await decide(mutate(await taskIn(dir.path)));

      assert.equal(decision.ok, false);
      assert.equal(decision.error.details?.["rule"], expectedRule);
    });
  }

  it("refuses a required sandbox rather than falling back to the host", async () => {
    // CLAUDE.md is explicit: no silent fallback.
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const decision = await decide({
      ...base,
      constraints: { ...base.constraints, sandbox: "required" },
    });

    assert.equal(decision.ok, false);
    assert.match(String(decision.error.details?.["reason"]), /isolation/);
  });

  it("allows what a later phase enables, without changing the rules", async () => {
    // The gates are written now and switched on by the profile, so P2 turns
    // them on rather than inventing them.
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const writing: AgentTask = {
      ...base,
      constraints: { ...base.constraints, mayWrite: true },
    };

    assert.equal((await decide(writing)).ok, false);

    const p2Profile: PolicyProfile = {
      ...READ_ONLY_PROFILE,
      allowWrites: true,
    };
    assert.equal((await decide(writing, p2Profile)).ok, true);
  });
});

describe("worktree containment is enforced by policy", () => {
  it("denies an allowedPath outside the assigned worktree", async () => {
    // A path outside the worktree is not a narrower permission; it is wider.
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const decision = await decide({
      ...base,
      constraints: {
        ...base.constraints,
        allowedPaths: [path.join(dir.path, "somewhere-else")],
      },
    });

    assert.equal(decision.ok, false);
    assert.equal(
      decision.error.details?.["rule"],
      "workspace.allowed-paths-contained",
    );
  });

  it("accepts an allowedPath inside the worktree", async () => {
    await using dir = await temporaryDirectory();
    assert.equal((await decide(await taskIn(dir.path))).ok, true);
  });
});

describe("every decision is an auditable event", () => {
  it("emits a valid policy event when allowed", async () => {
    await using dir = await temporaryDirectory();
    const decision = await decide(await taskIn(dir.path));

    const event = policyEvent(
      "AUTH-41",
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      0,
      "2026-08-08T05:00:00.000Z",
      decision,
    );

    // It must survive the same validation as any other event: a policy record
    // that cannot be persisted is not an audit trail.
    const parsed = parseAgentEvent(JSON.parse(JSON.stringify(event)));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.type, "policy");
    assert.equal(parsed.value.payload["decision"], "allowed");
  });

  it("emits a denial event naming the rule and reason", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const decision = await decide({
      ...base,
      constraints: { ...base.constraints, sandbox: "required" },
    });

    const event = policyEvent(
      "AUTH-41",
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      1,
      "2026-08-08T05:00:01.000Z",
      decision,
    );

    const parsed = parseAgentEvent(JSON.parse(JSON.stringify(event)));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.payload["decision"], "denied");
    assert.equal(parsed.value.payload["rule"], "constraints.sandbox");
    assert.match(String(parsed.value.payload["reason"]), /isolation/);
  });
});

describe("capabilities fail closed", () => {
  it("denies a capability this build does not recognise", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      constraints: {
        ...base.constraints,
        capabilities: ["repo.read", "definitely.not.a.capability"],
      },
    };

    const decision = await decide(task);
    assert.equal(decision.ok, false);
    // Not POLICY_DENIED: the request is not something this build understands,
    // which is a different answer from "not permitted here".
    assert.equal(decision.error.code, "CAPABILITY_UNSUPPORTED");

    const details = decision.error.details;
    assert.ok(details !== undefined);
    assert.equal(details["rule"], "constraints.capabilities-known");
    // The denial names the offender rather than making the operator diff lists.
    assert.match(String(details["reason"]), /definitely\.not\.a\.capability/);
  });

  it("admits the capabilities it does recognise", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      constraints: {
        ...base.constraints,
        capabilities: ["repo.read", "test.run"],
      },
    };

    const decision = await decide(task);
    assert.equal(decision.ok, true);
  });

  it("refuses a capability the task's own constraints contradict", async () => {
    // `capabilities` must not become a second permission channel that disagrees
    // with the flags: whichever component read the list would be the one wrong.
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      constraints: {
        ...base.constraints,
        mayWrite: false,
        capabilities: ["repo.write"],
      },
    };

    const decision = await decide(task);
    assert.equal(decision.ok, false);
    assert.equal(decision.error.code, "CAPABILITY_UNSUPPORTED");
    assert.equal(
      decision.error.details?.["rule"],
      "constraints.capabilities-consistent",
    );
  });

  it("refuses network capability under a deny network mode", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      constraints: {
        ...base.constraints,
        network: "deny",
        capabilities: ["net.fetch"],
      },
    };

    const decision = await decide(task);
    assert.equal(decision.ok, false);
    assert.equal(decision.error.code, "CAPABILITY_UNSUPPORTED");
  });

  it("records an unsupported capability on the audit trail", async () => {
    await using dir = await temporaryDirectory();
    const base = await taskIn(dir.path);
    const task: AgentTask = {
      ...base,
      constraints: { ...base.constraints, capabilities: ["nope"] },
    };

    const decision = await decide(task);
    const event = policyEvent(
      "AUTH-41",
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      0,
      "2026-08-08T05:00:01.000Z",
      decision,
    );

    const parsed = parseAgentEvent(JSON.parse(JSON.stringify(event)));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.payload["decision"], "denied");
    assert.equal(
      parsed.value.payload["rule"],
      "constraints.capabilities-known",
    );
  });
});

describe("the rule set is enumerable", () => {
  it("exposes its rules so a runbook can list what is enforced", () => {
    const names = ruleNames();
    assert.ok(names.includes("constraints.no-push"));
    assert.ok(names.includes("constraints.sandbox"));
    assert.ok(names.includes("workspace.allowed-paths-contained"));
    assert.equal(
      new Set(names).size,
      names.length,
      "rule names must be unique",
    );
  });
});
