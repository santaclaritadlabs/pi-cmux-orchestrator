/**
 * Path containment.
 *
 * The question this answers: *is this path really inside that directory?*
 *
 * Three ways to get it wrong, all of which have been real vulnerabilities in
 * real systems:
 *
 *   1. **String prefix.** `"/a/bc".startsWith("/a/b")` is `true`, but `/a/bc`
 *      is not inside `/a/b`. Comparison must be segment-aware.
 *   2. **Lexical normalisation only.** `path.resolve` collapses `..` but knows
 *      nothing about symlinks. A worktree containing a symlink to `/etc` looks
 *      contained right up until it is written through.
 *   3. **Checking the wrong moment.** A path verified and then used later can
 *      be swapped in between (TOCTOU). We reduce the window by resolving as
 *      late as possible, and the sandbox in P2 is what closes it.
 *
 * So containment is decided on the **resolved** paths, via `realpath`. For a
 * path that does not exist yet — the common case when a worker is about to
 * create a file — the nearest existing ancestor is resolved instead, which
 * still catches a symlinked parent directory.
 *
 * The lexical comparison is a building block, not a pre-filter: it is wrong in
 * both directions on its own, so using it to reject early would refuse paths
 * that are genuinely contained but spelled differently.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/**
 * Segment-aware lexical containment.
 *
 * Both paths are resolved first, so `..` is collapsed before comparison. The
 * separator check is what makes `/a/bc` not contained in `/a/b`.
 *
 * A directory contains itself: a worker allowed to write to its worktree may
 * write to the worktree root.
 */
export function isLexicallyContained(
  candidate: string,
  container: string,
): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedContainer = path.resolve(container);

  if (resolvedCandidate === resolvedContainer) return true;

  // The trailing separator is the whole point: without it, "/a/bc" passes.
  const prefix = resolvedContainer.endsWith(path.sep)
    ? resolvedContainer
    : resolvedContainer + path.sep;

  return resolvedCandidate.startsWith(prefix);
}

/**
 * Resolve a path through symlinks, falling back to its nearest existing
 * ancestor when the path itself does not exist yet.
 *
 * The fallback matters: a worker about to create `<worktree>/src/new.ts` has a
 * path that does not exist, but `<worktree>/src` might be a symlink pointing
 * somewhere else entirely. Resolving the ancestor catches that.
 */
export async function resolveExistingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffixes: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...suffixes.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(target);
      suffixes.push(path.basename(current));
      current = parent;
    }
  }
}

export type ContainmentOptions = Readonly<{
  /** Skip the filesystem check. Only for paths that provably do not exist. */
  lexicalOnly?: boolean;
}>;

/**
 * Prove that `candidate` is inside `container`, or explain why not.
 *
 * Fails closed: any error resolving either path is a denial, never an
 * assumption of safety.
 */
export async function assertContained(
  candidate: string,
  container: string,
  options: ContainmentOptions = {},
): Promise<Result<string, AgentdError>> {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(container)) {
    return err(
      makeError("PATH_ESCAPE", "containment requires absolute paths", {
        details: { candidateAbsolute: path.isAbsolute(candidate) },
      }),
    );
  }

  if (options.lexicalOnly === true) {
    if (!isLexicallyContained(candidate, container)) {
      return err(
        makeError("PATH_ESCAPE", "path resolves outside its container", {
          // Structural only — the offending path is not echoed, since it may
          // carry untrusted content. The container is ours.
          details: { container },
        }),
      );
    }
    return ok(path.resolve(candidate));
  }

  // The lexical answer is not authoritative in *either* direction, so it is not
  // used as an early exit. A symlink inside the container can make an outside
  // path look contained — the well-known direction — but a symlinked *prefix*
  // does the reverse: `/var/folders/x` and `/private/var/folders/x` are the same
  // directory spelled two ways, and rejecting on the spelling would refuse a
  // path that is genuinely inside. Both paths are resolved, and the decision is
  // made once, on what the filesystem actually says.
  const realCandidate = await resolveExistingAncestor(candidate);
  const realContainer = await resolveExistingAncestor(container);

  if (!isLexicallyContained(realCandidate, realContainer)) {
    return err(
      makeError(
        "PATH_ESCAPE",
        "path resolves outside its container after following symlinks",
        { details: { container } },
      ),
    );
  }

  return ok(realCandidate);
}

/**
 * Check a candidate against an allowlist and a denylist.
 *
 * Order is deliberate: **deny wins**. A path inside an allowed directory but
 * also inside a forbidden one is refused. Anything matching nothing is refused
 * too — the allowlist is exhaustive, not advisory.
 */
export async function checkPathAccess(
  candidate: string,
  allowed: readonly string[],
  forbidden: readonly string[],
): Promise<Result<string, AgentdError>> {
  for (const container of forbidden) {
    const contained = await assertContained(candidate, container);
    if (contained.ok) {
      return err(
        makeError("PATH_ESCAPE", "path is inside a forbidden directory", {
          details: { container },
        }),
      );
    }
  }

  for (const container of allowed) {
    const contained = await assertContained(candidate, container);
    if (contained.ok) return contained;
  }

  return err(
    makeError("PATH_ESCAPE", "path is not inside any allowed directory", {
      details: { allowedCount: allowed.length },
    }),
  );
}
