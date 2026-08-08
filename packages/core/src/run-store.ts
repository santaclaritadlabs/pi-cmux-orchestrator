/**
 * Durable run state.
 *
 * Layout (spec §11):
 *
 *     <root>/runs/<runId>/
 *     ├── task.json      the exact task, with its protocol version
 *     ├── state.json     atomically replaced, never written in place
 *     ├── events.ndjson  append-only, idempotent by sequence
 *     ├── result.json    exactly one, terminal
 *     ├── metadata.json  pid, process start time, stream offset
 *     ├── stdout.ndjson  written by the worker itself, via its own fd
 *     ├── stderr.log
 *     ├── run.lock       O_EXCL; proves single ownership
 *     └── artifacts/
 *
 * Three invariants the store exists to hold:
 *
 *   1. **State is durable before it is acted on.** A task is persisted before a
 *      worker is launched, so a crash between the two leaves a recoverable
 *      record rather than an untracked process.
 *   2. **Events are append-only and idempotent.** Re-ingesting a sequence with
 *      identical content is a no-op; re-ingesting one with *different* content
 *      is a `SEQUENCE_CONFLICT`, never a silent overwrite.
 *   3. **Exactly one terminal result.** A second is rejected.
 *
 * Everything read back from disk is re-validated. On-disk state that does not
 * parse is `STORE_CORRUPT` — never silently repaired, because a repaired run
 * record is a fabricated audit trail.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  createRunId,
  encodeJsonLine,
  err,
  fromThrown,
  isRunId,
  makeError,
  ok,
  parseAgentEvent,
  parseAgentResult,
  parseAgentTask,
  tryCatchAsync,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type AgentdError,
  type DeepExactOptional,
  type Expect,
  type MutuallyAssignable,
  type Result,
  type RunState,
  type WorkerKind,
} from "@pi-cmux/protocol";
import { z } from "zod";

import {
  appendAndSync,
  atomicWriteFile,
  writeFileExclusive,
} from "./atomic.ts";
import { INITIAL_RUN_STATE, transition } from "./state-machine.ts";

// --- persisted shapes -----------------------------------------------------

const runRecordSchema = z
  .strictObject({
    runId: z.string(),
    taskId: z.string(),
    state: z.enum([
      "QUEUED",
      "PREPARING",
      "RUNNING",
      "BLOCKED",
      "CANCELLED",
      "FAILED",
      "VALIDATING",
      "SUCCEEDED",
      "ORPHANED",
    ]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .readonly();

export type RunRecord = Readonly<{
  runId: string;
  taskId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
}>;

const runMetadataSchema = z
  .strictObject({
    runId: z.string(),
    workerKind: z.enum(["codex", "claude", "cursor", "antigravity", "fake"]),
    /** Absent until a worker is launched. */
    pid: z.int().positive().optional(),
    /**
     * Wall-clock time the process was observed to start. PIDs are recycled;
     * "is pid 4711 alive?" is not the same question as "is *our* pid 4711
     * alive?", and this is what tells them apart after a restart.
     */
    processStartedAtMs: z.int().nonnegative().optional(),
    /** Bytes of `stdout.ndjson` already normalized into `events.ndjson`. */
    stdoutOffset: z.int().nonnegative(),
    /** Highest sequence written, or -1 when none. */
    lastSequence: z.int().min(-1),
  })
  .readonly();

export type RunMetadata = Readonly<{
  runId: string;
  workerKind: WorkerKind;
  pid?: number;
  processStartedAtMs?: number;
  stdoutOffset: number;
  lastSequence: number;
}>;

type _MetadataMatchesSchema = Expect<
  MutuallyAssignable<
    DeepExactOptional<z.infer<typeof runMetadataSchema>>,
    RunMetadata
  >
>;

// --- file names -----------------------------------------------------------

export const RUN_FILES = {
  task: "task.json",
  state: "state.json",
  events: "events.ndjson",
  result: "result.json",
  metadata: "metadata.json",
  stdout: "stdout.ndjson",
  stderr: "stderr.log",
  lock: "run.lock",
  artifacts: "artifacts",
} as const;

export type RunStoreOptions = Readonly<{
  root: string;
  now?: () => Date;
  newRunId?: () => string;
}>;

/** Canonical hash of an event, for detecting a real sequence conflict. */
function eventFingerprint(event: AgentEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([event.type, event.timestamp, event.payload]))
    .digest("hex");
}

export class RunStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #newRunId: () => string;

  /**
   * Per-run index of `sequence -> fingerprint`, built lazily from disk.
   *
   * Without it, every append would have to re-read the whole log to answer
   * "have I seen this sequence?", which is quadratic in a long run.
   */
  readonly #sequenceIndex = new Map<string, Map<number, string>>();

  public constructor(options: RunStoreOptions) {
    this.#root = options.root;
    this.#now = options.now ?? ((): Date => new Date());
    this.#newRunId = options.newRunId ?? ((): string => createRunId());
  }

  public runsDirectory(): string {
    return path.join(this.#root, "runs");
  }

  public runDirectory(runId: string): string {
    return path.join(this.runsDirectory(), runId);
  }

  public runFile(runId: string, file: keyof typeof RUN_FILES): string {
    return path.join(this.runDirectory(runId), RUN_FILES[file]);
  }

  // --- creation -----------------------------------------------------------

  /**
   * Allocate a run and persist it before anything is launched.
   *
   * Order matters: the directory, then the task, then the metadata, then the
   * state. `state.json` appearing last means a crash mid-create leaves a
   * directory a recovery pass can recognise as incomplete rather than a run
   * claiming to be QUEUED with no task to run.
   */
  public async create(
    task: AgentTask,
  ): Promise<Result<RunRecord, AgentdError>> {
    const runId = this.#newRunId();
    if (!isRunId(runId)) {
      return err(makeError("INTERNAL", "generated an invalid run id"));
    }

    const directory = this.runDirectory(runId);
    const created = await tryCatchAsync(
      async () => {
        // `recursive: false` on the run directory itself: if it already exists
        // we must fail, not adopt someone else's run.
        await mkdir(this.runsDirectory(), { recursive: true, mode: 0o700 });
        await mkdir(directory, { recursive: false, mode: 0o700 });
        await mkdir(path.join(directory, RUN_FILES.artifacts), {
          recursive: false,
          mode: 0o700,
        });
        return undefined;
      },
      (cause) =>
        fromThrown(
          "RUN_ALREADY_EXISTS",
          "run directory already exists",
          cause,
          {
            runId,
          },
        ),
    );
    if (!created.ok) return created;

    const taskWritten = await atomicWriteFile(
      this.runFile(runId, "task"),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    if (!taskWritten.ok) return taskWritten;

    const metadataWritten = await this.writeMetadata(runId, {
      runId,
      workerKind: task.worker.kind,
      stdoutOffset: 0,
      lastSequence: -1,
    });
    if (!metadataWritten.ok) return metadataWritten;

    const timestamp = this.#now().toISOString();
    const record: RunRecord = {
      runId,
      taskId: task.taskId,
      state: INITIAL_RUN_STATE,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const stateWritten = await this.#writeRecord(record);
    if (!stateWritten.ok) return stateWritten;

    return ok(record);
  }

  // --- state --------------------------------------------------------------

  async #writeRecord(
    record: RunRecord,
  ): Promise<Result<undefined, AgentdError>> {
    return await atomicWriteFile(
      this.runFile(record.runId, "state"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  public async readState(
    runId: string,
  ): Promise<Result<RunRecord, AgentdError>> {
    const raw = await this.#readJson(runId, "state", "RUN_NOT_FOUND");
    if (!raw.ok) return raw;

    const parsed = runRecordSchema.safeParse(raw.value);
    if (!parsed.success) {
      return err(
        makeError("STORE_CORRUPT", "state.json did not validate", {
          details: { runId },
          cause: parsed.error,
        }),
      );
    }
    return ok(parsed.data);
  }

  /**
   * Move a run to a new state, refusing transitions the machine forbids.
   *
   * The check happens against the state *on disk*, not a caller-supplied one,
   * so a stale in-memory view cannot drive an illegal transition.
   */
  public async transitionState(
    runId: string,
    to: RunState,
  ): Promise<Result<RunRecord, AgentdError>> {
    const current = await this.readState(runId);
    if (!current.ok) return current;

    const next = transition(current.value.state, to);
    if (!next.ok) return next;

    const record: RunRecord = {
      ...current.value,
      state: next.value,
      updatedAt: this.#now().toISOString(),
    };

    const written = await this.#writeRecord(record);
    if (!written.ok) return written;
    return ok(record);
  }

  // --- task ---------------------------------------------------------------

  public async readTask(
    runId: string,
  ): Promise<Result<AgentTask, AgentdError>> {
    const raw = await this.#readJson(runId, "task", "RUN_NOT_FOUND");
    if (!raw.ok) return raw;

    // Re-validated on read: a task written by an older build must still satisfy
    // today's schema, or the run cannot be safely resumed.
    const parsed = parseAgentTask(raw.value);
    if (!parsed.ok) {
      return err(
        makeError("STORE_CORRUPT", "task.json did not validate", {
          details: { runId, reason: parsed.error.code },
          cause: parsed.error,
        }),
      );
    }
    return parsed;
  }

  // --- events -------------------------------------------------------------

  async #loadSequenceIndex(
    runId: string,
  ): Promise<Result<Map<number, string>, AgentdError>> {
    const cached = this.#sequenceIndex.get(runId);
    if (cached !== undefined) return ok(cached);

    const events = await this.readEvents(runId);
    if (!events.ok) return events;

    const index = new Map<number, string>();
    for (const event of events.value) {
      index.set(event.sequence, eventFingerprint(event));
    }
    this.#sequenceIndex.set(runId, index);
    return ok(index);
  }

  /**
   * Append events, idempotently.
   *
   * Returns the number actually written. A sequence already present with the
   * same content is skipped silently — that is the definition of idempotent
   * ingestion, and it is what lets a recovery pass re-read `stdout.ndjson`
   * from a conservative offset without duplicating records.
   *
   * A sequence present with *different* content is a conflict and aborts the
   * batch. Nothing already appended is rolled back: the log is append-only,
   * and the caller learns exactly where it stopped.
   */
  public async appendEvents(
    runId: string,
    events: readonly AgentEvent[],
  ): Promise<Result<number, AgentdError>> {
    const index = await this.#loadSequenceIndex(runId);
    if (!index.ok) return index;

    let written = 0;

    for (const event of events) {
      const fingerprint = eventFingerprint(event);
      const existing = index.value.get(event.sequence);

      if (existing === fingerprint) continue;

      if (existing !== undefined) {
        return err(
          makeError(
            "SEQUENCE_CONFLICT",
            "two different events claim the same sequence",
            { details: { runId, sequence: event.sequence } },
          ),
        );
      }

      const encoded = encodeJsonLine(event);
      if (!encoded.ok) return encoded;

      const appended = await appendAndSync(
        this.runFile(runId, "events"),
        encoded.value,
      );
      if (!appended.ok) return appended;

      index.value.set(event.sequence, fingerprint);
      written += 1;
    }

    return ok(written);
  }

  /**
   * Read the event log.
   *
   * Records are returned **sorted by sequence**, which is not the same as file
   * order: a worker may emit out of order, and the log preserves arrival order
   * because that is what actually happened. Sorting is the reader's job.
   *
   * A line that does not parse is skipped rather than fatal — a torn final
   * record must not make an entire run unreadable.
   */
  public async readEvents(
    runId: string,
    sinceSequence = -1,
  ): Promise<Result<AgentEvent[], AgentdError>> {
    const raw = await tryCatchAsync(
      async () => await readFile(this.runFile(runId, "events"), "utf8"),
      (cause) => fromThrown("STORE_IO_FAILED", "could not read events", cause),
    );

    if (!raw.ok) {
      // No log yet is not an error: a run that has emitted nothing has none.
      if (isNotFound(raw.error)) return ok([]);
      return raw;
    }

    const events: AgentEvent[] = [];
    for (const line of raw.value.split("\n")) {
      if (line.trim() === "") continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        continue;
      }

      const parsed = parseAgentEvent(decoded);
      if (!parsed.ok) continue;
      if (parsed.value.sequence <= sinceSequence) continue;

      events.push(parsed.value);
    }

    events.sort((a, b) => a.sequence - b.sequence);
    return ok(events);
  }

  // --- result -------------------------------------------------------------

  /**
   * Record the run's single terminal result.
   *
   * A second result is rejected with `DUPLICATE_TERMINAL_RESULT`. The check is
   * a read followed by a write and is therefore not atomic on its own — the run
   * lock is what makes it safe, which is why `result.json` may only be written
   * by the lock holder.
   */
  public async writeResult(
    runId: string,
    result: AgentResult,
  ): Promise<Result<undefined, AgentdError>> {
    const existing = await this.readResult(runId);
    if (existing.ok) {
      return err(
        makeError(
          "DUPLICATE_TERMINAL_RESULT",
          "this run already has a terminal result",
          { details: { runId, existingStatus: existing.value.status } },
        ),
      );
    }

    return await atomicWriteFile(
      this.runFile(runId, "result"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }

  public async readResult(
    runId: string,
  ): Promise<Result<AgentResult, AgentdError>> {
    const raw = await this.#readJson(runId, "result", "RUN_NOT_FOUND");
    if (!raw.ok) return raw;

    const parsed = parseAgentResult(raw.value);
    if (!parsed.ok) {
      return err(
        makeError("STORE_CORRUPT", "result.json did not validate", {
          details: { runId, reason: parsed.error.code },
          cause: parsed.error,
        }),
      );
    }
    return parsed;
  }

  // --- metadata -----------------------------------------------------------

  public async writeMetadata(
    runId: string,
    metadata: RunMetadata,
  ): Promise<Result<undefined, AgentdError>> {
    return await atomicWriteFile(
      this.runFile(runId, "metadata"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }

  public async readMetadata(
    runId: string,
  ): Promise<Result<RunMetadata, AgentdError>> {
    const raw = await this.#readJson(runId, "metadata", "RUN_NOT_FOUND");
    if (!raw.ok) return raw;

    const parsed = runMetadataSchema.safeParse(raw.value);
    if (!parsed.success) {
      return err(
        makeError("STORE_CORRUPT", "metadata.json did not validate", {
          details: { runId },
          cause: parsed.error,
        }),
      );
    }
    // Assertion immediately after schema validation, as in the protocol
    // codecs: zod infers `k?: V | undefined` where the domain type declares
    // `k?: V`. The `_MetadataMatchesSchema` guard below proves the two agree
    // in every other respect, and JSON cannot carry an undefined property.
    return ok(parsed.data as RunMetadata);
  }

  public async updateMetadata(
    runId: string,
    patch: Partial<RunMetadata>,
  ): Promise<Result<RunMetadata, AgentdError>> {
    const current = await this.readMetadata(runId);
    if (!current.ok) return current;

    const merged: RunMetadata = { ...current.value, ...patch };
    const written = await this.writeMetadata(runId, merged);
    if (!written.ok) return written;
    return ok(merged);
  }

  // --- listing ------------------------------------------------------------

  /**
   * Every run, oldest first.
   *
   * This is where the choice of ULID pays: `runId` sorts lexicographically in
   * creation order, so recovery walks runs oldest-first without opening a
   * single `state.json`. Entries that are not valid run IDs are ignored, so a
   * stray file in the runs directory cannot break a recovery pass.
   */
  public async listRunIds(): Promise<Result<string[], AgentdError>> {
    const entries = await tryCatchAsync(
      async () => await readdir(this.runsDirectory(), { withFileTypes: true }),
      (cause) => fromThrown("STORE_IO_FAILED", "could not list runs", cause),
    );

    if (!entries.ok) {
      if (isNotFound(entries.error)) return ok([]);
      return entries;
    }

    const runIds = entries.value
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => entry.name)
      .sort();

    return ok(runIds);
  }

  // --- locking ------------------------------------------------------------

  /**
   * Claim exclusive ownership of a run directory.
   *
   * `O_EXCL` makes creation atomic, so two daemons cannot both believe they own
   * a run. The lock records the owning PID and its start time, so a *stale*
   * lock left by a crashed daemon is distinguishable from a live one — the
   * check `isProcessAlive` performs.
   */
  public async acquireLock(
    runId: string,
    owner: { pid: number; startedAtMs: number },
  ): Promise<Result<undefined, AgentdError>> {
    return await writeFileExclusive(
      this.runFile(runId, "lock"),
      `${JSON.stringify(owner)}\n`,
    );
  }

  public async releaseLock(
    runId: string,
  ): Promise<Result<undefined, AgentdError>> {
    const released = await tryCatchAsync(
      async () => {
        await unlink(this.runFile(runId, "lock"));
        return undefined;
      },
      (cause) =>
        fromThrown("STORE_IO_FAILED", "could not release run lock", cause, {
          runId,
        }),
    );
    return !released.ok && isNotFound(released.error)
      ? ok(undefined)
      : released;
  }

  // --- internals ----------------------------------------------------------

  async #readJson(
    runId: string,
    file: keyof typeof RUN_FILES,
    missingCode: "RUN_NOT_FOUND",
  ): Promise<Result<unknown, AgentdError>> {
    const raw = await tryCatchAsync(
      async () => await readFile(this.runFile(runId, file), "utf8"),
      (cause) =>
        fromThrown(missingCode, `${RUN_FILES[file]} could not be read`, cause, {
          runId,
        }),
    );
    if (!raw.ok) return raw;

    try {
      return ok(JSON.parse(raw.value));
    } catch (cause) {
      return err(
        makeError("STORE_CORRUPT", `${RUN_FILES[file]} is not valid JSON`, {
          details: { runId },
          cause,
        }),
      );
    }
  }
}

/** Distinguishes "no such file" from a real I/O failure. */
function isNotFound(error: AgentdError): boolean {
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === "ENOENT";
}
