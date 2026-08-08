/**
 * Reading a repository without letting it read back.
 *
 * Everything here treats the repository as data. The two questions that matter
 * before a worktree is created are *"is this actually a git repository?"* and
 * *"does its configuration name a program?"* — the second because
 * {@link GIT_SAFE_CONFIG} can suppress hooks and fsmonitor from the command
 * line, but a content filter selected by the repository's own `.gitattributes`
 * runs during checkout and has no command-line off switch.
 *
 * The response to a repository that declares one is refusal, not sanitisation.
 * A repository that wants a smudge filter may be perfectly legitimate; deciding
 * that is a policy question with an operator attached, not something to guess.
 */

import path from "node:path";

import {
  err,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import { runGit } from "./git.ts";

/**
 * Config keys whose value git executes.
 *
 * Exact names and `section.*.key` patterns are kept apart because the wildcard
 * forms carry a user-chosen driver name in the middle: `filter.lfs.smudge`,
 * `diff.astextplain.textconv`. Matching is case-insensitive because git
 * lower-cases section and key names but not the subsection between them.
 */
const EXECUTABLE_KEYS: readonly string[] = [
  "core.hookspath",
  "core.fsmonitor",
  "core.sshcommand",
  "core.editor",
  "core.pager",
  "core.alternaterefscommand",
  "credential.helper",
  "init.templatedir",
  "diff.external",
  "gpg.program",
  "sequence.editor",
  "uploadpack.packobjectshook",
];

const EXECUTABLE_PATTERNS: readonly RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^gpg\..+\.program$/,
  /^credential\..+\.helper$/,
  /^protocol\..+\.allow$/,
];

/**
 * Values that mean "no program". `core.fsmonitor=false` is the documented way
 * to turn the feature off, and refusing it would refuse the safe state.
 */
const INERT_VALUES = new Set(["", "false", "0", "off", "no"]);

function isExecutableKey(key: string): boolean {
  const normalised = key.toLowerCase();
  if (EXECUTABLE_KEYS.includes(normalised)) return true;
  return EXECUTABLE_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Parse `git config --list -z`.
 *
 * The `-z` form separates entries with NUL and puts a newline between key and
 * value, which is the only encoding that survives values containing newlines —
 * and a value containing a newline is exactly what a crafted config would use
 * to hide a second directive from a line-based parser.
 */
export function parseConfigList(
  raw: string,
): readonly Readonly<{ key: string; value: string }>[] {
  const entries: { key: string; value: string }[] = [];

  for (const record of raw.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    if (newline === -1) {
      // A valueless key (`[section] key` with no `=`). Git reports it as `true`.
      entries.push({ key: record, value: "true" });
      continue;
    }
    entries.push({
      key: record.slice(0, newline),
      value: record.slice(newline + 1),
    });
  }

  return entries;
}

export type RepositoryIdentity = Readonly<{
  /** The canonical work tree root, as git itself reports it. */
  topLevel: string;
  /** The shared `.git` directory — the same for every linked worktree. */
  commonDir: string;
}>;

/**
 * Confirm the path is a git work tree and learn its canonical identity.
 *
 * `--show-toplevel` matters beyond validation: it is how a worktree proves
 * later which repository it belongs to, and a path the caller supplied is not
 * evidence of anything.
 */
export async function identifyRepository(
  repoPath: string,
): Promise<Result<RepositoryIdentity, AgentdError>> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: repoPath,
  });
  if (!inside.ok) return inside;
  if (inside.value.stdout.trim() !== "true") {
    return err(
      makeError("GIT_COMMAND_FAILED", "the path is not a git work tree"),
    );
  }

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: repoPath,
  });
  if (!topLevel.ok) return topLevel;

  const commonDir = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: repoPath,
  });
  if (!commonDir.ok) return commonDir;

  const top = topLevel.value.stdout.trim();
  const common = commonDir.value.stdout.trim();

  return ok({
    topLevel: top,
    // `--git-common-dir` may answer relatively (".git") depending on cwd.
    commonDir: path.isAbsolute(common) ? common : path.resolve(top, common),
  });
}

export type RepositoryAudit = Readonly<{
  /** Keys that would execute a program, with values withheld. */
  executableKeys: readonly string[];
}>;

/**
 * Refuse a repository whose configuration executes something.
 *
 * Only `--local` scope is inspected: global and system config are already
 * neutralised by {@link buildGitEnvironment}, so anything still able to
 * influence the checkout comes from the repository itself.
 *
 * Values are never returned or logged — the offending value is attacker-chosen
 * text, and the key alone is enough for an operator to go and look.
 */
export async function inspectRepositoryConfig(
  repoPath: string,
): Promise<Result<RepositoryAudit, AgentdError>> {
  const listed = await runGit(["config", "--local", "--list", "-z"], {
    cwd: repoPath,
    // Exit 1 means "no local configuration", which is a fine answer.
    allowExitCodes: [1],
  });
  if (!listed.ok) return listed;

  const executableKeys = parseConfigList(listed.value.stdout)
    .filter(
      (entry) =>
        isExecutableKey(entry.key) &&
        !INERT_VALUES.has(entry.value.trim().toLowerCase()),
    )
    .map((entry) => entry.key);

  if (executableKeys.length > 0) {
    return err(
      makeError(
        "REPO_UNSAFE",
        "the repository declares configuration that executes a program",
        {
          details: {
            // Sorted and joined: a stable string an audit event can carry.
            keys: [...new Set(executableKeys)].sort().join(","),
          },
        },
      ),
    );
  }

  return ok({ executableKeys: [] });
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Resolve a ref to the commit SHA it names *now*.
 *
 * Worktrees are created from an explicit SHA rather than the ref, so the base
 * of a run is a fact recorded before launch instead of whatever `main` happened
 * to point at by the time git got round to checking it out.
 */
export async function resolveCommit(
  repoPath: string,
  ref: string,
): Promise<Result<string, AgentdError>> {
  // `--end-of-options` stops a ref that somehow looks like a flag from being
  // read as one, independently of the schema that already forbids it.
  const resolved = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { cwd: repoPath },
  );
  if (!resolved.ok) return resolved;

  const sha = resolved.value.stdout.trim();
  if (!SHA_PATTERN.test(sha)) {
    return err(
      makeError("GIT_COMMAND_FAILED", "the base ref does not name a commit", {
        details: { ref },
      }),
    );
  }

  return ok(sha);
}

export type WorktreeStatus = Readonly<{
  headSha: string;
  dirty: boolean;
  /** Paths relative to the worktree root, capped. */
  changedFiles: readonly string[];
  /** True when the real change set was larger than the cap. */
  truncated: boolean;
}>;

/**
 * Capture what a worktree looks like: HEAD, dirty state, change summary.
 *
 * `--porcelain -z` is the only status format that is safe to parse: a filename
 * may contain spaces, quotes or newlines, and every other format either escapes
 * them ambiguously or does not escape them at all.
 */
export async function describeWorktree(
  worktreePath: string,
  maxFiles = 10_000,
): Promise<Result<WorktreeStatus, AgentdError>> {
  const head = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: worktreePath,
  });
  if (!head.ok) return head;

  const status = await runGit(["status", "--porcelain=v1", "-z"], {
    cwd: worktreePath,
  });
  if (!status.ok) return status;

  const files: string[] = [];
  const records = status.value.stdout.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;

    // `XY <path>`: two status columns, a space, then the path.
    const staged = record.slice(0, 2);
    files.push(record.slice(3));

    // A rename is two NUL-separated fields: `R  <new>` then `<old>`. Skipping
    // the second keeps the old name from being reported as a separate change.
    if (staged.startsWith("R") || staged.startsWith("C")) index += 1;
  }

  return ok({
    headSha: head.value.stdout.trim(),
    dirty: files.length > 0,
    changedFiles: files.slice(0, maxFiles),
    truncated: files.length > maxFiles,
  });
}

const WORKTREE_ATTRIBUTE = "worktree ";

/**
 * Absolute paths of every worktree git knows about for this repository.
 *
 * `worktree list --porcelain` emits `worktree <path>` attribute lines — note
 * the separator is a space, unlike `config --list`, which uses a newline. With
 * `-z` the *record* terminator becomes NUL, which is what makes a path
 * containing a newline survive the round trip. Splitting on both terminators
 * costs nothing and keeps the parser correct on git builds older than 2.36,
 * where `-z` is ignored here rather than honoured.
 */
export async function listWorktreePaths(
  repoPath: string,
): Promise<Result<readonly string[], AgentdError>> {
  const listed = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: repoPath,
  });
  if (!listed.ok) return listed;

  return ok(
    listed.value.stdout
      .split(/[\0\n]/)
      .filter((record) => record.startsWith(WORKTREE_ATTRIBUTE))
      .map((record) => record.slice(WORKTREE_ATTRIBUTE.length))
      .filter((value) => value !== ""),
  );
}
