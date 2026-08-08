/**
 * Crash-safe file writes.
 *
 * `state.json` is the record that says what a run is doing. If it can be found
 * half-written after a power loss, recovery has nothing to trust — so it is
 * never written in place.
 *
 * The sequence, and why each step is load-bearing:
 *
 *   1. write to a temporary file **in the same directory** — `rename` is only
 *      atomic within a filesystem, and a temp file elsewhere may not be;
 *   2. `fsync` the file — the data must reach the disk before anything points
 *      at it;
 *   3. `rename` over the target — atomic: a reader sees the old file or the new
 *      one, never a mixture;
 *   4. `fsync` the **directory** — the rename itself is metadata, and without
 *      this the directory entry can be lost even though the file's contents
 *      survived.
 *
 * Step 4 is the one most often skipped, and the one that turns "atomic write"
 * into "atomic write unless the machine loses power".
 */

import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fromThrown,
  ok,
  tryCatchAsync,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/** fsync a directory so a rename within it is durable. */
async function syncDirectory(directory: string): Promise<void> {
  // Opening a directory for reading and calling fsync is the portable way to
  // flush its metadata. It is not supported on Windows, which this daemon does
  // not target.
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write `contents` to `filePath` atomically.
 *
 * `uniqueSuffix` keeps two concurrent writers from colliding on the temp name.
 * They would still race on the final `rename`, but the loser's data is
 * discarded wholesale rather than interleaved — and the run lock is what stops
 * two writers existing in the first place.
 */
export async function atomicWriteFile(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<Result<undefined, AgentdError>> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${Date.now().toString(36)}.tmp`,
  );

  try {
    const handle = await open(tempPath, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, filePath);
    await syncDirectory(directory);

    return ok(undefined);
  } catch (cause) {
    // Best effort: if the temp file survived, remove it so a failed write does
    // not leave debris that looks like state.
    await unlink(tempPath).catch(() => undefined);
    return {
      ok: false,
      error: fromThrown(
        "STORE_IO_FAILED",
        "could not write file atomically",
        cause,
        { file: path.basename(filePath) },
      ),
    };
  }
}

/**
 * Append to a file and flush.
 *
 * Used for `events.ndjson`, which is append-only. A single `write` of a
 * complete line is not torn by a concurrent reader on the platforms we target,
 * and `fsync` makes the record durable before the caller is told it landed.
 */
export async function appendAndSync(
  filePath: string,
  contents: string,
): Promise<Result<undefined, AgentdError>> {
  return await tryCatchAsync(
    async () => {
      const handle = await open(filePath, "a", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return undefined;
    },
    (cause) =>
      fromThrown("STORE_IO_FAILED", "could not append to file", cause, {
        file: path.basename(filePath),
      }),
  );
}

/** Create a file only if it does not exist, for lock acquisition. */
export async function writeFileExclusive(
  filePath: string,
  contents: string,
  mode = 0o600,
): Promise<Result<undefined, AgentdError>> {
  return await tryCatchAsync(
    async () => {
      await writeFile(filePath, contents, {
        encoding: "utf8",
        flag: "wx",
        mode,
      });
      return undefined;
    },
    (cause) =>
      fromThrown("RUN_LOCKED", "lock file already exists", cause, {
        file: path.basename(filePath),
      }),
  );
}
