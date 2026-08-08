/**
 * The worktree lifecycle.
 *
 * One object owns the whole of it — claim, create, inspect, release — because
 * the ordering between those steps is the safety property, and an ordering
 * spread across call sites is an ordering nobody enforces.
 *
 * The order, and what each step is protecting against:
 *
 *   1. **Contain the path.** A worktree lives under a configured root. A target
 *      outside it is refused before anything touches the filesystem.
 *   2. **Identify the repository.** Not "does this path look like a repo" but
 *      "what does git say this is" — the answer is what ownership is proven
 *      against later.
 *   3. **Audit its configuration.** A repository that executes code on checkout
 *      is refused (`REPO_UNSAFE`), not sanitised.
 *   4. **Pin the base.** The ref is resolved to a SHA *now*, so the run records
 *      what it actually started from rather than what the branch drifted to.
 *   5. **Claim durably.** `O_EXCL`, before creation. Two runs cannot share a
 *      working directory, and a crash leaves evidence rather than an orphan.
 *   6. **Create.** Only now does `git worktree add` run.
 *
 * Release is the mirror image and refuses to act on anything it cannot prove:
 * the record must name the run asking, and git itself must agree the directory
 * is a worktree of the recorded repository. CLAUDE.md: "never delete a worktree
 * whose identity or task ownership cannot be proven."
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  err,
  fromThrown,
  makeError,
  ok,
  tryCatchAsync,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { nullLogger, type Logger } from "@pi-cmux/observability";
import { assertContained, resolveExistingAncestor } from "@pi-cmux/policy";

import { runGit } from "./git.ts";
import { RecordStore, type WorktreeRecord } from "./records.ts";
import {
  describeWorktree,
  identifyRepository,
  inspectRepositoryConfig,
  listWorktreePaths,
  resolveCommit,
  type WorktreeStatus,
} from "./repository.ts";

export type WorktreeManagerOptions = Readonly<{
  /** Every worktree this daemon creates lives under here. */
  root: string;
  /** Ownership records. Defaults to `<root>/.records`, outside any worktree. */
  recordDirectory?: string;
  logger?: Logger;
  now?: () => Date;
  maxChangedFiles?: number;
  gitTimeoutMs?: number;
}>;

export type ProvisionRequest = Readonly<{
  runId: string;
  taskId: string;
  repoId: string;
  /** Any path inside the repository; git resolves it to the work tree root. */
  repoPath: string;
  /** Where the worktree should go. Must be inside the configured root. */
  worktreePath: string;
  baseRef: string;
  /**
   * Create a named branch instead of detaching HEAD. Only for a task allowed to
   * commit — a detached HEAD makes an unauthorised commit hard to mistake for a
   * deliverable.
   */
  createBranch?: boolean;
}>;

export type ProvisionedWorktree = Readonly<{
  /** The canonical path, after symlinks. This is what the worker gets. */
  path: string;
  record: WorktreeRecord;
}>;

export type ReleaseRequest = Readonly<{
  runId: string;
  worktreePath: string;
  /**
   * Remove the directory. `false` records the final state and keeps the files,
   * which is what an operator wants after a failure they intend to inspect.
   */
  remove?: boolean;
}>;

export type ReleasedWorktree = Readonly<{
  record: WorktreeRecord;
  status?: WorktreeStatus;
  removed: boolean;
}>;

/** Same constraints git puts on a ref, applied before we hand it to git. */
const BRANCH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function branchNameFor(
  taskId: string,
  runId: string,
): Result<string, AgentdError> {
  if (!BRANCH_SEGMENT.test(taskId) || !BRANCH_SEGMENT.test(runId)) {
    return err(
      makeError(
        "GIT_COMMAND_FAILED",
        "the task or run identifier cannot be used in a branch name",
      ),
    );
  }
  return ok(`agent/${taskId}/${runId}`);
}

export class WorktreeManager {
  readonly #root: string;
  readonly #records: RecordStore;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #maxChangedFiles: number;
  readonly #gitTimeoutMs: number;

  public constructor(options: WorktreeManagerOptions) {
    this.#root = path.resolve(options.root);
    this.#records = new RecordStore(
      options.recordDirectory ?? path.join(this.#root, ".records"),
    );
    this.#logger = (options.logger ?? nullLogger).child({
      component: "worktrees",
    });
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxChangedFiles = options.maxChangedFiles ?? 10_000;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 60_000;
  }

  public get root(): string {
    return this.#root;
  }

  public get records(): RecordStore {
    return this.#records;
  }

  /**
   * Resolve a requested path to its canonical form and prove it is inside the
   * root.
   *
   * The path usually does not exist yet, which is precisely when a symlinked
   * *parent* would go unnoticed — `assertContained` resolves the nearest
   * existing ancestor for exactly this case.
   */
  async #canonicalise(target: string): Promise<Result<string, AgentdError>> {
    if (!path.isAbsolute(target)) {
      return err(makeError("PATH_ESCAPE", "a worktree path must be absolute"));
    }

    const prepared = await tryCatchAsync(
      async () => {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        return undefined;
      },
      (cause) =>
        fromThrown(
          "STORE_IO_FAILED",
          "could not create the worktree root",
          cause,
        ),
    );
    if (!prepared.ok) return prepared;

    const contained = await assertContained(target, this.#root);
    if (!contained.ok) return contained;

    const canonicalRoot = await resolveExistingAncestor(this.#root);
    if (contained.value === canonicalRoot) {
      return err(
        makeError(
          "PATH_ESCAPE",
          "a worktree cannot be the worktree root itself",
        ),
      );
    }

    return ok(contained.value);
  }

  public async provision(
    request: ProvisionRequest,
  ): Promise<Result<ProvisionedWorktree, AgentdError>> {
    const canonical = await this.#canonicalise(request.worktreePath);
    if (!canonical.ok) return canonical;
    const worktreePath = canonical.value;

    const identity = await identifyRepository(request.repoPath);
    if (!identity.ok) return identity;
    const repoPath = await resolveExistingAncestor(identity.value.topLevel);

    // The primary checkout is read-only from a worker's perspective, and a
    // worktree *inside* it would put a writable tree in the middle of one.
    // Both directions are checked: nesting either way is a containment failure.
    if (
      (await assertContained(worktreePath, repoPath)).ok ||
      (await assertContained(repoPath, worktreePath)).ok
    ) {
      return err(
        makeError(
          "PATH_ESCAPE",
          "a worktree may not be nested with the primary checkout",
        ),
      );
    }

    const audit = await inspectRepositoryConfig(repoPath);
    if (!audit.ok) {
      this.#logger.warn("repository refused by configuration audit", {
        runId: request.runId,
        repoId: request.repoId,
        keys: audit.error.details?.["keys"],
      });
      return audit;
    }

    const baseSha = await resolveCommit(repoPath, request.baseRef);
    if (!baseSha.ok) return baseSha;

    let branch: string | undefined;
    if (request.createBranch === true) {
      const named = branchNameFor(request.taskId, request.runId);
      if (!named.ok) return named;
      branch = named.value;
    }

    const claimed = await this.#records.claim({
      recordVersion: 1,
      runId: request.runId,
      taskId: request.taskId,
      repoId: request.repoId,
      repoPath,
      worktreePath,
      baseRef: request.baseRef,
      baseSha: baseSha.value,
      ...(branch === undefined ? {} : { branch }),
      claimedAt: this.#now().toISOString(),
    });
    if (!claimed.ok) return claimed;

    const parent = await tryCatchAsync(
      async () => {
        await mkdir(path.dirname(worktreePath), {
          recursive: true,
          mode: 0o700,
        });
        return undefined;
      },
      (cause) =>
        fromThrown(
          "STORE_IO_FAILED",
          "could not create the worktree's parent directory",
          cause,
        ),
    );
    if (!parent.ok) return parent;

    const added = await runGit(
      [
        "worktree",
        "add",
        ...(branch === undefined ? ["--detach"] : ["-b", branch]),
        "--",
        worktreePath,
        baseSha.value,
      ],
      { cwd: repoPath, timeoutMs: this.#gitTimeoutMs },
    );
    if (!added.ok) {
      // The claim stays. A record without `createdAt` is the marker that says
      // "this may or may not exist on disk", which is what release needs in
      // order to clean up safely rather than guess.
      this.#logger.error("worktree creation failed", {
        runId: request.runId,
        repoId: request.repoId,
        code: added.error.code,
      });
      return added;
    }

    const status = await describeWorktree(worktreePath, this.#maxChangedFiles);
    if (!status.ok) return status;

    const recorded = await this.#records.update({
      ...claimed.value,
      createdAt: this.#now().toISOString(),
      initialHeadSha: status.value.headSha,
    });
    if (!recorded.ok) return recorded;

    this.#logger.info("worktree provisioned", {
      runId: request.runId,
      repoId: request.repoId,
      baseSha: baseSha.value,
      detached: branch === undefined,
    });

    return ok({ path: worktreePath, record: recorded.value });
  }

  /** Capture a worktree's state without changing anything. */
  public async inspect(
    worktreePath: string,
  ): Promise<Result<WorktreeStatus, AgentdError>> {
    const canonical = await this.#canonicalise(worktreePath);
    if (!canonical.ok) return canonical;
    return await describeWorktree(canonical.value, this.#maxChangedFiles);
  }

  /**
   * Prove that this run owns this worktree.
   *
   * Three independent claims must agree: the record says so, the record was
   * written for this exact canonical path, and git agrees the directory is a
   * worktree of the recorded repository. The third is the one that survives a
   * tampered record directory, and it is why removal consults git rather than
   * trusting our own bookkeeping.
   */
  async #proveOwnership(
    runId: string,
    worktreePath: string,
  ): Promise<Result<WorktreeRecord, AgentdError>> {
    const record = await this.#records.read(worktreePath);
    if (!record.ok) return record;

    if (record.value.runId !== runId) {
      return err(
        makeError(
          "WORKTREE_OWNERSHIP_UNPROVEN",
          "the worktree is recorded against a different run",
          { details: { heldBy: record.value.runId } },
        ),
      );
    }

    if (record.value.worktreePath !== worktreePath) {
      return err(
        makeError(
          "WORKTREE_OWNERSHIP_UNPROVEN",
          "the ownership record does not match the requested path",
        ),
      );
    }

    return ok(record.value);
  }

  public async release(
    request: ReleaseRequest,
  ): Promise<Result<ReleasedWorktree, AgentdError>> {
    const canonical = await this.#canonicalise(request.worktreePath);
    if (!canonical.ok) return canonical;
    const worktreePath = canonical.value;

    const proven = await this.#proveOwnership(request.runId, worktreePath);
    if (!proven.ok) return proven;
    const record = proven.value;

    if (record.releasedAt !== undefined) {
      // Releasing twice is not an error: cleanup must be retryable, and a
      // retry that reports failure is a retry nobody can complete.
      return ok({ record, removed: false });
    }

    // A claim that never became a worktree. Nothing to remove, nothing to
    // capture — but the record is still closed so the claim does not leak.
    if (record.createdAt === undefined) {
      const closed = await this.#records.update({
        ...record,
        releasedAt: this.#now().toISOString(),
      });
      if (!closed.ok) return closed;
      return ok({ record: closed.value, removed: false });
    }

    const known = await listWorktreePaths(record.repoPath);
    if (!known.ok) return known;

    const registered = await this.#anyMatches(known.value, worktreePath);
    if (!registered) {
      return err(
        makeError(
          "WORKTREE_OWNERSHIP_UNPROVEN",
          "git does not know this directory as a worktree of the recorded repository",
        ),
      );
    }

    // Capture before removing: after `worktree remove` there is nothing left to
    // ask, and the final HEAD and dirty state are part of the run's record.
    const status = await describeWorktree(worktreePath, this.#maxChangedFiles);

    let removed = false;
    if (request.remove !== false) {
      const removal = await runGit(
        ["worktree", "remove", "--force", "--", worktreePath],
        { cwd: record.repoPath, timeoutMs: this.#gitTimeoutMs },
      );
      if (!removal.ok) {
        // Leave the record open so the operation can be retried.
        this.#logger.error("worktree removal failed", {
          runId: request.runId,
          code: removal.error.code,
        });
        return removal;
      }

      // `remove` unregisters and deletes; `prune` clears any administrative
      // leftovers from a previous crash in the same repository.
      await runGit(["worktree", "prune"], {
        cwd: record.repoPath,
        timeoutMs: this.#gitTimeoutMs,
      });

      // `git worktree remove` leaves nothing behind when it succeeds, but an
      // empty directory can survive on some filesystems. Removing it is safe
      // *only* here, after ownership has been proven three ways.
      await rm(worktreePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      removed = true;
    }

    const closed = await this.#records.update({
      ...record,
      releasedAt: this.#now().toISOString(),
      ...(status.ok
        ? {
            finalHeadSha: status.value.headSha,
            dirtyAtRelease: status.value.dirty,
            changedFileCount: status.value.changedFiles.length,
          }
        : {}),
    });
    if (!closed.ok) return closed;

    this.#logger.info("worktree released", {
      runId: request.runId,
      removed,
      dirty: status.ok ? status.value.dirty : undefined,
    });

    return ok({
      record: closed.value,
      ...(status.ok ? { status: status.value } : {}),
      removed,
    });
  }

  /** Compare paths through symlinks, since git and we may spell them differently. */
  async #anyMatches(
    candidates: readonly string[],
    target: string,
  ): Promise<boolean> {
    for (const candidate of candidates) {
      if (candidate === target) return true;
      if ((await resolveExistingAncestor(candidate)) === target) return true;
    }
    return false;
  }

  /**
   * Records for worktrees that were claimed and never released.
   *
   * After a daemon restart these are the directories that may still exist with
   * nobody supervising them. They are reported, never reclaimed automatically:
   * a worktree whose run's outcome is unknown may hold the only copy of that
   * run's work.
   */
  public async listUnreleased(): Promise<
    Result<readonly WorktreeRecord[], AgentdError>
  > {
    const entries = await this.#records.list();
    if (!entries.ok) return entries;

    const unreleased: WorktreeRecord[] = [];
    for (const entry of entries.value) {
      if (entry.record === undefined) {
        this.#logger.error("unreadable worktree record", {
          file: path.basename(entry.file),
          code: entry.error?.code,
        });
        continue;
      }
      if (entry.record.releasedAt === undefined) unreleased.push(entry.record);
    }

    return ok(unreleased);
  }
}
