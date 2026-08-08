/**
 * Exclusive ownership of a runtime directory.
 *
 * The lock is a SQLite exclusive transaction held for the daemon's lifetime.
 * SQLite delegates exclusion to the operating system, so a process crash
 * releases the lock without leaving an ownership decision behind for the next
 * daemon. That matters: an `O_EXCL` pid file can be created atomically, but it
 * cannot be safely reclaimed with an unlink-and-recreate sequence because two
 * contenders can both decide that the old owner is dead and delete each
 * other's new claim.
 *
 * This database contains no durable daemon state. The transaction and its
 * connection *are* the lock; the owner is retained in memory for diagnostics.
 */

import { chmod } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

export type DaemonLockOwner = Readonly<{
  pid: number;
  startedAtMs: number;
}>;

export interface DaemonLock {
  readonly owner: DaemonLockOwner;
  readonly path: string;
  /** Idempotently releases the OS lock and closes its database connection. */
  release(): Promise<Result<undefined, AgentdError>>;
}

export type DaemonLockOptions = Readonly<{
  lockPath: string;
  /** Test seam. Production records the current process. */
  owner?: DaemonLockOwner;
}>;

export function processOwner(): DaemonLockOwner {
  return {
    pid: process.pid,
    startedAtMs: Math.round(Date.now() - process.uptime() * 1_000),
  };
}

function alreadyRunning(lockPath: string): AgentdError {
  return makeError(
    "DAEMON_ALREADY_RUNNING",
    "another daemon already owns this runtime directory",
    { details: { lockPath } },
  );
}

function isBusy(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /database is locked|SQLITE_BUSY/i.test(cause.message);
}

export async function acquireDaemonLock(
  options: DaemonLockOptions,
): Promise<Result<DaemonLock, AgentdError>> {
  const owner = options.owner ?? processOwner();
  let database: DatabaseSync | undefined;

  try {
    database = new DatabaseSync(options.lockPath, { timeout: 0 });
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
    await chmod(options.lockPath, 0o600);
  } catch (cause) {
    try {
      database?.close();
    } catch {
      // Acquisition's original failure is more useful than close failure.
    }
    return err(
      isBusy(cause)
        ? alreadyRunning(options.lockPath)
        : fromThrown(
            "STORE_IO_FAILED",
            "the daemon lock could not be acquired",
            cause,
            { lockPath: options.lockPath },
          ),
    );
  }

  let released = false;
  return ok({
    owner,
    path: options.lockPath,
    release: (): Promise<Result<undefined, AgentdError>> => {
      if (released) return Promise.resolve(ok(undefined));
      released = true;
      try {
        database.exec("ROLLBACK");
        database.close();
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        try {
          database.close();
        } catch {
          // The first failure is the useful one; close is best-effort here.
        }
        return Promise.resolve(
          err(
            fromThrown(
              "STORE_IO_FAILED",
              "the daemon lock could not be released",
              cause,
              { lockPath: options.lockPath },
            ),
          ),
        );
      }
    },
  });
}
