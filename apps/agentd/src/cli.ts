/**
 * `agentd` — the operator's interface to the daemon.
 *
 *     agentd start                 run the daemon in the foreground
 *     agentd status                is it up, and how many runs are live
 *     agentd runs                  every run on disk, oldest first
 *     agentd logs --follow <runId> tail a run's normalized events
 *
 * `logs --follow` is exactly what a cmux pane will run in P4. That is the whole
 * reason worker processes do not live inside a pane: closing a workspace by
 * accident kills a tail, not a worker.
 *
 * Machine-readable output goes to stdout; logs go to stderr. Interleaving them
 * would corrupt whatever is parsing the former.
 */

import { RunStore } from "@pi-cmux/core";
import { createLogger } from "@pi-cmux/observability";
import { isTerminalRunState } from "@pi-cmux/protocol";

import { connectToDaemon } from "./client.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";
import { HostSandboxProvider, SandboxRegistry } from "@pi-cmux/sandbox";
import { WorktreeManager } from "@pi-cmux/worktrees";

import { loadRepositories } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { prepareDaemonDirectories, resolveDaemonPaths } from "./paths.ts";
import { recoverRuns } from "./recovery.ts";
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
      "  runs                     list runs, oldest first",
      "  logs --follow <runId>    stream a run's events",
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
    case "runs":
      return await commandRuns();
    case "logs":
      return await commandLogs(argv.slice(1));
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
