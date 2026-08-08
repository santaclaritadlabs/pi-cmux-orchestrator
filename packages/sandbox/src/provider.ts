/**
 * The sandbox boundary.
 *
 * `agentd` does not know how isolation is implemented — a seatbelt profile, a
 * container, a VM — only what a given implementation *can actually enforce*.
 * That is what {@link SandboxCapabilities} is: not a description of intent, but
 * a set of claims the selection logic is allowed to rely on.
 *
 * The distinction matters because the failure mode this interface exists to
 * prevent is a sandbox that reports success while enforcing nothing. A provider
 * that cannot confine writes says so, and a task requiring confinement is then
 * refused rather than run on the host with a reassuring log line.
 */

import type {
  AgentdError,
  NetworkMode,
  Result,
  SandboxMode,
} from "@pi-cmux/protocol";

export const SANDBOX_KINDS = ["none", "process", "vm"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

/**
 * What a provider enforces. Every field is a promise the provider is making
 * about the kernel's behaviour, not about the worker's cooperation.
 */
export type SandboxCapabilities = Readonly<{
  /** Writes outside the declared paths fail, regardless of what the worker tries. */
  filesystemConfinement: boolean;
  /** Network reachability is decided outside the worker's process. */
  networkControl: boolean;
  /** The worker runs outside the host's process and user namespace. */
  processIsolation: boolean;
}>;

export const NO_CAPABILITIES: SandboxCapabilities = {
  filesystemConfinement: false,
  networkControl: false,
  processIsolation: false,
};

export type SandboxAvailability =
  | Readonly<{ available: true; capabilities: SandboxCapabilities }>
  | Readonly<{ available: false; reason: string }>;

export type SandboxRequest = Readonly<{
  runId: string;
  taskId: string;
  /** The one directory the worker may write. */
  worktreePath: string;
  /** Narrower write surfaces inside the worktree. */
  allowedPaths: readonly string[];
  network: NetworkMode;
  networkAllowlist: readonly string[];
  /**
   * Credentials for this worker's provider and nothing else — spec §18. Passed
   * explicitly so that "which secrets did this run see?" has an answer.
   */
  secrets?: Readonly<Record<string, string>>;
  /** Additional host paths to deny, beyond the built-in list. */
  extraDeniedPaths?: readonly string[];
  /** Home directory to resolve the denylist against. Defaults to the real one. */
  home?: string;
}>;

/**
 * How to launch a worker under this provider.
 *
 * `argvPrefix` is how a wrapping sandbox inserts itself: the supervisor spawns
 * `[...argvPrefix, ...workerArgv]` as one argument array, still with no shell.
 * A provider that does not wrap returns an empty prefix.
 */
export type SandboxPlacement = Readonly<{
  providerId: string;
  kind: SandboxKind;
  capabilities: SandboxCapabilities;
  cwd: string;
  argvPrefix: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export interface SandboxProvider {
  readonly id: string;
  readonly kind: SandboxKind;
  /**
   * Ask what this provider can do *on this machine, right now*. Probing is
   * separate from preparing so that an unavailable provider is discovered at
   * selection time rather than halfway through launching a run.
   */
  probe(): Promise<SandboxAvailability>;
  prepare(
    request: SandboxRequest,
  ): Promise<Result<SandboxPlacement, AgentdError>>;
}

/** True when a provider enforces enough to satisfy `sandbox: "required"`. */
export function satisfiesRequired(capabilities: SandboxCapabilities): boolean {
  // Both, deliberately. Process isolation without filesystem confinement still
  // lets a worker write the host; confinement without process isolation still
  // lets it signal, trace or inspect host processes.
  return capabilities.filesystemConfinement && capabilities.processIsolation;
}

/** The isolation a mode demands, stated once so callers cannot disagree. */
export function requiresEnforcement(mode: SandboxMode): boolean {
  return mode === "required";
}
