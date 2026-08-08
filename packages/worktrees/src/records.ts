/**
 * Worktree ownership records.
 *
 * A record is written **before** `git worktree add` runs and kept **after** the
 * worktree is removed. Both halves are deliberate:
 *
 *   - writing first means a crash mid-creation leaves evidence that something
 *     may exist on disk. The opposite order leaves a directory nothing claims,
 *     which cleanup is then forbidden to touch — an unprovable worktree is
 *     permanent litter;
 *   - keeping the record after removal is the cleanup record CLAUDE.md asks
 *     for. A deleted record cannot answer "what happened to that worktree?".
 *
 * The record file is also the **claim**. It is created with `O_EXCL` under a
 * name derived from the canonical worktree path, so two runs racing for the
 * same directory resolve in the kernel rather than in a check-then-act window.
 * Spec §12: two writers never share a working directory.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
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
import { atomicWriteFile, writeFileExclusive } from "@pi-cmux/core";
import { z } from "zod";

const worktreeRecordSchema = z
  .strictObject({
    recordVersion: z.literal(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    repoId: z.string().min(1),
    /** Canonical work tree root of the repository the worktree belongs to. */
    repoPath: z.string().min(1),
    worktreePath: z.string().min(1),
    baseRef: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().min(1).optional(),
    claimedAt: z.string().min(1),
    /** Set once `git worktree add` has succeeded. */
    createdAt: z.string().min(1).optional(),
    initialHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    releasedAt: z.string().min(1).optional(),
    finalHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    dirtyAtRelease: z.boolean().optional(),
    changedFileCount: z.int().nonnegative().optional(),
  })
  .readonly();

export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;

/**
 * Where a record lives.
 *
 * Named by a digest of the canonical path rather than the path itself: paths
 * contain separators and arbitrary bytes, and a filename derived from one is a
 * traversal waiting to happen. The digest is fixed-length and alphanumeric, and
 * the path it stands for is inside the record.
 */
export function recordFileName(canonicalWorktreePath: string): string {
  return `${createHash("sha256")
    .update(canonicalWorktreePath)
    .digest("hex")
    .slice(0, 32)}.json`;
}

export class RecordStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = directory;
  }

  public get directory(): string {
    return this.#directory;
  }

  public pathFor(canonicalWorktreePath: string): string {
    return path.join(this.#directory, recordFileName(canonicalWorktreePath));
  }

  async #ensureDirectory(): Promise<Result<undefined, AgentdError>> {
    return await tryCatchAsync(
      async () => {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        return undefined;
      },
      (cause) =>
        fromThrown(
          "STORE_IO_FAILED",
          "could not create the worktree record directory",
          cause,
        ),
    );
  }

  /**
   * Stake an exclusive claim, or report the conflict.
   *
   * `O_EXCL` is the whole mechanism: the file either did not exist and is now
   * ours, or it existed and belongs to someone else. There is no window in
   * between for a second caller to slip through.
   */
  public async claim(
    record: WorktreeRecord,
  ): Promise<Result<WorktreeRecord, AgentdError>> {
    const prepared = await this.#ensureDirectory();
    if (!prepared.ok) return prepared;

    const file = this.pathFor(record.worktreePath);
    const written = await writeFileExclusive(
      file,
      `${JSON.stringify(record, null, 2)}\n`,
    );

    if (!written.ok) {
      const existing = await this.read(record.worktreePath);
      return err(
        makeError(
          "WORKTREE_CONFLICT",
          "the worktree is already claimed by another run",
          {
            details: {
              // The holder's runId is ours to disclose; the path is not echoed.
              heldBy: existing.ok ? existing.value.runId : "unknown",
              released: existing.ok && existing.value.releasedAt !== undefined,
            },
          },
        ),
      );
    }

    return ok(record);
  }

  public async read(
    canonicalWorktreePath: string,
  ): Promise<Result<WorktreeRecord, AgentdError>> {
    const file = this.pathFor(canonicalWorktreePath);

    const raw = await tryCatchAsync(
      async () => await readFile(file, "utf8"),
      (cause) =>
        fromThrown(
          "WORKTREE_OWNERSHIP_UNPROVEN",
          "no ownership record exists for that worktree",
          cause,
        ),
    );
    if (!raw.ok) return raw;

    return parseRecord(raw.value);
  }

  /** Replace a record in place. Used to record creation and release facts. */
  public async update(
    record: WorktreeRecord,
  ): Promise<Result<WorktreeRecord, AgentdError>> {
    const written = await atomicWriteFile(
      this.pathFor(record.worktreePath),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    if (!written.ok) return written;
    return ok(record);
  }

  /**
   * Every record on disk, valid or not.
   *
   * Recovery needs the invalid ones too: a record that does not parse is a
   * worktree whose ownership cannot be proven, which is a condition an operator
   * must see rather than a file to skip past.
   */
  public async list(): Promise<
    Result<
      readonly Readonly<{
        file: string;
        record?: WorktreeRecord;
        error?: AgentdError;
      }>[],
      AgentdError
    >
  > {
    const names = await tryCatchAsync(
      async () => await readdir(this.#directory),
      (cause) =>
        fromThrown("STORE_IO_FAILED", "could not list worktree records", cause),
    );
    // A directory that has never been created holds no records.
    if (!names.ok) return ok([]);

    const entries: {
      file: string;
      record?: WorktreeRecord;
      error?: AgentdError;
    }[] = [];

    for (const name of names.value) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.#directory, name);

      const raw = await tryCatchAsync(
        async () => await readFile(file, "utf8"),
        (cause) =>
          fromThrown("STORE_IO_FAILED", "could not read a record", cause),
      );
      if (!raw.ok) {
        entries.push({ file, error: raw.error });
        continue;
      }

      const parsed = parseRecord(raw.value);
      entries.push(
        parsed.ok
          ? { file, record: parsed.value }
          : { file, error: parsed.error },
      );
    }

    return ok(entries);
  }
}

/** Validate on the way in. On-disk state is never trusted because we wrote it. */
export function parseRecord(raw: string): Result<WorktreeRecord, AgentdError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return err(
      fromThrown("STORE_CORRUPT", "a worktree record is not valid JSON", cause),
    );
  }

  const parsed = worktreeRecordSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(
      makeError("STORE_CORRUPT", "a worktree record failed validation", {
        details: { issues: parsed.error.issues.length },
      }),
    );
  }

  return ok(parsed.data);
}
