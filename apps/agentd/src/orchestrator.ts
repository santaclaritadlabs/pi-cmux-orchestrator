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
  type RunHandle,
} from "@pi-cmux/adapter-fake";
import type { ProcessOutcome } from "@pi-cmux/process-supervisor";
import type { SandboxPlacement, SandboxRegistry } from "@pi-cmux/sandbox";
import type { WorktreeManager } from "@pi-cmux/worktrees";

import type { RepositoryRegistry } from "./repositories.ts";

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
  public async startRun(
    runId: string,
  ): Promise<Result<RunRecord, AgentdError>> {
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
    const handle = await startWorker(
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
    if (!metadata.ok) return metadata;

    const running = await this.#store.transitionState(runId, "RUNNING");
    if (!running.ok) return running;

    this.#running.set(runId, handle.value);
    // Fire-and-forget is deliberate and must never be silent: the completion
    // handler is the only thing that produces a terminal state.
    void handle.value.completed
      .then(async (outcome) => {
        await this.#finalize(runId, task.value, outcome);
      })
      .catch((error: unknown) => {
        this.#logger.error("run finalisation failed", { runId, error });
      });

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
    const batch = await readWorkerEvents(
      path.join(directory, "stdout.ndjson"),
      offset,
      { atEof: true },
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
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "OUTPUT_LIMIT_EXCEEDED",
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

    // P1's validation: the stream must contain at least one event, and the
    // worker must not have ended mid-record. A richer check arrives with the
    // real adapters; what matters now is that *something* is checked.
    const events = await this.#store.readEvents(runId);
    const usable = events.ok && events.value.length > 0;
    const clean = batch.ok && batch.value.rejected === 0;

    if (!usable || !clean) {
      await this.#terminate(
        runId,
        task,
        "FAILED",
        "failed",
        "MISSING_TERMINAL_EVENT",
        changes,
      );
      return;
    }

    // Result first, then the terminal state. See `#terminate`.
    await this.#store.writeResult(runId, {
      protocolVersion: PROTOCOL_VERSION,
      taskId: task.taskId,
      runId,
      status: "succeeded",
      summary: `worker completed with ${String(events.value.length)} events`,
      exitCode: outcome.exitCode,
      findings: [],
      tests: [],
      changedFiles: [],
      artifacts: [],
      changes,
      warnings: [
        ...(outcome.softTimeoutElapsed ? ["soft timeout elapsed"] : []),
        // Success with an unobservable worktree is still success, but the
        // change summary is then a default rather than an observation, and
        // saying so is cheaper than someone later assuming otherwise.
        ...(workspace.observed
          ? []
          : ["the worktree could not be inspected at completion"]),
      ],
    });
    await this.#store.transitionState(runId, "SUCCEEDED");
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
  ): Promise<void> {
    await this.#store.writeResult(
      runId,
      this.#failureResult(
        task,
        runId,
        makeError(code, `the run ended: ${code}`),
        status,
        changes,
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
      warnings: [],
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

    handle.cancel();
    await handle.completed;
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
  ): Promise<Result<AgentEvent[], AgentdError>> {
    return await this.#store.readEvents(runId, sinceSequence);
  }

  /** Stop supervising, without pretending the workers stopped too. */
  public async shutdown(): Promise<void> {
    for (const [runId, handle] of this.#running) {
      this.#logger.warn("daemon shutting down with a live run", { runId });
      handle.cancel();
      await handle.completed;
    }
    this.#running.clear();
  }

  public liveRunIds(): readonly string[] {
    return [...this.#running.keys()];
  }
}
