/**
 * The service layer: what `agentd` actually does.
 *
 * Order is the whole design here. A task is validated, then judged by policy,
 * then **persisted**, and only then launched. A crash at any point leaves a
 * recoverable record rather than an untracked process, and the policy decision
 * is on the event log before the worker exists rather than after.
 *
 * Terminal state is likewise never inferred. A worker that exits zero moves to
 * `VALIDATING`, and only a result that passes validation moves it to
 * `SUCCEEDED`. CLAUDE.md: "Do not accept a worker claim of success as proof."
 */

import path from "node:path";

import {
  DEFAULT_EVENT_PAGE_SIZE,
  PROTOCOL_VERSION,
  err,
  makeError,
  ok,
  parseAgentTask,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type AgentdError,
  type ResultChanges,
  type Result,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import type { RunRecord, RunStore } from "@pi-cmux/core";
import {
  decide,
  policyEvent,
  WORKSPACE_WRITE_PROFILE,
  type PolicyDecision,
  type PolicyProfile,
} from "@pi-cmux/policy";
import {
  readEvents as readWorkerEvents,
  start as startWorker,
  type RunHandle as FakeRunHandle,
} from "@pi-cmux/adapter-fake";
import {
  readEvents as readCodexEvents,
  start as startCodexWorker,
  type RunHandle as CodexRunHandle,
} from "@pi-cmux/adapter-codex";
import {
  readEvents as readClaudeEvents,
  start as startClaudeWorker,
  type RunHandle as ClaudeRunHandle,
} from "@pi-cmux/adapter-claude";
import {
  readEvents as readCursorEvents,
  start as startCursorWorker,
  type RunHandle as CursorRunHandle,
} from "@pi-cmux/adapter-cursor";
import {
  readEvents as readAntigravityEvents,
  start as startAntigravityWorker,
  type RunHandle as AntigravityRunHandle,
} from "@pi-cmux/adapter-antigravity";
import type { ProcessOutcome } from "@pi-cmux/process-supervisor";
import type { SandboxPlacement, SandboxRegistry } from "@pi-cmux/sandbox";
import type { WorktreeManager } from "@pi-cmux/worktrees";

import { processOwner } from "./daemon-lock.ts";
import type { RepositoryRegistry } from "./repositories.ts";

type RunHandle =
  | FakeRunHandle
  | CodexRunHandle
  | ClaudeRunHandle
  | CursorRunHandle
  | AntigravityRunHandle;

type WorkerStartArgs = Parameters<typeof startWorker>[0];
type WorkerStartOptions = Readonly<{
  workerArgs?: readonly string[];
  logger?: Logger;
}>;

type WorkerBatch = Readonly<{
  events: readonly AgentEvent[];
  results: readonly AgentResult[];
  rejected: number;
  offset: number;
}>;

async function readSelectedWorkerEvents(
  task: AgentTask,
  runId: string,
  stdoutPath: string,
  offset: number,
): Promise<Result<WorkerBatch, AgentdError>> {
  const options = { atEof: true, taskId: task.taskId, runId };
  switch (task.worker.kind) {
    case "codex":
      return await readCodexEvents(stdoutPath, offset, options);
    case "claude":
      return await readClaudeEvents(stdoutPath, offset, options);
    case "cursor":
      return await readCursorEvents(stdoutPath, offset, options);
    case "antigravity":
      return await readAntigravityEvents(stdoutPath, offset, options);
    case "fake":
      return await readWorkerEvents(stdoutPath, offset, { atEof: true });
  }
}

async function startSelectedWorker(
  task: AgentTask,
  args: WorkerStartArgs,
  options: WorkerStartOptions,
): Promise<Result<RunHandle, AgentdError>> {
  const adapterOptions =
    options.logger === undefined ? {} : { logger: options.logger };
  switch (task.worker.kind) {
    case "codex":
      return await startCodexWorker(args, adapterOptions);
    case "claude":
      return await startClaudeWorker(args, adapterOptions);
    case "cursor":
      return await startCursorWorker(args, adapterOptions);
    case "antigravity":
      return await startAntigravityWorker(args, adapterOptions);
    case "fake":
      return await startWorker(args, options);
  }
}

export type OrchestratorOptions = Readonly<{
  store: RunStore;
  /** The repositories this daemon is configured to touch. */
  repositories: RepositoryRegistry;
  worktrees: WorktreeManager;
  sandbox: SandboxRegistry;
  logger?: Logger;
  now?: () => Date;
  /** Flags for the fake worker; how a test selects a failure mode. */
  workerArgs?: readonly string[];
  /**
   * Overrides the phase profile. The default allows writes — P2's worktree and
   * containment machinery is what earns that — but not commits or network.
   */
  policyProfile?: PolicyProfile;
}>;

type PreparedWorkspace = Readonly<{
  worktreePath: string;
  placement: SandboxPlacement;
}>;

export class Orchestrator {
  readonly #store: RunStore;
  readonly #repositories: RepositoryRegistry;
  readonly #worktrees: WorktreeManager;
  readonly #sandbox: SandboxRegistry;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #workerArgs: readonly string[];
  readonly #profileOverride: PolicyProfile | undefined;

  /** Live worker handles, by run. Empty after a restart — that is the point. */
  readonly #running = new Map<string, RunHandle>();

  /**
   * In-flight finalisations, by run.
   *
   * A worker exiting and a run *reaching a durable outcome* are two different
   * moments, and everything between them — draining stdout, observing the
   * worktree, writing the result, transitioning state — happens after the
   * process is already gone. Anything that waits only on the process therefore
   * waits on the wrong thing: it would return while the run is still being
   * written, and a shutdown at that moment leaves a non-terminal run that the
   * next boot can only classify as ORPHANED.
   *
   * So the finalisation is tracked as a promise, not left as a bare `void`
   * chain, and `cancelRun` and `shutdown` await it.
   */
  readonly #finalizing = new Map<string, Promise<void>>();

  /** Starts admitted before shutdown set its gate, but not settled yet. */
  readonly #starting = new Set<Promise<Result<RunRecord, AgentdError>>>();
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;

  /** Probed once: whether any provider can enforce `sandbox: "required"`. */
  #isolationAvailable: boolean | undefined;

  public constructor(options: OrchestratorOptions) {
    this.#store = options.store;
    this.#repositories = options.repositories;
    this.#worktrees = options.worktrees;
    this.#sandbox = options.sandbox;
    this.#logger = (options.logger ?? nullLogger).child({
      component: "orchestrator",
    });
    this.#now = options.now ?? ((): Date => new Date());
    this.#workerArgs = options.workerArgs ?? ["--emit", "3"];
    this.#profileOverride = options.policyProfile;
  }

  public get store(): RunStore {
    return this.#store;
  }

  public get worktrees(): WorktreeManager {
    return this.#worktrees;
  }

  /**
   * The profile in force, with `sandboxAvailable` answered by probing rather
   * than declared. A profile that claims isolation the host cannot provide
   * would admit tasks that must be refused.
   */
  async #profile(): Promise<PolicyProfile> {
    if (this.#profileOverride !== undefined) return this.#profileOverride;
    this.#isolationAvailable ??= await this.#sandbox.canEnforceIsolation();
    return {
      ...WORKSPACE_WRITE_PROFILE,
      sandboxAvailable: this.#isolationAvailable,
    };
  }

  /**
   * Admission: the repository allowlist, then the policy engine.
   *
   * The allowlist is checked first and reported as a policy denial so it lands
   * on the same audit event as every other refusal. A caller cannot tell from
   * the outcome whether it was denied for naming an unknown repository or for
   * asking too much of a known one, and both are equally recorded.
   */
  async #admit(task: AgentTask): Promise<Result<PolicyDecision, AgentdError>> {
    const repository = this.#repositories.resolve(task.workspace.repoId);
    if (!repository.ok) return repository;
    return await decide(task, await this.#profile());
  }

  /**
   * Validate, judge and persist a task.
   *
   * The policy decision is written to the event log as the run's first record,
   * so an allowed run and a denied one are equally auditable — a denial that
   * left no trace would be indistinguishable from a request never made.
   */
  public async createTask(
    input: unknown,
  ): Promise<Result<RunRecord, AgentdError>> {
    const parsed = parseAgentTask(input);
    if (!parsed.ok) return parsed;
    const task: AgentTask = parsed.value;

    const decision = await this.#admit(task);

    const created = await this.#store.create(task);
    if (!created.ok) return created;
    const record = created.value;

    const audit = policyEvent(
      task.taskId,
      record.runId,
      0,
      this.#now().toISOString(),
      decision,
    );
    const appended = await this.#store.appendEvents(record.runId, [audit]);
    if (!appended.ok) return appended;

    // The audit record occupies sequence 0, so worker events start at 1.
    const marked = await this.#store.updateMetadata(record.runId, {
      lastSequence: 0,
    });
    if (!marked.ok) return marked;

    if (!decision.ok) {
      // A denied task still gets a durable run: the audit trail is the point.
      // It moves straight to FAILED with the denial as its terminal result.
      const failed = await this.#store.transitionState(record.runId, "FAILED");
      if (!failed.ok) return failed;

      const result = this.#denialResult(task, record.runId, decision.error);
      const written = await this.#store.writeResult(record.runId, result);
      if (!written.ok) return written;

      this.#logger.warn("task denied by policy", {
        runId: record.runId,
        taskId: task.taskId,
        rule: decision.error.details?.["rule"],
      });

      return ok({ ...record, state: "FAILED" });
    }

    this.#logger.info("task admitted", {
      runId: record.runId,
      taskId: task.taskId,
    });
    return ok(record);
  }

  #denialResult(
    task: AgentTask,
    runId: string,
    error: AgentdError,
  ): AgentResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      taskId: task.taskId,
      runId,
      status: "blocked",
      summary: "the task was denied by policy before any worker was launched",
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes: { worktreePath: task.workspace.worktreePath, dirty: false },
      warnings: [],
      failure: {
        code: error.code,
        safeMessage: error.safeMessage,
        retryable: error.retryable,
      },
    };
  }

  /**
   * Launch the worker for an admitted run.
   *
   * Preparation has an order, and it is the order of decreasing reversibility:
   * the repository is resolved, the worktree is claimed and created, the
   * sandbox placement is computed, and only then does a process exist. Every
   * step before the last can fail without anything having run.
   *
   * The pid and its start time are persisted **before** the run is marked
   * RUNNING, so a crash in between leaves a record recovery can check rather
   * than a running process nothing knows about.
   */
  public startRun(runId: string): Promise<Result<RunRecord, AgentdError>> {
    if (this.#shuttingDown) {
      return Promise.resolve(
        err(
          makeError(
            "DAEMON_SHUTTING_DOWN",
            "the daemon is shutting down and is not accepting new runs",
          ),
        ),
      );
    }

    const starting = this.#startWithLock(runId);
    this.#starting.add(starting);
    void starting.then(
      () => this.#starting.delete(starting),
      () => this.#starting.delete(starting),
    );
    return starting;
  }

  async #startWithLock(runId: string): Promise<Result<RunRecord, AgentdError>> {
    // Exclusive from before the first read. `transitionState` is a read
    // followed by a replace, so without this two concurrent `task.start` calls
    // can both observe QUEUED, both write PREPARING, and both spawn a worker
    // into the same stdout and result files — with only one of the two handles
    // surviving in `#running` to be cancelled.
    //
    // `acquireLock` is `O_EXCL`, so the claim itself is atomic: the loser is
    // told RUN_LOCKED rather than silently queued behind the winner.
    const locked = await this.#store.acquireLock(runId, processOwner());
    if (!locked.ok) return locked;

    let keepLock = false;
    try {
      const started = await this.#startLocked(runId);
      keepLock = started.ok;
      return started;
    } finally {
      // The lock outlives this call in exactly one case: a worker is now
      // running under it, and finalisation releases it once the run is durably
      // terminal. `finally` also covers an unexpected exception in a launch
      // dependency; a programmer defect must not strand operational state.
      if (!keepLock) {
        const released = await this.#store.releaseLock(runId);
        if (!released.ok) {
          this.#logger.error("could not release a failed run start's lock", {
            runId,
            code: released.error.code,
          });
        }
      }
    }
  }

  async #startLocked(runId: string): Promise<Result<RunRecord, AgentdError>> {
    const task = await this.#store.readTask(runId);
    if (!task.ok) return task;

    const preparing = await this.#store.transitionState(runId, "PREPARING");
    if (!preparing.ok) return preparing;

    const workspace = await this.#prepareWorkspace(runId, task.value);
    if (!workspace.ok) {
      await this.#failBeforeLaunch(runId, task.value, workspace.error);
      return workspace;
    }

    const directory = this.#store.runDirectory(runId);
    const handle = await startSelectedWorker(
      task.value,
      {
        task: task.value,
        runId,
        stdoutPath: path.join(directory, "stdout.ndjson"),
        stderrPath: path.join(directory, "stderr.log"),
        // The worker's working directory is its worktree, not the run store.
        cwd: workspace.value.placement.cwd,
        env: workspace.value.placement.env,
        argvPrefix: workspace.value.placement.argvPrefix,
      },
      { workerArgs: this.#workerArgs, logger: this.#logger },
    );

    if (!handle.ok) {
      await this.#failBeforeLaunch(runId, task.value, handle.error);
      return handle;
    }

    const metadata = await this.#store.updateMetadata(runId, {
      pid: handle.value.pid,
      processStartedAtMs: handle.value.startedAtMs,
    });
    if (!metadata.ok) {
      return await this.#abandonLaunch(
        runId,
        task.value,
        handle.value,
        metadata.error,
      );
    }

    const running = await this.#store.transitionState(runId, "RUNNING");
    if (!running.ok) {
      return await this.#abandonLaunch(
        runId,
        task.value,
        handle.value,
        running.error,
      );
    }

    this.#running.set(runId, handle.value);

    // Started here, awaited elsewhere. `startRun` must return as soon as the
    // run is RUNNING — a caller asking to start a task is not asking to wait
    // for it — but the daemon still owes this run a terminal state, so the
    // promise is retained rather than dropped. See `#finalizing`.
    const finished = (async (): Promise<void> => {
      try {
        const outcome = await handle.value.completed;
        await this.#finalize(runId, task.value, outcome);
      } catch (error: unknown) {
        this.#logger.error("run finalisation failed", { runId, error });
      } finally {
        this.#finalizing.delete(runId);
        // Released last, *after* the terminal transition, because the lock
        // guards mutation and that transition is the run's final mutation.
        //
        // The consequence is that a terminal state does not by itself imply an
        // unlocked run: an observer polling for SUCCEEDED can win the race to
        // look. Nothing in the daemon depends on the reverse — a terminal run
        // is never started again — and boot recovery clears leftover locks, so
        // the alternative ordering would trade a harmless gap for a real one
        // where a crash could leave an unlocked run still mid-flight.
        const released = await this.#store.releaseLock(runId);
        if (!released.ok) {
          this.#logger.error("could not release a finalized run's lock", {
            runId,
            code: released.error.code,
          });
        }
      }
    })();
    this.#finalizing.set(runId, finished);

    return ok(running.value);
  }

  /**
   * Resolve the repository, create the worktree, and place the worker.
   *
   * The worktree is created **before** the worker exists and its ownership
   * record is durable before the directory is: a crash anywhere in here leaves
   * a claim an operator can act on, never a directory nobody owns.
   *
   * The sandbox is consulted last and can still refuse — a write surface that
   * reaches host credentials, or network the provider cannot restrict. A
   * refusal at this point is the task's refusal; there is no second provider to
   * ask and no host fallback.
   */
  async #prepareWorkspace(
    runId: string,
    task: AgentTask,
  ): Promise<Result<PreparedWorkspace, AgentdError>> {
    const repoPath = this.#repositories.resolve(task.workspace.repoId);
    if (!repoPath.ok) return repoPath;

    const provisioned = await this.#worktrees.provision({
      runId,
      taskId: task.taskId,
      repoId: task.workspace.repoId,
      repoPath: repoPath.value,
      worktreePath: task.workspace.worktreePath,
      baseRef: task.workspace.baseRef,
      // A branch only for a task allowed to commit. Otherwise HEAD stays
      // detached, so an unauthorised commit cannot be mistaken for a handoff.
      createBranch: task.constraints.mayCommit,
    });
    if (!provisioned.ok) return provisioned;

    const placement = await this.#sandbox.prepare(task.constraints.sandbox, {
      runId,
      taskId: task.taskId,
      worktreePath: provisioned.value.path,
      allowedPaths: task.constraints.allowedPaths,
      network: task.constraints.network,
      networkAllowlist: task.constraints.networkAllowlist,
    });
    if (!placement.ok) return placement;

    return ok({
      worktreePath: provisioned.value.path,
      placement: placement.value,
    });
  }

  /**
   * Fail a run that never got as far as a process.
   *
   * The worktree is removed outright here, which is safe precisely because
   * nothing ran: there is no work in it to lose. Release proves ownership
   * before deleting anything, so a failure that happened *before* the claim
   * simply reports that there was nothing to release.
   */
  async #failBeforeLaunch(
    runId: string,
    task: AgentTask,
    error: AgentdError,
  ): Promise<void> {
    const released = await this.#worktrees.release({
      runId,
      worktreePath: task.workspace.worktreePath,
      remove: true,
    });
    if (!released.ok && released.error.code !== "WORKTREE_OWNERSHIP_UNPROVEN") {
      this.#logger.error("could not release the worktree after a failure", {
        runId,
        code: released.error.code,
      });
    }

    // Result before terminal state, as everywhere else. See `#terminate`.
    await this.#store.writeResult(
      runId,
      this.#failureResult(task, runId, error, "failed", {
        worktreePath: task.workspace.worktreePath,
        dirty: false,
      }),
    );
    await this.#store.transitionState(runId, "FAILED");
  }

  /**
   * Stop a worker the daemon failed to record.
   *
   * This is the one launch failure where a process already exists that nothing
   * is tracking: the pid could not be persisted, or the run could not be moved
   * to RUNNING, so neither this daemon nor a later recovery pass has any record
   * to attribute the process to. Killing it first is therefore the priority —
   * an unrecorded worker is precisely the "untracked process" the launch order
   * exists to prevent.
   *
   * Unlike `#failBeforeLaunch` the worktree is kept: something did execute.
   */
  async #abandonLaunch(
    runId: string,
    task: AgentTask,
    handle: RunHandle,
    error: AgentdError,
  ): Promise<Result<RunRecord, AgentdError>> {
    this.#logger.error("could not record a launched worker; stopping it", {
      runId,
      code: error.code,
    });

    handle.cancel();
    await handle.completed;

    const { changes } = await this.#closeWorkspace(runId, task);
    await this.#store.writeResult(
      runId,
      this.#failureResult(task, runId, error, "failed", changes),
    );
    await this.#store.transitionState(runId, "FAILED");

    return err(error);
  }

  /**
   * Close the workspace and report what is actually in it.
   *
   * The files are **kept**. CLAUDE.md requires cleanup to be explicit, and a
   * run that just failed is exactly the one whose worktree an operator wants to
   * look at. Release records the final HEAD and dirty state either way, so the
   * result describes what `agentd` observed rather than what the worker claimed.
   */
  async #closeWorkspace(
    runId: string,
    task: AgentTask,
  ): Promise<Readonly<{ changes: ResultChanges; observed: boolean }>> {
    const released = await this.#worktrees.release({
      runId,
      worktreePath: task.workspace.worktreePath,
      remove: false,
    });

    if (!released.ok || released.value.status === undefined) {
      this.#logger.warn("could not observe the worktree at completion", {
        runId,
        code: released.ok ? "no-status" : released.error.code,
      });
      return {
        changes: {
          worktreePath: task.workspace.worktreePath,
          dirty: false,
        },
        observed: false,
      };
    }

    return {
      changes: {
        worktreePath: released.value.record.worktreePath,
        headSha: released.value.status.headSha,
        dirty: released.value.status.dirty,
      },
      observed: true,
    };
  }

  /**
   * Append worker events to the run's log, re-stamping identity and ordering.
   *
   * A worker numbers its own events from zero and knows only the identifiers it
   * was given. The daemon owns both: `agentd` has already written the policy
   * decision at sequence 0, and a second event claiming sequence 0 is a
   * `SEQUENCE_CONFLICT` that would abort the whole batch.
   *
   * So the worker contributes the *facts* — type, timestamp, payload — and the
   * daemon supplies the *record*: which run this is, which task, and where it
   * sits in the run's single ordered history. Arrival order is preserved
   * exactly; nothing is sorted.
   *
   * Re-ingestion stays safe because `stdoutOffset` advances with it: the same
   * bytes are never read twice, so the same facts are never renumbered twice.
   */
  async #ingest(
    runId: string,
    task: AgentTask,
    events: readonly AgentEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    const metadata = await this.#store.readMetadata(runId);
    if (!metadata.ok) return;

    let sequence = metadata.value.lastSequence;
    const stamped: AgentEvent[] = events.map((event) => {
      sequence += 1;
      return {
        protocolVersion: PROTOCOL_VERSION,
        taskId: task.taskId,
        runId,
        sequence,
        timestamp: event.timestamp,
        type: event.type,
        payload: event.payload,
      };
    });

    const appended = await this.#store.appendEvents(runId, stamped);
    if (!appended.ok) {
      this.#logger.error("could not append worker events", {
        runId,
        code: appended.error.code,
      });
      return;
    }

    await this.#store.updateMetadata(runId, { lastSequence: sequence });
  }

  /** Drain the worker's output, record a result, reach a terminal state. */
  async #finalize(
    runId: string,
    task: AgentTask,
    outcome: ProcessOutcome,
  ): Promise<void> {
    this.#running.delete(runId);

    const directory = this.#store.runDirectory(runId);
    const metadata = await this.#store.readMetadata(runId);
    const offset = metadata.ok ? metadata.value.stdoutOffset : 0;

    // The worker has exited, so the trailing fragment may now be taken.
    const batch = await readSelectedWorkerEvents(
      task,
      runId,
      path.join(directory, "stdout.ndjson"),
      offset,
    );

    if (batch.ok) {
      await this.#ingest(runId, task, batch.value.events);
      await this.#store.updateMetadata(runId, {
        stdoutOffset: batch.value.offset,
      });
    }

    const current = await this.#store.readState(runId);
    if (!current.ok) return;

    // The worker has exited, so this is the last moment the worktree reflects
    // what the run did. Observed once, and reused by every terminal path below.
    const workspace = await this.#closeWorkspace(runId, task);
    const { changes } = workspace;

    // Cancellation and timeouts are terminal directly. A clean exit is not:
    // it only earns the right to be validated.
    if (outcome.reason === "cancelled") {
      await this.#terminate(
        runId,
        task,
        "CANCELLED",
        "cancelled",
        "CANCELLED",
        changes,
      );
      return;
    }
    if (outcome.reason === "timed_out") {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "timed_out",
        "TIMEOUT_HARD",
        changes,
      );
      return;
    }
    if (outcome.reason === "output_limit") {
      // Which stream overflowed is the difference between "the worker talked
      // too much in protocol" and "the worker was crash-looping into stderr",
      // so it is recorded rather than flattened into one opaque limit.
      this.#logger.warn("run exceeded its output budget", {
        runId,
        stream: outcome.outputLimitStream ?? "unknown",
        stdoutBytes: outcome.stdoutBytes,
        stderrBytes: outcome.stderrBytes,
      });
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "OUTPUT_LIMIT_EXCEEDED",
        changes,
        outcome.outputLimitStream === undefined
          ? []
          : [`the ${outcome.outputLimitStream} budget was exhausted`],
      );
      return;
    }
    if (outcome.reason === "output_error") {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "STORE_IO_FAILED",
        changes,
      );
      return;
    }
    if (outcome.exitCode !== 0) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "WORKER_EXITED_NONZERO",
        changes,
      );
      return;
    }

    const validating = await this.#store.transitionState(runId, "VALIDATING");
    if (!validating.ok) return;

    // What a zero exit code establishes is that the process ended tidily. It
    // says nothing about whether the *work* finished, and CLAUDE.md is explicit
    // that a worker's claim of success is not proof of it. So success has to be
    // read from the AgentResult the worker actually produced.
    // A line the parser rejected means part of the stream is unreadable, so
    // any conclusion drawn from the rest is drawn from an incomplete record.
    if (!batch.ok || batch.value.rejected > 0) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "MALFORMED_WORKER_OUTPUT",
        changes,
      );
      return;
    }

    const terminal = batch.value.results;

    if (terminal.length === 0) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "MISSING_TERMINAL_RESULT",
        changes,
      );
      return;
    }

    if (terminal.length > 1) {
      // "A worker may emit progress but only one terminal AgentResult is
      // accepted." Two terminal markers make the run's outcome ambiguous, and
      // picking one would be inventing the answer.
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "DUPLICATE_TERMINAL_RESULT",
        changes,
      );
      return;
    }

    const workerResult = terminal.at(0);
    if (workerResult === undefined) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "MALFORMED_WORKER_OUTPUT",
        changes,
      );
      return;
    }
    if (workerResult.taskId !== task.taskId || workerResult.runId !== runId) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "MALFORMED_WORKER_OUTPUT",
        changes,
      );
      return;
    }

    const state = workerResult.status === "succeeded" ? "SUCCEEDED" : "FAILED";

    // Preserve the worker's claims, but replace fields only agentd can observe.
    await this.#store.writeResult(runId, {
      ...workerResult,
      exitCode: outcome.exitCode,
      changes,
      warnings: [
        ...workerResult.warnings,
        ...(outcome.softTimeoutElapsed ? ["soft timeout elapsed"] : []),
        // Success with an unobservable worktree is still success, but the
        // change summary is then a default rather than an observation, and
        // saying so is cheaper than someone later assuming otherwise.
        ...(workspace.observed
          ? []
          : ["the worktree could not be inspected at completion"]),
      ],
    });
    await this.#store.transitionState(runId, state);
  }

  /**
   * Record the outcome, then commit to it.
   *
   * The result is written **before** the state becomes terminal. A terminal
   * state is a promise that the run's outcome is knowable, so anything it
   * promises must already be on disk — otherwise an observer that polls status
   * and then reads the result finds a finished run with nothing to show.
   *
   * The opposite ordering fails safely: a crash between the two leaves a
   * non-terminal run with a result already written, which recovery orphans and
   * an operator can resolve. A terminal run with no result cannot be resolved
   * by anyone.
   */
  async #terminate(
    runId: string,
    task: AgentTask,
    state: "FAILED" | "CANCELLED",
    status: AgentResult["status"],
    code: AgentdError["code"],
    changes: ResultChanges,
    warnings: readonly string[] = [],
  ): Promise<void> {
    await this.#store.writeResult(
      runId,
      this.#failureResult(
        task,
        runId,
        makeError(code, `the run ended: ${code}`),
        status,
        changes,
        warnings,
      ),
    );
    await this.#store.transitionState(runId, state);
  }

  #failureResult(
    task: AgentTask,
    runId: string,
    error: AgentdError,
    status: AgentResult["status"],
    changes: ResultChanges,
    warnings: readonly string[] = [],
  ): AgentResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      taskId: task.taskId,
      runId,
      status,
      summary: error.safeMessage,
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes,
      warnings: [...warnings],
      failure: {
        code: error.code,
        safeMessage: error.safeMessage,
        retryable: error.retryable,
      },
    };
  }

  public async cancelRun(
    runId: string,
  ): Promise<Result<RunRecord, AgentdError>> {
    const handle = this.#running.get(runId);
    if (handle === undefined) {
      // Not live here. It may belong to a previous daemon incarnation, in
      // which case recovery has already marked it ORPHANED.
      const current = await this.#store.readState(runId);
      if (!current.ok) return current;
      return err(
        makeError("RUN_NOT_FOUND", "this daemon is not supervising that run", {
          details: { runId, state: current.value.state },
        }),
      );
    }

    // Captured before the await: the finalisation removes itself from the map
    // when it completes, so looking it up afterwards could miss it entirely.
    const finished = this.#finalizing.get(runId);

    handle.cancel();
    await handle.completed;

    // The process has exited, but the run has not yet been recorded as
    // cancelled. Returning here would hand the caller a state that still says
    // RUNNING for a cancel it just successfully requested.
    if (finished !== undefined) await finished;

    return await this.#store.readState(runId);
  }

  public async status(runId: string): Promise<Result<RunRecord, AgentdError>> {
    return await this.#store.readState(runId);
  }

  public async result(
    runId: string,
  ): Promise<Result<AgentResult, AgentdError>> {
    return await this.#store.readResult(runId);
  }

  public async events(
    runId: string,
    sinceSequence = -1,
    limit = DEFAULT_EVENT_PAGE_SIZE,
  ): Promise<Result<AgentEvent[], AgentdError>> {
    return await this.#store.readEvents(runId, sinceSequence, limit);
  }

  /**
   * Stop supervising, leaving every run this daemon owns durably terminal.
   *
   * Cancelling is not enough. A worker that has exited still has a result to
   * write, and a daemon that exits at that moment turns its own clean shutdown
   * into an indeterminate outcome: the next boot finds a dead pid under a
   * non-terminal run and can only mark it ORPHANED. So the finalisations are
   * awaited, not just the processes — CLAUDE.md requires cancellation to
   * produce a durable terminal state, and an intentional shutdown is the one
   * case where there is no excuse for failing to.
   *
   * Cancellation is signalled to every run first and awaited collectively, so
   * shutdown costs one termination grace period rather than one per run.
   */
  public async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      await this.#shutdownPromise;
      return;
    }
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#drain();
    await this.#shutdownPromise;
  }

  async #drain(): Promise<void> {
    await Promise.allSettled([...this.#starting]);
    const pending = [...this.#finalizing.values()];

    for (const [runId, handle] of this.#running) {
      this.#logger.warn("daemon shutting down with a live run", { runId });
      handle.cancel();
    }

    // Each finalisation begins by awaiting its own worker, so this covers both
    // the process exits and the durable writes that follow them.
    await Promise.all(pending);

    this.#running.clear();
    this.#finalizing.clear();
  }

  public liveRunIds(): readonly string[] {
    return [...this.#running.keys()];
  }
}
