/**
 * Runbook verification for `docs/runbooks/audit-review.md`.
 *
 * These tests mirror the operator-facing claims about the policy audit trail
 * without going through the RPC layer — the orchestrator is the authority.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { RunStore } from "@pi-cmux/core";
import { ruleNames } from "@pi-cmux/policy";
import { sampleTask, type AgentTask } from "@pi-cmux/protocol";
import { HostSandboxProvider, SandboxRegistry } from "@pi-cmux/sandbox";
import { createFixtureRepository, temporaryDirectory } from "@pi-cmux/testkit";
import { WorktreeManager } from "@pi-cmux/worktrees";

import { Orchestrator } from "./orchestrator.ts";
import { RepositoryRegistry } from "./repositories.ts";

const REPO_ID = "acme/api";
const RULE_NAMES = new Set(ruleNames());

async function createOrchestrator(root: string) {
  const stateDir = path.join(root, "s");
  const worktreeRoot = path.join(root, "worktrees");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  const repository = await createFixtureRepository(path.join(root, "repo"));
  const store = new RunStore({ root: stateDir });

  const orchestrator = new Orchestrator({
    store,
    repositories: new RepositoryRegistry([
      { repoId: REPO_ID, path: repository.path },
    ]),
    worktrees: new WorktreeManager({ root: worktreeRoot }),
    sandbox: new SandboxRegistry([new HostSandboxProvider()]),
    workerHomeRoot: path.join(root, "homes"),
    workerArgs: ["--emit", "0"],
  });

  return { store, orchestrator, worktreeRoot };
}

function admittedTask(worktreeRoot: string): AgentTask {
  const worktreePath = path.join(worktreeRoot, "audit-admit");
  const base = sampleTask();
  return {
    ...base,
    workspace: {
      repoId: REPO_ID,
      worktreePath,
      baseRef: "main",
    },
    constraints: {
      ...base.constraints,
      mayWrite: false,
      mayCommit: false,
      allowedPaths: [path.join(worktreePath, "src")],
    },
  };
}

describe("policy audit trail (audit-review.md)", () => {
  it("writes the policy decision at sequence 0 before any worker output", async () => {
    await using dir = await temporaryDirectory();
    const { store, orchestrator, worktreeRoot } = await createOrchestrator(
      dir.path,
    );

    const created = await orchestrator.createTask(admittedTask(worktreeRoot));
    assert.ok(created.ok);

    const events = await store.readEvents(created.value.runId);
    assert.ok(events.ok);
    assert.equal(events.value.length, 1);

    const audit = events.value[0];
    assert.ok(audit !== undefined);
    assert.equal(audit.sequence, 0);
    assert.equal(audit.type, "policy");
    assert.equal(audit.payload["decision"], "allowed");
    assert.ok(
      RULE_NAMES.has(String(audit.payload["rule"])) ||
        audit.payload["rule"] === "default",
    );
  });

  it("creates a durable run record for a denied task with a sequence-0 policy event", async () => {
    await using dir = await temporaryDirectory();
    const { store, orchestrator, worktreeRoot } = await createOrchestrator(
      dir.path,
    );

    const task = {
      ...admittedTask(worktreeRoot),
      constraints: {
        ...admittedTask(worktreeRoot).constraints,
        mayWrite: true,
        mayCommit: true,
      },
    };

    const created = await orchestrator.createTask(task);
    assert.ok(created.ok);
    assert.equal(created.value.state, "FAILED");

    const listed = await store.listRunIds();
    assert.ok(listed.ok);
    assert.ok(listed.value.includes(created.value.runId));

    const events = await store.readEvents(created.value.runId);
    assert.ok(events.ok);
    const audit = events.value[0];
    assert.ok(audit !== undefined);
    assert.equal(audit.sequence, 0);
    assert.equal(audit.type, "policy");
    assert.equal(audit.payload["decision"], "denied");
    assert.ok(RULE_NAMES.has(String(audit.payload["rule"])));
    assert.ok(typeof audit.payload["reason"] === "string");

    const result = await store.readResult(created.value.runId);
    assert.ok(result.ok);
    assert.equal(result.value.status, "blocked");
  });
});
