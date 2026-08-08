/**
 * Codecs: the only supported way in and out of the contract.
 *
 * Three rules hold throughout:
 *
 *   1. **Nothing throws.** Every function returns a `Result`. Malformed input
 *      is an expected operational condition, not a defect.
 *
 *   2. **Version is checked before shape.** An unknown `protocolVersion` fails
 *      with `PROTOCOL_VERSION_UNSUPPORTED` rather than a pile of shape errors,
 *      so the operator sees the real problem. Within version "1" the envelopes
 *      are strict: a new envelope field requires a new major version, which is
 *      what makes "backward-compatible within a major version" enforceable
 *      rather than aspirational.
 *
 *   3. **Validation messages never echo the input.** zod renders offending
 *      values into its messages ("expected 'deny', received '<...>'"), and the
 *      input here is untrusted — repository text, provider output, RPC
 *      payloads. `safeMessage` is therefore built from issue *paths* only,
 *      which are structural. The full zod error is kept in `cause`, which
 *      `toWireError` drops.
 */

import type { z } from "zod";

import { agentResultSchema, type AgentResult } from "./agent-result.ts";
import {
  agentEventSchema,
  PAYLOAD_SCHEMAS,
  type AgentEvent,
  type TypedAgentEvent,
} from "./event.ts";
import { makeError, type AgentdError } from "./errors.ts";
import { err, ok, tryCatch, type Result } from "./result.ts";
import { PROTOCOL_VERSION, agentTaskSchema, type AgentTask } from "./task.ts";

/** Longest NDJSON line accepted from a worker, in bytes. */
export const MAX_LINE_BYTES = 1_048_576;

/** Number of issue paths quoted in an error's details. */
const MAX_REPORTED_PATHS = 5;

/**
 * Render zod issues as a structural summary.
 *
 * Only path segments and issue codes are used. Array indices are kept (they
 * locate the problem) but no value is ever interpolated.
 */
function summarizeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const paths = issues
    .slice(0, MAX_REPORTED_PATHS)
    .map((issue) => {
      const path = issue.path
        .map((segment) =>
          typeof segment === "number"
            ? `[${String(segment)}]`
            : String(segment),
        )
        .join(".");
      return path === "" ? `<root>:${issue.code}` : `${path}:${issue.code}`;
    })
    .join(", ");
  return paths;
}

function schemaError(
  label: string,
  error: z.ZodError,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): AgentdError {
  return makeError("SCHEMA_INVALID", `${label} failed schema validation`, {
    details: {
      ...extra,
      issueCount: error.issues.length,
      // Structural only. See the module comment.
      issues: summarizeIssues(error.issues),
    },
    cause: error,
  });
}

/**
 * Read `protocolVersion` without validating anything else.
 *
 * Deliberately tolerant: the whole point is to give a precise answer for input
 * that is otherwise unparseable.
 */
function checkProtocolVersion(
  input: unknown,
  label: string,
): Result<undefined, AgentdError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      makeError("SCHEMA_INVALID", `${label} must be a JSON object`, {
        details: { received: input === null ? "null" : typeof input },
      }),
    );
  }

  const version: unknown = (input as Record<string, unknown>)[
    "protocolVersion"
  ];

  if (version === PROTOCOL_VERSION) return ok(undefined);

  return err(
    makeError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `${label} declares an unsupported protocol version`,
      {
        details: {
          supported: PROTOCOL_VERSION,
          // A version string is a short, structural token; safe to report.
          received:
            typeof version === "string" ? version.slice(0, 32) : "absent",
        },
      },
    ),
  );
}

function parseWith<T>(
  schema: z.ZodType,
  input: unknown,
  label: string,
): Result<T, AgentdError> {
  const versionCheck = checkProtocolVersion(input, label);
  if (!versionCheck.ok) return versionCheck;

  const parsed = schema.safeParse(input);
  if (!parsed.success) return err(schemaError(label, parsed.error));

  // The one assertion CLAUDE.md sanctions: "avoid type assertions except
  // immediately after schema validation." Soundness does not rest on this
  // line. Each message module carries a `MutuallyAssignable` guard proving its
  // schema's output and its domain type are the same shape, and that guard
  // fails the build if either drifts. The only thing zod cannot express is
  // `exactOptionalPropertyTypes`' distinction between `k?: V` and
  // `k?: V | undefined` — a distinction JSON cannot represent either, since
  // there is no way to transmit an explicitly-undefined property.
  return ok(parsed.data as T);
}

export function parseAgentTask(input: unknown): Result<AgentTask, AgentdError> {
  return parseWith<AgentTask>(agentTaskSchema, input, "AgentTask");
}

export function parseAgentEvent(
  input: unknown,
): Result<AgentEvent, AgentdError> {
  return parseWith<AgentEvent>(agentEventSchema, input, "AgentEvent");
}

export function parseAgentResult(
  input: unknown,
): Result<AgentResult, AgentdError> {
  return parseWith<AgentResult>(agentResultSchema, input, "AgentResult");
}

/**
 * Attach a typed payload to a validated event.
 *
 * A payload that does not match its type's schema is a real error, but note
 * what the caller should do with it: the *envelope* is still valid and must
 * still be persisted and ordered. Dropping the event because a provider
 * changed a payload field would lose the sequence, and the sequence is what
 * recovery depends on.
 */
export function parseEventPayload(
  event: AgentEvent,
): Result<TypedAgentEvent, AgentdError> {
  const schema = PAYLOAD_SCHEMAS[event.type];
  const parsed = schema.safeParse(event.payload);

  if (!parsed.success) {
    return err(
      schemaError(`AgentEvent payload for type '${event.type}'`, parsed.error, {
        runId: event.runId,
        sequence: event.sequence,
      }),
    );
  }

  // Safe assertion: the payload schema for `event.type` produces exactly the
  // payload of the matching union member, which `PAYLOAD_SCHEMAS` pins by its
  // `satisfies Record<AgentEventType, ...>` constraint.
  return ok({ ...event, payload: parsed.data } as TypedAgentEvent);
}

// --- NDJSON framing -------------------------------------------------------

/**
 * Decode one NDJSON line.
 *
 * The byte ceiling is enforced *before* parsing, so a hostile 200 MB line
 * costs a length check rather than a parse. CLAUDE.md lists oversized output
 * and malformed NDJSON as required adversarial coverage.
 */
export function decodeJsonLine(
  line: string,
  maxBytes: number = MAX_LINE_BYTES,
): Result<unknown, AgentdError> {
  const byteLength = Buffer.byteLength(line, "utf8");
  if (byteLength > maxBytes) {
    return err(
      makeError("OUTPUT_LIMIT_EXCEEDED", "NDJSON line exceeds the byte limit", {
        details: { byteLength, maxBytes },
      }),
    );
  }

  const trimmed = line.trim();
  if (trimmed === "") {
    return err(
      makeError("MALFORMED_WORKER_OUTPUT", "NDJSON line is empty", {
        details: { byteLength },
      }),
    );
  }

  return tryCatch(
    () => JSON.parse(trimmed) as unknown,
    (cause) =>
      makeError("MALFORMED_WORKER_OUTPUT", "NDJSON line is not valid JSON", {
        details: { byteLength },
        cause,
      }),
  );
}

/**
 * Encode a value as one NDJSON line, terminator included.
 *
 * `JSON.stringify` escapes literal newlines inside strings, so the result is
 * guaranteed to be a single line — the property the append-only event log
 * depends on for its framing to survive a partial write.
 */
export function encodeJsonLine(value: unknown): Result<string, AgentdError> {
  return tryCatch(
    () => `${JSON.stringify(value)}\n`,
    (cause) =>
      makeError("INTERNAL", "value could not be serialized as JSON", { cause }),
  );
}
