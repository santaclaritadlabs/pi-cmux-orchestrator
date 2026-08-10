import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { RunStore } from "@pi-cmux/core";
import { pidExists } from "@pi-cmux/process-supervisor";
import { sampleTask } from "@pi-cmux/protocol";
import { createFixtureRepository, temporaryDirectory } from "@pi-cmux/testkit";
import { WorktreeManager } from "@pi-cmux/worktrees";

import { recoverRuns, type RecoveryReport } from "./recovery.ts";

async function recover(
  options: Parameters<typeof recoverRuns>[0],
): Promise<RecoveryReport> {
  const recovered = await recoverRuns(options);
  assert.ok(recovered.ok, "recovery must complete");
  return recovered.value;
}

async function createStore(root: string): Promise<RunStore> {
  const stateDir = path.join(root, "s");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return new RunStore({ root: stateDir });
}

describe("restart recovery", () => {
  it("fails closed on unreadable run state", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    await writeFile(
      path.join(store.runDirectory(created.value.runId), "state.json"),
      "not-json\n",
    );

    const recovered = await recoverRuns({ store });

    assert.equal(recovered.ok, false);
    assert.equal(recovered.error.code, "STORE_CORRUPT");
  });

  it("does not fabricate recovery from corrupt process metadata", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;
    await store.transitionState(runId, "PREPARING");
    await writeFile(
      path.join(store.runDirectory(runId), "metadata.json"),
      "{}\n",
    );

    const recovered = await recoverRuns({ store });

    assert.equal(recovered.ok, false);
    assert.equal(recovered.error.code, "STORE_CORRUPT");
    const state = await store.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "PREPARING");
  });

  it("fails closed when a leftover run lock cannot be cleared", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;
    assert.ok(
      (
        await store.acquireLock(runId, {
          pid: 999_999,
          startedAtMs: 1_000,
        })
      ).ok,
    );

    await chmod(store.runDirectory(runId), 0o500);
    try {
      const recovered = await recoverRuns({ store });
      assert.equal(recovered.ok, false);
      assert.equal(recovered.error.code, "STORE_IO_FAILED");
    } finally {
      await chmod(store.runDirectory(runId), 0o700);
    }
  });

  it("orphans a run whose worker is gone", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    await store.transitionState(runId, "PREPARING");
    await store.transitionState(runId, "RUNNING");
    await store.updateMetadata(runId, {
      pid: 999_999,
      processStartedAtMs: 1_000,
    });

    const report = await recover({ store });

    assert.equal(report.orphaned.length, 1);
    const recovered = report.orphaned[0];
    assert.ok(recovered !== undefined);
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.previousState, "RUNNING");
    assert.equal(recovered.newState, "ORPHANED");

    const state = await store.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "ORPHANED", "never SUCCEEDED by inference");
  });

  it("stops a worker that outlived its daemon and orphans the run", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    const survivor = spawn("/bin/sleep", ["120"], {
      detached: true,
      stdio: "ignore",
    });
    survivor.unref();
    const pid = survivor.pid;
    assert.ok(pid !== undefined);

    await store.transitionState(runId, "PREPARING");
    await store.transitionState(runId, "RUNNING");
    await store.updateMetadata(runId, {
      pid,
      processStartedAtMs: Date.now(),
    });

    const report = await recover({ store, terminationGraceMs: 2_000 });

    assert.equal(report.terminated.length, 1);
    const terminated = report.terminated[0];
    assert.ok(terminated !== undefined);
    assert.equal(terminated.pid, pid);
    assert.equal(
      terminated.stopped,
      true,
      "the surviving worker must actually be gone",
    );
    assert.equal(pidExists(pid), false);
    assert.equal(report.orphaned.length, 1);

    const state = await store.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "ORPHANED");
  });

  it("frees the run lock of a run it orphans", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    await store.transitionState(runId, "PREPARING");
    await store.acquireLock(runId, { pid: 999_999, startedAtMs: 1_000 });

    const report = await recover({ store });
    assert.equal(report.orphaned.length, 1);

    const relocked = await store.acquireLock(runId, {
      pid: process.pid,
      startedAtMs: Date.now(),
    });
    assert.ok(relocked.ok, "an orphaned run must not stay locked");
  });

  it("clears a lock left behind on an already-terminal run", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    await store.transitionState(runId, "PREPARING");
    await store.transitionState(runId, "RUNNING");
    await store.transitionState(runId, "VALIDATING");
    await store.transitionState(runId, "SUCCEEDED");
    await store.acquireLock(runId, { pid: 999_999, startedAtMs: 1_000 });

    const report = await recover({ store });

    assert.equal(report.untouched, 1);
    assert.equal(report.orphaned.length, 0);
    const state = await store.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "SUCCEEDED");

    const relocked = await store.acquireLock(runId, {
      pid: process.pid,
      startedAtMs: Date.now(),
    });
    assert.ok(relocked.ok, "a terminal run must not stay locked for ever");
  });

  it("leaves a terminal run untouched", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    await store.transitionState(runId, "PREPARING");
    await store.transitionState(runId, "RUNNING");
    await store.transitionState(runId, "VALIDATING");
    await store.transitionState(runId, "SUCCEEDED");

    const report = await recover({ store });

    assert.equal(report.orphaned.length, 0);
    assert.equal(report.untouched, 1);
  });

  it("orphans a mid-flight run that never recorded a process", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    await store.transitionState(created.value.runId, "PREPARING");

    const report = await recover({ store });

    assert.equal(report.orphaned.length, 1);
    assert.equal(report.orphaned[0]?.liveness, "not-launched");
  });

  it("does not disturb a QUEUED run, which was never launched", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);

    const report = await recover({ store });
    assert.equal(report.orphaned.length, 0);

    const state = await store.readState(created.value.runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "QUEUED");
  });

  it("fails closed when a surviving worker cannot be stopped", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    const { runId } = created.value;

    const survivor = spawn("/bin/sleep", ["120"], {
      detached: true,
      stdio: "ignore",
    });
    survivor.unref();
    const pid = survivor.pid;
    assert.ok(pid !== undefined);

    await store.transitionState(runId, "PREPARING");
    await store.transitionState(runId, "RUNNING");
    await store.updateMetadata(runId, {
      pid,
      processStartedAtMs: Date.now(),
    });

    const recovered = await recoverRuns({
      store,
      stopSurvivingWorker: () => Promise.resolve(false),
      sleep: () => Promise.resolve(),
    });

    assert.equal(recovered.ok, false);
    assert.equal(recovered.error.code, "RECOVERY_INCOMPLETE");

    const state = await store.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "ORPHANED");

    survivor.kill("SIGKILL");
  });

  it("does not release worktree claims during recovery", async () => {
    await using dir = await temporaryDirectory();
    const store = await createStore(dir.path);
    const repository = await createFixtureRepository(
      path.join(dir.path, "repo"),
    );
    const worktreeRoot = path.join(dir.path, "worktrees");
    const worktrees = new WorktreeManager({ root: worktreeRoot });
    const worktreePath = path.join(worktreeRoot, "AUTH-41-recovery-claim");

    const provisioned = await worktrees.provision({
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
      taskId: "AUTH-41",
      repoId: "acme/api",
      repoPath: repository.path,
      worktreePath,
      baseRef: "main",
    });
    assert.ok(provisioned.ok);

    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    await store.transitionState(created.value.runId, "PREPARING");
    await store.transitionState(created.value.runId, "RUNNING");
    await store.updateMetadata(created.value.runId, {
      pid: 999_999,
      processStartedAtMs: 1_000,
    });

    const report = await recover({ store });
    assert.equal(report.orphaned.length, 1);

    const unreleased = await worktrees.listUnreleased();
    assert.ok(unreleased.ok);
    assert.equal(unreleased.value.length, 1);
    const claim = unreleased.value[0];
    assert.ok(claim !== undefined);
    assert.equal(claim.runId, "run_01JQZX3K5T7V9B2N4M6P8R0AWC");
    assert.ok(claim.worktreePath.endsWith("AUTH-41-recovery-claim"));
  });
});
