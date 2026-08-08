/**
 * Hardened `git` invocation.
 *
 * `git` is not a pure query tool. Several ordinary operations will execute code
 * that the repository — untrusted, per the threat model — gets to choose:
 *
 *   - `git worktree add` checks files out, and a checkout fires the
 *     `post-checkout` hook;
 *   - `core.fsmonitor` names a program git runs on almost every command;
 *   - `filter.*.smudge` / `.process` run during checkout, selected by the
 *     repository's own `.gitattributes`;
 *   - `credential.helper` and `core.sshCommand` run on anything that touches a
 *     remote.
 *
 * So every invocation here is wrapped twice. `GIT_SAFE_CONFIG` disables the
 * mechanisms that can be turned off from the command line, and
 * {@link inspectRepositoryConfig} refuses repositories that declare the ones
 * that cannot. Command-line `-c` beats repository config, which is what makes
 * the first half work at all.
 *
 * The environment is *built*, never inherited: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` and friends would each silently redirect an operation
 * somewhere other than where the caller believes it is pointing, and an
 * allowlist keeps every one of them out without having to enumerate them.
 */

import { execFile } from "node:child_process";
import path from "node:path";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";
import { buildWorkerEnvironment } from "@pi-cmux/process-supervisor";

/**
 * Configuration forced on every invocation, overriding whatever the repository
 * asked for. Command-line `-c` has the highest precedence in git's config
 * stack, so these cannot be undone by `.git/config`.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  // The single most important one: no repository hook ever runs. `/dev/null`
  // is a valid path that contains no hooks, which is exactly the intent.
  "-c",
  "core.hooksPath=/dev/null",
  // Names an external program run on most commands.
  "-c",
  "core.fsmonitor=false",
  // `ext::` transport executes an arbitrary command as a "remote".
  "-c",
  "protocol.ext.allow=never",
  // Runs a helper process on any credential lookup.
  "-c",
  "credential.helper=",
  // We never page, and a pager is a subprocess.
  "-c",
  "core.pager=cat",
  // Detaching HEAD is deliberate here; the advice text is noise on stderr.
  "-c",
  "advice.detachedHead=false",
];

/**
 * The environment for `git`.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at `/dev/null` neutralise
 * the user's `~/.gitconfig` and `/etc/gitconfig`: the daemon's behaviour must
 * not depend on the operator's personal settings, and a `[core] fsmonitor` in a
 * developer's home directory is as executable as one in a repository.
 */
export function buildGitEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return buildWorkerEnvironment({
    source,
    extra: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      // Never block waiting for a human at a terminal the daemon does not have.
      GIT_TERMINAL_PROMPT: "0",
      // Read-only commands must not take the index lock.
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      // Stable, parseable output regardless of the operator's locale.
      LC_ALL: "C",
    },
  });
}

export type GitOutput = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type RunGitOptions = Readonly<{
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Exit codes to treat as success in addition to `0`. `git config --list`
   * returns 1 for "no such section", which is an answer, not a failure.
   */
  allowExitCodes?: readonly number[];
  env?: Readonly<Record<string, string | undefined>>;
}>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Shape `execFile` rejects with. Narrowed rather than asserted. */
type ExecFileFailure = Readonly<{
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}>;

function asExecFailure(cause: unknown): ExecFileFailure {
  if (typeof cause !== "object" || cause === null) return {};
  const candidate = cause as Record<string, unknown>;
  const code = candidate["code"];
  const stdout = candidate["stdout"];
  const stderr = candidate["stderr"];
  return {
    ...(typeof code === "number" || typeof code === "string" ? { code } : {}),
    ...(candidate["killed"] === true ? { killed: true } : {}),
    ...(typeof stdout === "string" ? { stdout } : {}),
    ...(typeof stderr === "string" ? { stderr } : {}),
  };
}

/**
 * Run `git` with an argument array and no shell.
 *
 * Failures never interpolate git's own output into `safeMessage`: stderr from a
 * repository operation can contain branch names, file paths and commit
 * subjects, all of which are attacker-chosen. The text is returned in
 * {@link GitOutput} for a caller that has a reason to look at it, and it is the
 * caller's job not to log it.
 */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<Result<GitOutput, AgentdError>> {
  if (!path.isAbsolute(options.cwd)) {
    return err(
      makeError("GIT_COMMAND_FAILED", "git requires an absolute directory"),
    );
  }

  // Nothing constructs argv from untrusted text, but a value that reaches here
  // looking like an option would be interpreted as one, and the cost of being
  // certain is a loop. `--` and `--end-of-options` are ours and stay.
  const injected = args.findIndex((arg, index) => {
    if (index === 0 || !arg.startsWith("-")) return false;
    if (arg === "--" || arg === "--end-of-options") return false;
    // `--porcelain=v1` is the same flag as `--porcelain`.
    const separator = arg.indexOf("=");
    return !KNOWN_FLAGS.has(separator < 0 ? arg : arg.slice(0, separator));
  });
  if (injected !== -1) {
    return err(
      makeError("GIT_COMMAND_FAILED", "refusing an unrecognised git option", {
        details: { subcommand: args[0] ?? "", position: injected },
      }),
    );
  }

  const allowed = new Set<number>([0, ...(options.allowExitCodes ?? [])]);

  return await new Promise<Result<GitOutput, AgentdError>>((resolve) => {
    execFile(
      "git",
      [...GIT_SAFE_CONFIG, ...args],
      {
        cwd: options.cwd,
        env: buildGitEnvironment(options.env),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? DEFAULT_MAX_BYTES,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        if (cause === null) {
          resolve(ok({ stdout, stderr, exitCode: 0 }));
          return;
        }

        const failure = asExecFailure(cause);
        const exitCode = typeof failure.code === "number" ? failure.code : -1;

        if (allowed.has(exitCode)) {
          resolve(ok({ stdout, stderr, exitCode }));
          return;
        }

        resolve(
          err(
            fromThrown(
              "GIT_COMMAND_FAILED",
              failure.killed === true
                ? "a git command exceeded its time limit"
                : "a git command failed",
              cause,
              {
                subcommand: args[0] ?? "",
                exitCode,
                timedOut: failure.killed === true,
              },
            ),
          ),
        );
      },
    );
  });
}

/**
 * Flags this package passes to git. An argument starting with `-` that is not
 * here is a bug or an injection, and either way the command does not run.
 */
const KNOWN_FLAGS = new Set<string>([
  "--detach",
  "--force",
  "--porcelain",
  "--verify",
  "--quiet",
  "--local",
  "--list",
  "--null",
  "--no-checkout",
  "--git-common-dir",
  "--absolute-git-dir",
  "--is-inside-work-tree",
  "--show-toplevel",
  "-z",
  "-b",
  "-C",
]);
