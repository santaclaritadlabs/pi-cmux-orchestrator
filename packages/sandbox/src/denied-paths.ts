/**
 * Host paths a worker never gets.
 *
 * Spec §17 lists these directly, and the reason they are a *denylist* rather
 * than simply "not on the allowlist" is that the allowlist is per task and
 * written by whoever composed the task. A denylist is the check that does not
 * depend on the caller having been careful.
 *
 * Deny wins over allow. A task that names `~/.ssh` in `allowedPaths` is refused
 * rather than quietly narrowed — a request for credentials is a signal, and
 * silently dropping it discards the signal.
 */

import { homedir } from "node:os";
import path from "node:path";

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { assertContained } from "@pi-cmux/policy";

/**
 * Relative to the user's home directory.
 *
 * Agent configuration (`.claude`, `.codex`, `.cursor`, `.config/pi`) is on this
 * list for the same reason credentials are: a worker that can write another
 * agent's configuration can install a hook, a skill or an MCP server into the
 * control plane. CLAUDE.md forbids exactly that silent load path.
 */
export const DENIED_HOME_RELATIVE: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".gitconfig",
  ".git-credentials",
  ".config/gcloud",
  ".config/gh",
  ".config/pi",
  ".claude",
  ".codex",
  ".cursor",
  ".antigravity",
  // The daemon's own run store. A worker that can write `state.json` or
  // `events.ndjson` can forge its own audit trail, which is worse than any
  // credential on this list.
  ".local/share/pi-agentd",
  ".local/run",
];

/** Absolute host paths, independent of who is logged in. */
export const DENIED_ABSOLUTE: readonly string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/docker",
  "/etc/shadow",
  "/etc/sudoers",
];

/**
 * Roots that a worker may work *inside*, but may never be handed whole.
 *
 * `$HOME` is the one that matters. Denying it outright is the obvious rule and
 * the wrong one: on a single-user machine, repositories and worktrees live
 * under the home directory, so "no path inside `$HOME`" refuses the only place
 * there is to work. What must actually be refused is being handed `$HOME`
 * *itself* — a write surface of `/Users/dev` grants every secret enumerated
 * above in one go — while `/Users/dev/projects/wt` is exactly what a run needs.
 *
 * The specific dangerous children are enumerated, so this tier does not have to
 * cover them by proxy.
 */
function enclosingOnlyRoots(home: string): readonly string[] {
  return [home, "/"];
}

export type DenylistOptions = Readonly<{
  home?: string;
  /** Paths that are not in a fixed location, such as the daemon's run store. */
  extra?: readonly string[];
}>;

/**
 * The host denylist, in two tiers.
 *
 * The tiers exist because "denied" means two different things. A credential
 * directory is denied *as a location*: nothing may be inside it and nothing may
 * enclose it. A root like `$HOME` is denied only *as a grant*: working inside it
 * is normal, being given the whole thing is not.
 *
 * Collapsing the two into one list is what makes a denylist either useless or
 * unusable, depending on which meaning wins.
 */
export type Denylist = Readonly<{
  /** Never inside, never enclosing. */
  strict: readonly string[];
  /** May be inside; never equal to, never enclosing. */
  enclosingOnly: readonly string[];
}>;

export function deniedHostPaths(options: DenylistOptions = {}): Denylist {
  const home = options.home ?? homedir();

  return {
    strict: [
      ...DENIED_ABSOLUTE,
      ...DENIED_HOME_RELATIVE.map((relative) => path.join(home, relative)),
      ...(options.extra ?? []),
    ],
    enclosingOnly: enclosingOnlyRoots(home),
  };
}

/**
 * Refuse a path the host must keep to itself.
 *
 * For the strict tier, containment is checked in both directions: `~/.ssh` is
 * refused because the path *is* a secret, and `/Users/dev` would be refused
 * because it *contains* one — a path that encloses a denied directory grants
 * everything inside it just as effectively.
 *
 * For the enclosing-only tier, just the second direction. Being inside is the
 * normal case.
 */
export async function assertNotDenied(
  candidate: string,
  denied: Denylist,
): Promise<Result<string, AgentdError>> {
  for (const forbidden of denied.strict) {
    const inside = await assertContained(candidate, forbidden);
    if (inside.ok) {
      return err(
        makeError(
          "PATH_ESCAPE",
          "the path is inside a directory the host never exposes to a worker",
          { details: { denied: forbidden } },
        ),
      );
    }
  }

  // `assertContained(x, x)` is true — a directory contains itself — so this one
  // check covers both "encloses it" and "is it".
  for (const forbidden of [...denied.strict, ...denied.enclosingOnly]) {
    const encloses = await assertContained(forbidden, candidate);
    if (encloses.ok) {
      return err(
        makeError(
          "PATH_ESCAPE",
          "the path encloses a directory the host never exposes to a worker",
          { details: { denied: forbidden } },
        ),
      );
    }
  }

  return ok(candidate);
}

/** Apply {@link assertNotDenied} to every path, stopping at the first refusal. */
export async function assertNoneDenied(
  candidates: readonly string[],
  denied: Denylist,
): Promise<Result<undefined, AgentdError>> {
  for (const candidate of candidates) {
    const checked = await assertNotDenied(candidate, denied);
    if (!checked.ok) return checked;
  }
  return ok(undefined);
}
