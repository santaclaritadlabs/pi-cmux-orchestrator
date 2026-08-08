/**
 * Operator configuration.
 *
 * There is exactly one thing an operator must configure before `agentd` can do
 * useful work: which repositories it is allowed to touch. That is deliberate —
 * the daemon has no defaults to discover, no search path, and no way to be
 * talked into a repository by a task.
 *
 * A missing file is not an error. The daemon starts with an empty allowlist and
 * refuses every task that names a repository, which is the correct behaviour
 * for a daemon nobody has configured yet: it runs, it answers, it does nothing.
 */

import { readFile } from "node:fs/promises";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { z } from "zod";

import { RepositoryRegistry, type RepositoryEntry } from "./repositories.ts";

const repositoriesFileSchema = z
  .strictObject({
    version: z.literal(1),
    repositories: z
      .array(
        z
          .strictObject({
            repoId: z.string().min(1).max(128),
            path: z.string().min(1).max(4096),
          })
          .readonly(),
      )
      .max(256),
  })
  .readonly();

export type RepositoriesFile = z.infer<typeof repositoriesFileSchema>;

/**
 * Read and validate the repository allowlist.
 *
 * Malformed configuration is a **startup failure**, not something to work
 * around: an operator who wrote a bad allowlist has an intent we cannot infer,
 * and continuing with the entries that happened to parse would grant a subset
 * nobody chose.
 */
export async function loadRepositories(
  filePath: string,
): Promise<Result<RepositoryRegistry, AgentdError>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return ok(new RepositoryRegistry([]));
    return err(
      fromThrown(
        "STORE_IO_FAILED",
        "could not read the repository allowlist",
        cause,
      ),
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return err(
      fromThrown(
        "STORE_CORRUPT",
        "the repository allowlist is not valid JSON",
        cause,
      ),
    );
  }

  const parsed = repositoriesFileSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(
      makeError("STORE_CORRUPT", "the repository allowlist failed validation", {
        details: { issues: parsed.error.issues.length },
      }),
    );
  }

  const seen = new Set<string>();
  for (const entry of parsed.data.repositories) {
    if (seen.has(entry.repoId)) {
      return err(
        makeError(
          "STORE_CORRUPT",
          "the repository allowlist names the same repository twice",
          { details: { repoId: entry.repoId } },
        ),
      );
    }
    seen.add(entry.repoId);
  }

  try {
    return ok(
      new RepositoryRegistry(
        parsed.data.repositories as readonly RepositoryEntry[],
      ),
    );
  } catch (cause) {
    return err(
      fromThrown(
        "STORE_CORRUPT",
        "the repository allowlist contains an unusable path",
        cause,
      ),
    );
  }
}
