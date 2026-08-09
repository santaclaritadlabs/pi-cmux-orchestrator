/**
 * `agentd` — the operator's interface to the daemon.
 *
 *     agentd start                 run the daemon in the foreground
 *     agentd status                is it up, and how many runs are live
 *     agentd capabilities          what each reviewed worker kind supports
 *     agentd runs                  every run on disk, oldest first
 *     agentd worktrees             claimed worktrees nobody has released
 *     agentd logs --follow <runId> tail a run's normalized events
 *     agentd verify                smoke-test this artifact end to end
 *
 * `logs --follow` is exactly what a cmux pane will run in P4. That is the whole
 * reason worker processes do not live inside a pane: closing a workspace by
 * accident kills a tail, not a worker.
 *
 * Machine-readable output goes to stdout; logs go to stderr. Interleaving them
 * would corrupt whatever is parsing the former.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunStore } from "@pi-cmux/core";
import { createLogger } from "@pi-cmux/observability";
import { isTerminalRunState, sampleTask } from "@pi-cmux/protocol";

import { connectToDaemon } from "./client.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";
import { HostSandboxProvider, SandboxRegistry } from "@pi-cmux/sandbox";
import { WorktreeManager } from "@pi-cmux/worktrees";

import { loadRepositories } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { prepareDaemonDirectories, resolveDaemonPaths } from "./paths.ts";
import { recoverRuns } from "./recovery.ts";
import { RepositoryRegistry } from "./repositories.ts";
import { startServer } from "./server.ts";

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function usage(): void {
  process.stderr.write(
    [
      "usage: agentd <command>",
      "",
      "  start                    run the daemon in the foreground",
      "  status                   report daemon health",
      "  capabilities             list each reviewed worker kind's capabilities",
      "  runs                     list runs, oldest first",
      "  worktrees                list worktrees claimed but never released",
      "  logs --follow <runId>    stream a run's events",
      "  verify                   smoke-test this artifact end to end",
      "",
    ].join("\n"),
  );
}

async function commandStart(): Promise<number> {
  const paths = resolveDaemonPaths();
  const logger = createLogger({ level: "info" }).child({ component: "agentd" });

  const prepared = await prepareDaemonDirectories(paths);
  if (!prepared.ok) {
    logger.error("could not prepare daemon directories", {
      code: prepared.error.code,
      message: prepared.error.safeMessage,
    });
    return 1;
  }

  // Ownership first. Recovery rewrites run states and the server unlinks the
  // socket; neither may happen until this daemon knows it is the only one.
  const lock = await acquireDaemonLock({ lockPath: paths.lockPath });
  if (!lock.ok) {
    logger.error("could not claim the runtime directory", {
      code: lock.error.code,
      message: lock.error.safeMessage,
    });
    return 1;
  }

  const store = new RunStore({ root: paths.stateDir });

  // Recovery runs *before* the socket opens. A client must never see a run
  // still claiming RUNNING from a previous incarnation.
  const recovered = await recoverRuns({ store, logger });
  if (!recovered.ok) {
    logger.error("recovery could not restore a safe runtime", {
      code: recovered.error.code,
      message: recovered.error.safeMessage,
    });
    await lock.value.release();
    return 1;
  }
  const report = recovered.value;
  logger.info("recovery complete", {
    inspected: report.inspected,
    orphaned: report.orphaned.length,
    terminated: report.terminated.length,
    // An operator needs to know immediately: these are processes still on the
    // host that this daemon could neither supervise nor stop.
    unstoppable: report.terminated.filter((run) => !run.stopped).length,
  });

  const repositories = await loadRepositories(paths.repositoriesPath);
  if (!repositories.ok) {
    // Unusable configuration is a refusal to start. A daemon that boots with a
    // half-understood allowlist is granting access nobody wrote down.
    logger.error("could not load the repository allowlist", {
      code: repositories.error.code,
      message: repositories.error.safeMessage,
    });
    await lock.value.release();
    return 1;
  }
  logger.info("repository allowlist loaded", {
    repositories: repositories.value.size,
  });

  const worktrees = new WorktreeManager({ root: paths.worktreeRoot, logger });
  const stale = await worktrees.listUnreleased();
  if (stale.ok && stale.value.length > 0) {
    // Reported, never reclaimed: a worktree whose run's outcome is unknown may
    // hold the only copy of that run's work.
    logger.warn("worktrees claimed by a previous incarnation", {
      count: stale.value.length,
    });
  }

  const sandbox = new SandboxRegistry([new HostSandboxProvider()], { logger });

  const orchestrator = new Orchestrator({
    store,
    repositories: repositories.value,
    worktrees,
    sandbox,
    workerHomeRoot: paths.workerHomeRoot,
    logger,
  });
  const server = await startServer({ paths, orchestrator, logger });
  if (!server.ok) {
    logger.error("could not start the RPC server", {
      code: server.error.code,
      message: server.error.safeMessage,
    });
    await lock.value.release();
    return 1;
  }

  out(
    JSON.stringify({
      status: "listening",
      socketPath: server.value.socketPath,
      pid: process.pid,
    }),
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async (): Promise<void> => {
      logger.info("shutting down", { signal });
      server.value.stopAccepting();
      await orchestrator.shutdown();
      await server.value.close();
      const released = await lock.value.release();
      process.exit(released.ok ? 0 : 1);
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Hold the process open. The socket server already refs the event loop; this
  // promise makes the intent explicit rather than incidental.
  await new Promise<never>(() => undefined);
  return 0;
}

async function withClient<T>(
  fn: (call: Awaited<ReturnType<typeof connectToDaemon>>) => Promise<T>,
): Promise<T> {
  const paths = resolveDaemonPaths();
  const client = await connectToDaemon({
    socketPath: paths.socketPath,
    tokenPath: paths.tokenPath,
    client: "agentd-cli",
  });
  return await fn(client);
}

async function commandStatus(): Promise<number> {
  return await withClient(async (connected) => {
    if (!connected.ok) {
      process.stderr.write(`${connected.error.safeMessage}\n`);
      return 1;
    }
    const health = await connected.value.call("daemon.health");
    connected.value.close();

    if (!health.ok) {
      process.stderr.write(`${health.error.safeMessage}\n`);
      return 1;
    }
    out(JSON.stringify(health.value, null, 2));
    return 0;
  });
}

async function commandCapabilities(): Promise<number> {
  return await withClient(async (connected) => {
    if (!connected.ok) {
      process.stderr.write(`${connected.error.safeMessage}\n`);
      return 1;
    }
    const capabilities = await connected.value.call("worker.capabilities");
    connected.value.close();

    if (!capabilities.ok) {
      process.stderr.write(`${capabilities.error.safeMessage}\n`);
      return 1;
    }
    out(JSON.stringify(capabilities.value, null, 2));
    return 0;
  });
}

async function commandRuns(): Promise<number> {
  // Reads the store directly: listing runs needs no daemon, and an operator
  // investigating a daemon that will not start still needs to see them.
  const paths = resolveDaemonPaths();
  const store = new RunStore({ root: paths.stateDir });

  const listed = await store.listRunIds();
  if (!listed.ok) {
    process.stderr.write(`${listed.error.safeMessage}\n`);
    return 1;
  }

  for (const runId of listed.value) {
    const state = await store.readState(runId);
    const label = state.ok ? state.value.state : "UNREADABLE";
    const taskId = state.ok ? state.value.taskId : "?";
    out(`${runId}  ${label.padEnd(11)} ${taskId}`);
  }
  return 0;
}

async function commandWorktrees(): Promise<number> {
  // Reads records directly, like `runs`: an operator chasing a worktree left
  // behind by a daemon that orphaned its run — see docs/runbooks/recovery.md —
  // needs this even when that daemon is long gone.
  const paths = resolveDaemonPaths();
  const worktrees = new WorktreeManager({ root: paths.worktreeRoot });

  const unreleased = await worktrees.listUnreleased();
  if (!unreleased.ok) {
    process.stderr.write(`${unreleased.error.safeMessage}\n`);
    return 1;
  }

  for (const record of unreleased.value) {
    out(`${record.runId}  ${record.worktreePath}  claimed ${record.claimedAt}`);
  }
  return 0;
}

/**
 * Prove this artifact actually runs, not just that it typechecked.
 *
 * Bundling for release can break what the test suite cannot see: a module
 * that locates a sibling file relative to itself, for instance, resolves
 * differently once its code is bundled into a different file. So this drives
 * the daemon's real components — including the `fake` worker, whose child
 * process is exactly the kind of relative lookup a bundle can break — through
 * one full run, in-process, with no RPC socket and nothing left behind on
 * disk. It is a smoke test of the artifact, not a rerun of `pnpm verify`:
 * that already covers format, lint, types and every unit and integration
 * test, and none of that is repeated here.
 */
async function commandVerify(): Promise<number> {
  const logger = createLogger({ level: "warn" }).child({
    component: "agentd-verify",
  });

  const scratch = await mkdtemp(path.join(tmpdir(), "agentd-verify-"));
  try {
    const repoPath = path.join(scratch, "repo");
    initScratchRepo(repoPath);

    const store = new RunStore({ root: path.join(scratch, "state") });
    const worktrees = new WorktreeManager({
      root: path.join(scratch, "worktrees"),
      logger,
    });
    const repositories = new RepositoryRegistry([
      { repoId: "verify", path: repoPath },
    ]);
    const sandbox = new SandboxRegistry([new HostSandboxProvider()], {
      logger,
    });
    const orchestrator = new Orchestrator({
      store,
      repositories,
      worktrees,
      sandbox,
      // Scratch-local, like every other root here — a smoke test must not
      // touch (or depend on) the real operator's worker-home state.
      workerHomeRoot: path.join(scratch, "worker-home"),
      logger,
    });

    // Once the orchestrator exists it owns a worker-capable process; every
    // exit path below must reach `shutdown()`, including a poll failure, or
    // the run (and any live worker) leaks past this function returning.
    try {
      const task = sampleTask({
        taskId: "task_01JQZXVERIFY00000000000A",
        worker: { kind: "fake", profile: "default" },
        workspace: {
          repoId: "verify",
          worktreePath: path.join(scratch, "worktrees", "verify-1"),
          baseRef: "main",
        },
        constraints: {
          allowedPaths: [path.join(scratch, "worktrees", "verify-1")],
          forbiddenPaths: [],
          network: "deny",
          networkAllowlist: [],
          sandbox: "preferred",
          mayWrite: true,
          mayCommit: false,
          mayPush: false,
          capabilities: [],
        },
      });

      const created = await orchestrator.createTask(task);
      if (!created.ok) {
        process.stderr.write(
          `verify: could not create the task: ${created.error.safeMessage}\n`,
        );
        return 1;
      }
      const started = await orchestrator.startRun(created.value.runId);
      if (!started.ok) {
        process.stderr.write(
          `verify: could not start the task: ${started.error.safeMessage}\n`,
        );
        return 1;
      }

      const deadline = Date.now() + 30_000;
      let final = started.value;
      while (!isTerminalRunState(final.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const polled = await orchestrator.status(created.value.runId);
        if (!polled.ok) {
          process.stderr.write(
            `verify: could not poll the task: ${polled.error.safeMessage}\n`,
          );
          return 1;
        }
        final = polled.value;
      }

      if (final.state !== "SUCCEEDED") {
        process.stderr.write(
          `verify: FAILED — the fake worker did not succeed (state: ${final.state})\n`,
        );
        return 1;
      }

      out(
        "verify: OK — daemon booted, admitted a task, ran the fake worker to completion",
      );
      return 0;
    } finally {
      await orchestrator.shutdown();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Timeout for the scratch-repo git calls below: this is a smoke test, not a task. */
const VERIFY_GIT_TIMEOUT_MS = 10_000;

/**
 * Isolated from the operator's own git config, same reasoning as
 * `buildWorkerEnvironment`: an inherited `commit.gpgsign=true` would hang
 * this on a GPG prompt with no TTY, forever in CI. `-c commit.gpgsign=false`
 * on the commit is defense-in-depth in case a caller ever merges these in
 * with an inherited environment.
 */
const VERIFY_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** A one-commit repository, just enough for `baseRef: "main"` to resolve. */
function initScratchRepo(repoPath: string): void {
  execFileSync(
    "git",
    ["init", "--quiet", "--initial-branch=main", "--template=", repoPath],
    { timeout: VERIFY_GIT_TIMEOUT_MS, env: VERIFY_GIT_ENV },
  );
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "verify",
    ],
    {
      cwd: repoPath,
      timeout: VERIFY_GIT_TIMEOUT_MS,
      env: {
        ...VERIFY_GIT_ENV,
        GIT_AUTHOR_NAME: "agentd-verify",
        GIT_AUTHOR_EMAIL: "agentd-verify@localhost",
        GIT_COMMITTER_NAME: "agentd-verify",
        GIT_COMMITTER_EMAIL: "agentd-verify@localhost",
      },
    },
  );
}

async function commandLogs(argv: readonly string[]): Promise<number> {
  const follow = argv.includes("--follow");
  const runId = argv.find((arg) => arg.startsWith("run_"));

  if (runId === undefined) {
    process.stderr.write("logs requires a runId\n");
    return 64;
  }

  const paths = resolveDaemonPaths();
  const store = new RunStore({ root: paths.stateDir });
  let since = -1;

  for (;;) {
    const events = await store.readEvents(runId, since);
    if (!events.ok) {
      process.stderr.write(`${events.error.safeMessage}\n`);
      return 1;
    }

    for (const event of events.value) {
      out(JSON.stringify(event));
      since = Math.max(since, event.sequence);
    }

    if (!follow) return 0;

    const state = await store.readState(runId);
    if (state.ok && isTerminalRunState(state.value.state)) return 0;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  switch (command) {
    case "start":
      return await commandStart();
    case "status":
      return await commandStatus();
    case "capabilities":
      return await commandCapabilities();
    case "runs":
      return await commandRuns();
    case "worktrees":
      return await commandWorktrees();
    case "logs":
      return await commandLogs(argv.slice(1));
    case "verify":
      return await commandVerify();
    case undefined:
    case "--help":
    case "help":
      usage();
      return 64;
    default:
      process.stderr.write(`unknown command '${command}'\n`);
      usage();
      return 64;
  }
}

process.exitCode = await main(process.argv.slice(2));
