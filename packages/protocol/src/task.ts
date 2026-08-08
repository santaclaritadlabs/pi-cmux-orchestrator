/**
 * `AgentTask` — what Pi asks `agentd` to do.
 *
 * The shape merges the two normative documents: naming and versioning follow
 * CLAUDE.md (`protocolVersion`, `taskId`, `worker`, `sandbox`, `capabilities`),
 * while `role`, `limits`, `dependencies`, `forbiddenPaths` and the
 * `mayWrite`/`mayCommit`/`mayPush` triple come from the spec because they carry
 * capability the CLAUDE.md shape cannot express. See docs/adr/0001.
 *
 * A task is a *request*, not a permission. Everything here is subject to the
 * policy engine, which fails closed. In particular `constraints` describes what
 * the caller is asking for, never what it has already been granted.
 */

import { z } from "zod";

import {
  LIMITS,
  type DeepExactOptional,
  type Expect,
  type MutuallyAssignable,
  absolutePathSchema,
  boundedText,
  digestSchema,
  durationMsSchema,
  gitRefSchema,
  taskIdSchema,
  uniqueArray,
} from "./primitives.ts";

export const PROTOCOL_VERSION = "1";
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * `fake` is a first-class worker kind, not a test hack: P1 ships a fake adapter
 * as its only execution path, and a run recorded against it must be
 * representable in durable state and in the audit trail.
 */
export const WORKER_KINDS = [
  "codex",
  "claude",
  "cursor",
  "antigravity",
  "fake",
] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const TASK_ROLES = [
  "investigate",
  "design",
  "implement",
  "test",
  "review",
  "security-review",
] as const;
export type TaskRole = (typeof TASK_ROLES)[number];

/** `deny` is the default everywhere. `allowlist` requires an explicit list. */
export const NETWORK_MODES = ["deny", "allowlist", "allow"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const SANDBOX_MODES = ["required", "preferred", "none"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type TaskInput = Readonly<{
  name: string;
  digest: string;
  path?: string;
}>;

export type TaskWorkspace = Readonly<{
  repoId: string;
  worktreePath: string;
  baseRef: string;
}>;

export type TaskWorker = Readonly<{
  kind: WorkerKind;
  profile: string;
}>;

export type TaskConstraints = Readonly<{
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  network: NetworkMode;
  /** Hosts permitted when `network` is `allowlist`; empty otherwise. */
  networkAllowlist: readonly string[];
  sandbox: SandboxMode;
  mayWrite: boolean;
  mayCommit: boolean;
  /** Structurally `false`. Workers never push — spec §8, §12. */
  mayPush: false;
  capabilities: readonly string[];
}>;

export type TaskLimits = Readonly<{
  /** Advisory: emits a warning event, the run continues. */
  softTimeoutMs: number;
  /** Enforced: the worker's process group is terminated. */
  hardTimeoutMs: number;
  maxTurns?: number;
  budgetUsd?: number;
}>;

export type AgentTask = Readonly<{
  protocolVersion: ProtocolVersion;
  taskId: string;
  parentTaskId?: string;
  objective: string;
  role: TaskRole;
  workspace: TaskWorkspace;
  worker: TaskWorker;
  constraints: TaskConstraints;
  limits: TaskLimits;
  dependencies: readonly string[];
  inputs: readonly TaskInput[];
}>;

// --- schema ---------------------------------------------------------------

const taskInputSchema = z
  .strictObject({
    name: boundedText(LIMITS.identifierMaxChars),
    digest: digestSchema,
    path: absolutePathSchema.optional(),
  })
  .readonly();

const taskWorkspaceSchema = z
  .strictObject({
    repoId: boundedText(LIMITS.identifierMaxChars),
    worktreePath: absolutePathSchema,
    baseRef: gitRefSchema,
  })
  .readonly();

const taskWorkerSchema = z
  .strictObject({
    kind: z.enum(WORKER_KINDS),
    profile: boundedText(LIMITS.profileMaxChars),
  })
  .readonly();

const taskConstraintsSchema = z
  .strictObject({
    allowedPaths: uniqueArray(
      absolutePathSchema,
      LIMITS.maxAllowedPaths,
      "allowedPaths",
    ),
    forbiddenPaths: uniqueArray(
      absolutePathSchema,
      LIMITS.maxForbiddenPaths,
      "forbiddenPaths",
    ),
    network: z.enum(NETWORK_MODES),
    networkAllowlist: uniqueArray(
      boundedText(LIMITS.identifierMaxChars),
      LIMITS.maxNetworkAllowlist,
      "networkAllowlist",
    ),
    sandbox: z.enum(SANDBOX_MODES),
    mayWrite: z.boolean(),
    mayCommit: z.boolean(),
    // Not `z.boolean()` with a check: `false` is the only inhabitant, so a
    // task requesting push cannot even be constructed.
    mayPush: z.literal(false),
    capabilities: uniqueArray(
      boundedText(LIMITS.identifierMaxChars),
      LIMITS.maxCapabilities,
      "capabilities",
    ),
  })
  .readonly();

const taskLimitsSchema = z
  .strictObject({
    softTimeoutMs: durationMsSchema,
    hardTimeoutMs: durationMsSchema,
    maxTurns: z.int().positive().max(LIMITS.maxTurns).optional(),
    budgetUsd: z.number().positive().max(LIMITS.maxBudgetUsd).optional(),
  })
  .readonly();

const agentTaskObject = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    parentTaskId: taskIdSchema.optional(),
    objective: boundedText(LIMITS.objectiveMaxChars),
    role: z.enum(TASK_ROLES),
    workspace: taskWorkspaceSchema,
    worker: taskWorkerSchema,
    constraints: taskConstraintsSchema,
    limits: taskLimitsSchema,
    dependencies: uniqueArray(
      taskIdSchema,
      LIMITS.maxDependencies,
      "dependencies",
    ),
    inputs: uniqueArray(taskInputSchema, LIMITS.maxInputs, "inputs"),
  })
  .readonly();

/**
 * Cross-field invariants. Each one closes a way the task could be internally
 * inconsistent — an inconsistency the policy engine would otherwise have to
 * guess its way through at admission time.
 */
export const agentTaskSchema = agentTaskObject.superRefine((task, ctx) => {
  if (task.limits.hardTimeoutMs < task.limits.softTimeoutMs) {
    ctx.addIssue({
      code: "custom",
      path: ["limits", "hardTimeoutMs"],
      message: "hardTimeoutMs must be greater than or equal to softTimeoutMs",
    });
  }

  const wantsAllowlist = task.constraints.network === "allowlist";
  const hasAllowlist = task.constraints.networkAllowlist.length > 0;
  if (wantsAllowlist && !hasAllowlist) {
    ctx.addIssue({
      code: "custom",
      path: ["constraints", "networkAllowlist"],
      message: "network 'allowlist' requires a non-empty networkAllowlist",
    });
  }
  if (!wantsAllowlist && hasAllowlist) {
    // An allowlist under `deny` or `allow` reads as intent that will not be
    // honoured. Reject rather than silently ignore it.
    ctx.addIssue({
      code: "custom",
      path: ["constraints", "networkAllowlist"],
      message: `networkAllowlist must be empty when network is '${task.constraints.network}'`,
    });
  }

  if (task.constraints.mayCommit && !task.constraints.mayWrite) {
    ctx.addIssue({
      code: "custom",
      path: ["constraints", "mayCommit"],
      message: "mayCommit requires mayWrite",
    });
  }

  // A writer with no allowlist would be bounded only by the worktree. Force
  // the caller to state the write surface explicitly.
  if (task.constraints.mayWrite && task.constraints.allowedPaths.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["constraints", "allowedPaths"],
      message: "mayWrite requires at least one allowedPath",
    });
  }

  if (task.parentTaskId === task.taskId) {
    ctx.addIssue({
      code: "custom",
      path: ["parentTaskId"],
      message: "a task cannot be its own parent",
    });
  }

  if (task.dependencies.includes(task.taskId)) {
    ctx.addIssue({
      code: "custom",
      path: ["dependencies"],
      message: "a task cannot depend on itself",
    });
  }

  const inputNames = new Set<string>();
  task.inputs.forEach((input, index) => {
    if (inputNames.has(input.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["inputs", index, "name"],
        message: `duplicate input name '${input.name}'`,
      });
    }
    inputNames.add(input.name);
  });
});

type _TaskMatchesSchema = Expect<
  MutuallyAssignable<
    DeepExactOptional<z.infer<typeof agentTaskObject>>,
    AgentTask
  >
>;
