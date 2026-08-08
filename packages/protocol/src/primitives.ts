/**
 * Shared schema primitives.
 *
 * Two themes run through this file:
 *
 *   1. **Paths are a security boundary.** Every path in the contract must be
 *      absolute and already canonical. Rejecting `.`/`..` segments and NUL
 *      bytes here means `packages/policy` only ever has to prove containment,
 *      not also untangle traversal.
 *
 *   2. **Everything is bounded.** Task objectives, worker summaries and event
 *      payloads originate outside the control plane. An unbounded string or
 *      array is a memory-exhaustion primitive, so each one carries an explicit
 *      ceiling. CLAUDE.md lists "oversized output" as an adversarial case that
 *      must be covered.
 */

import { z } from "zod";

import { RUN_ID_PATTERN, TASK_ID_PATTERN } from "./ids.ts";

// --- limits ---------------------------------------------------------------
// Named rather than inlined so they can be asserted in tests and cited in
// docs/protocol.md. CLAUDE.md: "Make timeouts, retry limits, paths, and
// capabilities explicit configuration—not hidden constants."

export const LIMITS = {
  objectiveMaxChars: 16_384,
  summaryMaxChars: 4_096,
  pathMaxChars: 4_096,
  identifierMaxChars: 128,
  profileMaxChars: 128,
  freeTextMaxChars: 2_048,

  maxAllowedPaths: 512,
  maxForbiddenPaths: 512,
  maxCapabilities: 128,
  maxNetworkAllowlist: 256,
  maxDependencies: 128,
  maxInputs: 256,
  maxArtifacts: 512,
  maxFindings: 1_000,
  maxTests: 5_000,
  maxChangedFiles: 10_000,
  maxWarnings: 1_000,

  /** One year. A task claiming more is a misconfiguration, not a long job. */
  maxTimeoutMs: 365 * 24 * 60 * 60 * 1_000,
  maxBudgetUsd: 10_000,
  maxTurns: 10_000,
} as const;

// --- strings --------------------------------------------------------------

/** Rejects NUL, which truncates strings in C-level syscalls. */
const NO_NUL = /^[^\0]*$/;

export const boundedText = (maxChars: number): z.ZodString =>
  z.string().min(1).max(maxChars).regex(NO_NUL, "must not contain NUL");

export const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, "must be a path-safe task identifier");

export const runIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN, "must be a run_<ULID> identifier");

/**
 * `sha256:<64 lowercase hex>`. Digests pin the exact bytes of an input or
 * artifact, so the algorithm is part of the value and not assumed.
 */
export const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex>");

/** RFC 3339 timestamp in UTC. A local-offset timestamp will not order. */
export const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
    "must be an RFC 3339 UTC timestamp ending in Z",
  );

// --- paths ----------------------------------------------------------------

/**
 * A POSIX absolute path with no traversal or normalisation left to do.
 *
 * Deliberately strict: `/a/./b`, `/a/../b`, `/a//b` and `/a/b/` are all
 * rejected rather than normalised. The contract carries canonical paths, so a
 * non-canonical one means the producer skipped a step — failing closed here is
 * cheaper than discovering it after a worker has written somewhere.
 */
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathMaxChars)
  .regex(NO_NUL, "must not contain NUL")
  .refine((value) => value.startsWith("/"), "must be absolute")
  .refine(
    (value) => !value.includes("//"),
    "must not contain empty path segments",
  )
  .refine(
    (value) => value === "/" || !value.endsWith("/"),
    "must not have a trailing slash",
  )
  .refine((value) => {
    const segments = value.split("/");
    return !segments.includes(".") && !segments.includes("..");
  }, "must be canonical: no '.' or '..' segments");

/**
 * A path relative to the worktree root, used for reporting changed files and
 * finding locations. Same traversal rules, but must not be absolute.
 */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathMaxChars)
  .regex(NO_NUL, "must not contain NUL")
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine((value) => !value.includes("//"), "must not contain empty segments")
  .refine((value) => !value.endsWith("/"), "must not have a trailing slash")
  .refine((value) => {
    const segments = value.split("/");
    return !segments.includes(".") && !segments.includes("..");
  }, "must be canonical: no '.' or '..' segments");

// --- git ------------------------------------------------------------------

/** A full 40-character SHA-1. Abbreviations are ambiguous across repos. */
export const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase git SHA");

/**
 * A ref or SHA used as a base. Rejects the shell and refspec metacharacters
 * that would be dangerous if a ref ever reached an argv position unvalidated.
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(LIMITS.identifierMaxChars)
  .regex(
    /^(?!-)[A-Za-z0-9._/-]+$/,
    "must be a plain ref or SHA and must not start with '-'",
  )
  .refine((value) => !value.includes(".."), "must not contain '..'")
  .refine((value) => !value.endsWith(".lock"), "must not end with '.lock'");

// --- durations ------------------------------------------------------------

/**
 * All durations in the contract are milliseconds and carry the `Ms` suffix.
 * The spec expressed timeouts in seconds; the merged contract uses ms so there
 * is exactly one unit in the system.
 */
export const durationMsSchema = z
  .int()
  .positive()
  .max(LIMITS.maxTimeoutMs, "exceeds the maximum supported duration");

// --- type-level drift guards ----------------------------------------------

/**
 * The hand-written `Readonly<{...}>` types are the documentation; the zod
 * schemas are the enforcement. These helpers assert at compile time that the
 * two agree, so adding a field to one without the other fails the build
 * instead of silently producing a schema that validates the wrong shape.
 *
 * Mutual assignability (rather than exact identity) is used deliberately: it
 * still catches a missing `readonly`, because `readonly T[]` is not assignable
 * to `T[]`.
 */
export type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

export type Expect<T extends true> = T;

type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

/**
 * Rewrite `k?: V | undefined` to `k?: V`, recursively.
 *
 * Zod infers optional properties as `V | undefined`, which under
 * `exactOptionalPropertyTypes` is a different type from the `k?: V` the domain
 * types declare. The distinction is meaningless on this contract — JSON cannot
 * carry `undefined`, so a parsed optional field is either absent or a value —
 * but it would defeat the drift guard. Normalising here keeps the domain types
 * honest and the comparison exact.
 */
export type DeepExactOptional<T> = T extends readonly (infer E)[]
  ? readonly DeepExactOptional<E>[]
  : T extends object
    ? {
        [K in Exclude<keyof T, OptionalKeys<T>>]: DeepExactOptional<T[K]>;
      } & {
        [K in OptionalKeys<T>]?: DeepExactOptional<Exclude<T[K], undefined>>;
      }
    : T;

// --- untrusted JSON shape -------------------------------------------------

/** A payload wider than this is a bug or an attack, not a status update. */
export const MAX_PAYLOAD_NODES = 10_000;
/** Bounds recursion in every downstream consumer, including redaction. */
export const MAX_PAYLOAD_DEPTH = 32;

/**
 * Measure a decoded JSON value without recursing.
 *
 * An explicit stack matters here: the input this defends against is a deeply
 * nested payload, and a recursive walk would blow the call stack *while
 * checking for* the thing that blows the call stack. Bails out as soon as
 * either ceiling is exceeded, so a hostile payload costs bounded work.
 */
export function jsonShapeExceeds(
  value: unknown,
  maxNodes: number,
  maxDepth: number,
): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;

    nodes += 1;
    if (nodes > maxNodes || entry.depth > maxDepth) return true;

    const { node, depth } = entry;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node)) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return false;
}

/**
 * An arbitrary JSON object, bounded in node count and nesting depth.
 *
 * Event payloads are normalized from provider output, which CLAUDE.md treats as
 * untrusted. The envelope stays open so a provider can add a field without
 * breaking the contract, but it cannot be unbounded.
 */
export const boundedJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => !jsonShapeExceeds(value, MAX_PAYLOAD_NODES, MAX_PAYLOAD_DEPTH),
    `payload exceeds ${String(MAX_PAYLOAD_NODES)} values or ${String(MAX_PAYLOAD_DEPTH)} levels of nesting`,
  )
  .readonly();

// --- helpers --------------------------------------------------------------

/** Non-empty, duplicate-free array with an explicit ceiling. */
export function uniqueArray<T extends z.ZodType>(
  element: T,
  maxItems: number,
  label: string,
): z.ZodType<readonly z.infer<T>[]> {
  return z
    .array(element)
    .max(maxItems)
    .refine(
      (items) =>
        new Set(items.map((item) => JSON.stringify(item))).size ===
        items.length,
      `${label} must not contain duplicates`,
    )
    .readonly();
}
