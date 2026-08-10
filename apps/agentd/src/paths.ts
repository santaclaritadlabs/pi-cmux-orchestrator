/**
 * Where the daemon keeps its socket, token and state.
 *
 * Two directories, both `0700`, both under the user's home by default:
 *
 *   `~/.local/run/`        the socket and the auth token (spec §4)
 *   `~/.local/share/pi-agentd/`  durable run state (spec §11)
 *
 * A Unix socket path is limited to about 104 bytes on macOS (`sun_path`), so
 * the path is checked at startup rather than failing later with an opaque
 * `EINVAL` from `bind`. A long `$HOME` (a corporate SSO username, a
 * network-mounted profile) can push the default socket path over that limit
 * with no way for the affected user to recover, so `AGENTD_RUNTIME_DIR` /
 * `AGENTD_STATE_DIR` let them relocate both directories to a shorter path —
 * still explicit, still under their own control, same as `CMUX_SOCKET_PATH`
 * for the cmux bridge.
 */

import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  fromThrown,
  makeError,
  err,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/** Conservative: the real limit is 104 on macOS, 108 on Linux. */
export const MAX_SOCKET_PATH_BYTES = 100;

export const SOCKET_NAME = "pi-agentd.sock";
export const TOKEN_NAME = "pi-agentd.token";
export const LOCK_NAME = "pi-agentd.lock.sqlite";

export const REPOSITORIES_NAME = "repositories.json";

export type DaemonPaths = Readonly<{
  runtimeDir: string;
  stateDir: string;
  socketPath: string;
  tokenPath: string;
  lockPath: string;
  /**
   * Every worktree this daemon creates lives under here — one root, so
   * containment is a single check rather than a per-task argument.
   *
   * Deliberately a **sibling** of the state directory, not a child. The state
   * directory holds the run store, which is on the sandbox denylist: a worker
   * that can write `state.json` or `events.ndjson` can forge its own audit
   * trail. A worktree nested inside it would be refused by that same rule, so
   * the two live next to each other instead.
   */
  worktreeRoot: string;
  /**
   * Every worker's isolated, persistent `HOME` lives under here, one
   * subdirectory per worker kind (`<workerHomeRoot>/claude`, `.../cursor`, …).
   *
   * A sibling of the state directory for the same reason `worktreeRoot` is:
   * a worker's `HOME` is itself a write surface (`~/.claude/`, session files,
   * shell config), so it must sit outside anything the sandbox denylist would
   * refuse to let a worker touch, and outside the run store a worker must
   * never be able to forge.
   */
  workerHomeRoot: string;
  /** The operator's repository allowlist. */
  repositoriesPath: string;
}>;

export function resolveDaemonPaths(
  options: { home?: string; runtimeDir?: string; stateDir?: string } = {},
): DaemonPaths {
  const home = options.home ?? homedir();
  const runtimeDir =
    options.runtimeDir ??
    process.env["AGENTD_RUNTIME_DIR"] ??
    path.join(home, ".local", "run");
  const stateDir =
    options.stateDir ??
    process.env["AGENTD_STATE_DIR"] ??
    path.join(home, ".local", "share", "pi-agentd");

  return {
    runtimeDir,
    stateDir,
    socketPath: path.join(runtimeDir, SOCKET_NAME),
    tokenPath: path.join(runtimeDir, TOKEN_NAME),
    lockPath: path.join(runtimeDir, LOCK_NAME),
    worktreeRoot: `${stateDir}-worktrees`,
    workerHomeRoot: `${stateDir}-worker-home`,
    repositoriesPath: path.join(stateDir, REPOSITORIES_NAME),
  };
}

/**
 * Create both directories `0700` and verify the socket path will fit.
 *
 * `mkdir`'s `mode` is subject to the process umask, so the permissions are
 * verified afterwards rather than assumed. A directory that already exists with
 * looser permissions is a real finding: it means the token could be readable by
 * someone else, and the daemon refuses to start rather than silently narrowing
 * something the user may have widened deliberately.
 */
export async function prepareDaemonDirectories(
  paths: DaemonPaths,
): Promise<Result<undefined, AgentdError>> {
  const socketBytes = Buffer.byteLength(paths.socketPath, "utf8");
  if (socketBytes > MAX_SOCKET_PATH_BYTES) {
    return err(
      makeError(
        "INTERNAL",
        "the socket path is too long for a Unix domain socket; set " +
          "AGENTD_RUNTIME_DIR (and AGENTD_STATE_DIR) to a shorter path and retry",
        { details: { bytes: socketBytes, limit: MAX_SOCKET_PATH_BYTES } },
      ),
    );
  }

  for (const directory of [paths.runtimeDir, paths.stateDir]) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (cause) {
      return err(
        fromThrown(
          "STORE_IO_FAILED",
          "could not create a daemon directory",
          cause,
          { directory },
        ),
      );
    }

    const stats = await stat(directory);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return err(
        makeError(
          "STORE_IO_FAILED",
          "a daemon directory is accessible to other users",
          { details: { directory, mode: mode.toString(8) } },
        ),
      );
    }
  }

  return ok(undefined);
}
