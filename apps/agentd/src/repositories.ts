/**
 * Which repositories this daemon will touch.
 *
 * `AgentTask.workspace` carries a `repoId`, not a path — deliberately. A task
 * that could name an arbitrary directory would let whoever composes tasks
 * choose what `agentd` checks out, and Pi is not a trusted source of
 * filesystem locations.
 *
 * So the mapping from identifier to path lives here, in operator
 * configuration, and it is an **allowlist**: a task naming a repository that
 * was not configured is refused. There is no discovery, no search path, and no
 * "if it looks like a git repo, use it".
 */

import path from "node:path";

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

export type RepositoryEntry = Readonly<{
  repoId: string;
  /** Absolute path to the primary checkout. */
  path: string;
}>;

export class RepositoryRegistry {
  readonly #byId: ReadonlyMap<string, string>;

  public constructor(entries: readonly RepositoryEntry[]) {
    const byId = new Map<string, string>();
    for (const entry of entries) {
      if (!path.isAbsolute(entry.path)) {
        // A relative repository path would resolve against whatever directory
        // the daemon happens to be started from. That is a configuration bug,
        // and it is a startup failure rather than a runtime surprise.
        throw new Error(
          `repository '${entry.repoId}' must be configured with an absolute path`,
        );
      }
      byId.set(entry.repoId, path.resolve(entry.path));
    }
    this.#byId = byId;
  }

  public get size(): number {
    return this.#byId.size;
  }

  public get ids(): readonly string[] {
    return [...this.#byId.keys()];
  }

  public resolve(repoId: string): Result<string, AgentdError> {
    const resolved = this.#byId.get(repoId);
    if (resolved === undefined) {
      return err(
        makeError(
          "POLICY_DENIED",
          "the task names a repository this daemon is not configured to use",
          {
            details: {
              rule: "workspace.repository-allowlisted",
              // The count, not the list: which repositories exist is
              // information the caller has not been granted.
              reason: `no repository is configured under that identifier (${String(this.#byId.size)} configured)`,
            },
          },
        ),
      );
    }
    return ok(resolved);
  }
}
