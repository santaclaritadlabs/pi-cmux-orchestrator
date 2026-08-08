import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createFixtureRepository,
  git,
  installHook,
  setLocalConfig,
  temporaryDirectory,
  type FixtureRepository,
} from "@pi-cmux/testkit";

import {
  WorktreeManager,
  branchNameFor,
  type ProvisionRequest,
} from "./manager.ts";
import { describeWorktree } from "./repository.ts";

const RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";
const OTHER_RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWD";
const TASK_ID = "AUTH-41";

type Fixture = Readonly<{
  root: string;
  repository: FixtureRepository;
  manager: WorktreeManager;
  worktreePath: string;
}>;

function fixtureIn(directory: string, repository: FixtureRepository): Fixture {
  const root = path.join(directory, "worktrees");
  return {
    root,
    repository,
    manager: new WorktreeManager({ root }),
    worktreePath: path.join(root, `${TASK_ID}-${RUN_ID}`),
  };
}

function request(
  fixture: Fixture,
  overrides: Partial<ProvisionRequest> = {},
): ProvisionRequest {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    repoId: "acme/api",
    repoPath: fixture.repository.path,
    worktreePath: fixture.worktreePath,
    baseRef: "main",
    ...overrides,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("provisioning", () => {
  it("creates a detached worktree at the recorded base commit", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));

    assert.equal(provisioned.ok, true);
    assert.equal(provisioned.value.record.baseSha, repository.headSha);
    assert.equal(provisioned.value.record.initialHeadSha, repository.headSha);
    assert.equal(provisioned.value.record.branch, undefined);
    assert.ok(await exists(path.join(provisioned.value.path, "README.md")));

    // Detached, so a commit cannot quietly advance a branch someone else reads.
    const head = await git(provisioned.value.path, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]).then(
      () => "attached",
      () => "detached",
    );
    assert.equal(head, "detached");
  });

  it("pins the base commit even when the branch moves afterwards", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);

    await writeFile(path.join(repository.path, "later.txt"), "later\n", "utf8");
    await git(repository.path, ["add", "--all"]);
    await git(repository.path, ["commit", "--quiet", "-m", "later"]);

    // The run started from a fact, not from whatever `main` says today.
    const status = await describeWorktree(provisioned.value.path);
    assert.equal(status.ok, true);
    assert.equal(status.value.headSha, repository.headSha);
  });

  it("creates a named branch when the task may commit", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(
      request(fixture, { createBranch: true }),
    );

    assert.equal(provisioned.ok, true);
    assert.equal(provisioned.value.record.branch, `agent/${TASK_ID}/${RUN_ID}`);
    const branch = await git(provisioned.value.path, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    assert.equal(branch.trim(), `agent/${TASK_ID}/${RUN_ID}`);
  });

  it("refuses identifiers that cannot be a branch name", () => {
    assert.equal(branchNameFor("../escape", RUN_ID).ok, false);
    assert.equal(branchNameFor(TASK_ID, "run id").ok, false);
    assert.equal(branchNameFor(TASK_ID, RUN_ID).ok, true);
  });
});

describe("the repository hook boundary", () => {
  it("does not run a repository hook when checking out", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const marker = path.join(directory.path, "hook-fired");
    await installHook(repository.path, "post-checkout", marker);

    // Control: plain git, no hardening. If this does not fire, the assertion
    // below proves nothing — the hook has to be capable of running at all.
    await git(repository.path, [
      "worktree",
      "add",
      "--detach",
      path.join(directory.path, "control"),
      repository.headSha,
    ]);
    assert.equal(
      await exists(marker),
      true,
      "the control checkout should have fired the hook",
    );

    await rm(marker);

    const provisioned = await fixture.manager.provision(request(fixture));

    assert.equal(provisioned.ok, true);
    assert.ok(await exists(path.join(provisioned.value.path, "README.md")));
    // `git worktree add` checks files out, and a checkout fires post-checkout.
    assert.equal(
      await exists(marker),
      false,
      "the repository hook must not run",
    );
  });

  it("refuses a repository whose configuration executes a program", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);
    await setLocalConfig(repository.path, "core.fsmonitor", "/tmp/payload.sh");

    const provisioned = await fixture.manager.provision(request(fixture));

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "REPO_UNSAFE");
    // Refused before anything was claimed or created.
    assert.equal(await exists(fixture.worktreePath), false);
  });
});

describe("path containment", () => {
  it("refuses a worktree outside the configured root", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(
      request(fixture, {
        worktreePath: path.join(directory.path, "elsewhere"),
      }),
    );

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "PATH_ESCAPE");
  });

  it("refuses traversal out of the root", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(
      request(fixture, {
        worktreePath: path.join(fixture.root, "..", "escaped"),
      }),
    );

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "PATH_ESCAPE");
  });

  it("refuses a worktree nested inside the primary checkout", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    // Root set wide enough that containment alone would let this through; the
    // nesting check is what refuses it.
    const manager = new WorktreeManager({ root: directory.path });

    const provisioned = await manager.provision({
      runId: RUN_ID,
      taskId: TASK_ID,
      repoId: "acme/api",
      repoPath: repository.path,
      worktreePath: path.join(repository.path, "nested"),
      baseRef: "main",
    });

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "PATH_ESCAPE");
  });

  it("refuses the root itself", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(
      request(fixture, { worktreePath: fixture.root }),
    );

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "PATH_ESCAPE");
  });
});

describe("exclusive ownership", () => {
  it("refuses a second run for the same directory", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const first = await fixture.manager.provision(request(fixture));
    assert.equal(first.ok, true);

    const second = await fixture.manager.provision(
      request(fixture, { runId: OTHER_RUN_ID }),
    );

    assert.equal(second.ok, false);
    assert.equal(second.error.code, "WORKTREE_CONFLICT");
    assert.equal(second.error.details?.["heldBy"], RUN_ID);
  });

  it("resolves a concurrent race to exactly one winner", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    // O_EXCL is the mechanism, so this holds without any coordination between
    // the two callers.
    const outcomes = await Promise.all([
      fixture.manager.provision(request(fixture)),
      fixture.manager.provision(request(fixture, { runId: OTHER_RUN_ID })),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    const loser = outcomes.find((outcome) => !outcome.ok);
    assert.equal(loser?.ok, false);
    assert.equal(loser.error.code, "WORKTREE_CONFLICT");
  });

  it("keeps the claim when creation fails, so cleanup can still prove it", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    // A non-empty target makes `git worktree add` refuse.
    await mkdir(fixture.worktreePath, { recursive: true });
    await writeFile(
      path.join(fixture.worktreePath, "occupied.txt"),
      "in the way\n",
      "utf8",
    );

    const provisioned = await fixture.manager.provision(request(fixture));

    assert.equal(provisioned.ok, false);
    assert.equal(provisioned.error.code, "GIT_COMMAND_FAILED");

    // The record survives and is marked as never created: evidence that
    // something *may* exist, which is what makes cleanup possible.
    const unreleased = await fixture.manager.listUnreleased();
    assert.equal(unreleased.ok, true);
    assert.equal(unreleased.value.length, 1);
    const claim = unreleased.value[0];
    assert.ok(claim !== undefined);
    assert.equal(claim.runId, RUN_ID);
    assert.equal(claim.createdAt, undefined);
  });
});

describe("release", () => {
  it("captures the final state, removes the directory and keeps the record", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);
    await writeFile(
      path.join(provisioned.value.path, "worked.txt"),
      "output\n",
      "utf8",
    );

    const released = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
    });

    assert.equal(released.ok, true);
    assert.equal(released.value.removed, true);
    const status = released.value.status;
    assert.ok(status !== undefined, "the final state must be observed");
    assert.equal(status.dirty, true);
    assert.deepEqual(status.changedFiles, ["worked.txt"]);
    assert.equal(released.value.record.finalHeadSha, repository.headSha);
    assert.equal(released.value.record.dirtyAtRelease, true);
    assert.equal(await exists(fixture.worktreePath), false);

    // The cleanup record outlives the worktree — that is what makes it a record.
    const record = await fixture.manager.records.read(
      released.value.record.worktreePath,
    );
    assert.equal(record.ok, true);
    assert.notEqual(record.value.releasedAt, undefined);
  });

  it("keeps the files when asked only to record the outcome", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);

    const released = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
      remove: false,
    });

    assert.equal(released.ok, true);
    assert.equal(released.value.removed, false);
    assert.equal(await exists(fixture.worktreePath), true);
  });

  it("refuses to remove a worktree another run owns", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);

    const released = await fixture.manager.release({
      runId: OTHER_RUN_ID,
      worktreePath: fixture.worktreePath,
    });

    assert.equal(released.ok, false);
    assert.equal(released.error.code, "WORKTREE_OWNERSHIP_UNPROVEN");
    // Nothing was deleted. An unprovable claim is not a licence to guess.
    assert.equal(await exists(fixture.worktreePath), true);
  });

  it("refuses a directory with no ownership record at all", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);
    const unclaimed = path.join(fixture.root, "not-ours");
    await mkdir(unclaimed, { recursive: true });

    const released = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: unclaimed,
    });

    assert.equal(released.ok, false);
    assert.equal(released.error.code, "WORKTREE_OWNERSHIP_UNPROVEN");
    assert.equal(await exists(unclaimed), true);
  });

  it("is idempotent, because cleanup has to be retryable", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);

    const first = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
    });
    const second = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.value.removed, false);
  });

  it("closes a claim that never became a worktree", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    await mkdir(fixture.worktreePath, { recursive: true });
    await writeFile(
      path.join(fixture.worktreePath, "occupied.txt"),
      "in the way\n",
      "utf8",
    );
    const failed = await fixture.manager.provision(request(fixture));
    assert.equal(failed.ok, false);

    const released = await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
    });

    assert.equal(released.ok, true);
    assert.equal(released.value.removed, false);
    // The directory was never ours, so it is left exactly as it was found.
    assert.equal(
      await exists(path.join(fixture.worktreePath, "occupied.txt")),
      true,
    );
  });
});

describe("recovery reporting", () => {
  it("lists what was claimed and never released", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    const fixture = fixtureIn(directory.path, repository);

    const provisioned = await fixture.manager.provision(request(fixture));
    assert.equal(provisioned.ok, true);

    const before = await fixture.manager.listUnreleased();
    assert.equal(before.ok, true);
    assert.equal(before.value.length, 1);
    assert.equal(before.value[0]?.runId, RUN_ID);

    await fixture.manager.release({
      runId: RUN_ID,
      worktreePath: fixture.worktreePath,
    });

    const after = await fixture.manager.listUnreleased();
    assert.equal(after.ok, true);
    assert.equal(after.value.length, 0);
  });

  it("reports no records before anything has been claimed", async () => {
    await using directory = await temporaryDirectory("pi-cmux-wt-");
    const manager = new WorktreeManager({
      root: path.join(directory.path, "never-used"),
    });

    const listed = await manager.listUnreleased();

    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, []);
  });
});
