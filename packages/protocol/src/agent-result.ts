/**
 * `AgentResult` — the single terminal record for a run.
 *
 * Spec §9 states the rule this file exists to enforce: **the worker reports
 * facts; Pi decides what happens next.** There is no `commandForNextAgent`, no
 * `executeThis`, no `instructionsForParent`. The schema is strict, so a worker
 * that invents such a field gets its result rejected rather than having the
 * field quietly ignored — which is what stops prompt injection in one worker's
 * output from becoming another worker's instructions.
 *
 * Everything here is a *claim*. CLAUDE.md: "Do not accept a worker claim of
 * success as proof: inspect the terminal result, declared artifacts, and
 * requested verification." `changedFiles` and `tests` are what the worker said;
 * `changes.headSha` and `changes.dirty` are what `agentd` observed.
 */

import { z } from "zod";

import { ERROR_CODES, isRetryable, type ErrorCode } from "./errors.ts";
import {
  LIMITS,
  type DeepExactOptional,
  type Expect,
  type MutuallyAssignable,
  absolutePathSchema,
  boundedText,
  digestSchema,
  gitShaSchema,
  relativePathSchema,
  runIdSchema,
  taskIdSchema,
  uniqueArray,
} from "./primitives.ts";
import { TEST_STATUSES, type TestStatus } from "./event.ts";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./task.ts";

export const RESULT_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const FINDING_SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type Finding = Readonly<{
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** Relative to the worktree root, when the finding is located in a file. */
  path?: string;
  line?: number;
}>;

export type TestResult = Readonly<{
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
}>;

export type ArtifactRef = Readonly<{
  name: string;
  digest: string;
  path: string;
}>;

export type ResultChanges = Readonly<{
  worktreePath: string;
  /** Observed by `agentd`, not reported by the worker. */
  headSha?: string;
  dirty: boolean;
}>;

export type ResultFailure = Readonly<{
  code: ErrorCode;
  safeMessage: string;
  retryable: boolean;
}>;

export type AgentResult = Readonly<{
  protocolVersion: ProtocolVersion;
  taskId: string;
  runId: string;
  status: ResultStatus;
  summary: string;
  exitCode?: number;
  findings: readonly Finding[];
  tests: readonly TestResult[];
  changedFiles: readonly string[];
  artifacts: readonly ArtifactRef[];
  changes: ResultChanges;
  warnings: readonly string[];
  failure?: ResultFailure;
}>;

// --- schema ---------------------------------------------------------------

const findingSchema = z
  .strictObject({
    severity: z.enum(FINDING_SEVERITIES),
    title: boundedText(LIMITS.freeTextMaxChars),
    detail: z.string().max(LIMITS.summaryMaxChars),
    path: relativePathSchema.optional(),
    line: z.int().positive().optional(),
  })
  .readonly();

const testResultSchema = z
  .strictObject({
    name: boundedText(LIMITS.freeTextMaxChars),
    status: z.enum(TEST_STATUSES),
    durationMs: z.int().min(0).optional(),
    message: z.string().max(LIMITS.freeTextMaxChars).optional(),
  })
  .readonly();

const artifactRefSchema = z
  .strictObject({
    name: boundedText(LIMITS.identifierMaxChars),
    digest: digestSchema,
    path: relativePathSchema,
  })
  .readonly();

const resultChangesSchema = z
  .strictObject({
    worktreePath: absolutePathSchema,
    headSha: gitShaSchema.optional(),
    dirty: z.boolean(),
  })
  .readonly();

const resultFailureSchema = z
  .strictObject({
    code: z.enum(ERROR_CODES),
    safeMessage: boundedText(LIMITS.freeTextMaxChars),
    retryable: z.boolean(),
  })
  .readonly();

const agentResultObject = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    taskId: taskIdSchema,
    runId: runIdSchema,
    status: z.enum(RESULT_STATUSES),
    summary: z.string().max(LIMITS.summaryMaxChars),
    /** Absent when the worker never started or was killed before exiting. */
    exitCode: z.int().min(-256).max(256).optional(),
    findings: uniqueArray(findingSchema, LIMITS.maxFindings, "findings"),
    tests: uniqueArray(testResultSchema, LIMITS.maxTests, "tests"),
    changedFiles: uniqueArray(
      relativePathSchema,
      LIMITS.maxChangedFiles,
      "changedFiles",
    ),
    artifacts: uniqueArray(artifactRefSchema, LIMITS.maxArtifacts, "artifacts"),
    changes: resultChangesSchema,
    warnings: uniqueArray(
      z.string().max(LIMITS.freeTextMaxChars),
      LIMITS.maxWarnings,
      "warnings",
    ),
    failure: resultFailureSchema.optional(),
  })
  .readonly();

/**
 * Every non-success must be attributable.
 *
 * `failure` is required exactly when `status !== "succeeded"`, including for
 * `cancelled` and `timed_out`. That makes "why did this run not succeed?"
 * answerable from the result alone, without correlating against the event log.
 */
export const agentResultSchema = agentResultObject.superRefine(
  (result, ctx) => {
    const succeeded = result.status === "succeeded";

    if (!succeeded && result.failure === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: `status '${result.status}' requires a failure record`,
      });
    }

    if (succeeded && result.failure !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "a succeeded result must not carry a failure record",
      });
    }

    // The failure's own retryable flag must agree with the taxonomy, otherwise
    // a worker could mark a policy denial retryable and drive a retry loop.
    if (result.failure !== undefined) {
      const expected = isRetryable(result.failure.code);
      if (result.failure.retryable !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["failure", "retryable"],
          message: `retryable for '${result.failure.code}' must be ${String(expected)}`,
        });
      }
    }

    // A finding's line number without a path cannot be resolved to anything.
    result.findings.forEach((finding, index) => {
      if (finding.line !== undefined && finding.path === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index, "path"],
          message: "a finding with a line must also name a path",
        });
      }
    });
  },
);

type _ResultMatchesSchema = Expect<
  MutuallyAssignable<
    DeepExactOptional<z.infer<typeof agentResultObject>>,
    AgentResult
  >
>;
