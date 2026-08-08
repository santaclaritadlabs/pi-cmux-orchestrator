/**
 * Worker environment construction.
 *
 * CLAUDE.md: "Do not use ... inherited environment secrets." A worker's
 * environment is **built from an allowlist**, never inherited. The difference
 * matters: inheriting and then deleting known-bad variables fails open — every
 * new credential variable someone adds to their shell leaks until we notice.
 * Building from nothing fails closed.
 *
 * Variables named here are the ones a process genuinely needs to run at all.
 * Provider credentials are passed explicitly per worker (spec §18: a Codex
 * worker gets OpenAI auth only), never as a side effect of the parent's shell.
 */

/**
 * Variables required for a process to function on a POSIX system.
 * Deliberately short. Anything not on this list must be passed explicitly.
 */
const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

/**
 * Never forwarded, even if a caller passes them explicitly.
 *
 * Spec §14: a worker holding `CMUX_SOCKET_PATH` can drive the cockpit. Control
 * of cmux must not become an implicit capability of every worker, so these are
 * stripped unconditionally rather than merely omitted from the allowlist.
 */
export const FORBIDDEN_ENV_VARS = [
  "CMUX_SOCKET_PATH",
  "CMUX_WORKSPACE_ID",
  "CMUX_SURFACE_ID",
  "CMUX_SESSION_ID",
  // Node inspector: an open debug port is remote code execution on the worker.
  "NODE_OPTIONS",
  "NODE_INSPECT_RESUME_ON_START",
  // LD/DYLD preloading is arbitrary code injection into the child.
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_ENV_VARS);

export type BuildEnvironmentOptions = Readonly<{
  /** The environment to draw allowlisted values from. Defaults to none. */
  source?: Readonly<Record<string, string | undefined>>;
  /** Extra variable names to carry over from `source`. */
  allow?: readonly string[];
  /** Explicit values — this is how a worker receives its own credentials. */
  extra?: Readonly<Record<string, string>>;
}>;

/**
 * Build a worker environment.
 *
 * Returns a plain object with no prototype chain surprises: only string values,
 * only allowlisted or explicitly supplied names, never anything forbidden.
 */
export function buildWorkerEnvironment(
  options: BuildEnvironmentOptions = {},
): Record<string, string> {
  const source = options.source ?? {};
  const allowed = new Set<string>([
    ...BASE_ALLOWLIST,
    ...(options.allow ?? []),
  ]);

  const env: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;

  for (const name of allowed) {
    if (FORBIDDEN.has(name)) continue;
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }

  // Explicit values win over allowlisted ones — that is the point of passing
  // them — but they are still subject to the forbidden list.
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (FORBIDDEN.has(name)) continue;
    env[name] = value;
  }

  return env;
}

/** Names that would be refused, for reporting a caller's mistake back to them. */
export function forbiddenNamesIn(
  candidate: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(candidate).filter((name) => FORBIDDEN.has(name));
}
