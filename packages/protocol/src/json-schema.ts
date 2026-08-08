/**
 * JSON Schema emission.
 *
 * The files under `schemas/` exist so a non-TypeScript consumer (an operator
 * inspecting a `task.json` on disk, a future adapter in another language, an
 * editor validating a hand-written fixture) can read the contract.
 *
 * **They are documentation, not enforcement.** JSON Schema cannot express the
 * cross-field invariants that matter most here — that `mayCommit` implies
 * `mayWrite`, that `networkAllowlist` is non-empty exactly when `network` is
 * `allowlist`, that a non-success result must carry a failure whose
 * `retryable` agrees with the taxonomy. Those live only in the zod
 * `superRefine` blocks. Anything validating input for real must use the zod
 * schemas via `packages/protocol`'s codecs.
 *
 * The committed files are checked against this emitter by a test, so the
 * serialized contract cannot silently drift from the enforced one.
 */

import { z } from "zod";

import { agentResultSchema } from "./agent-result.ts";
import { agentEventSchema } from "./event.ts";
import { agentTaskSchema } from "./task.ts";

export const SCHEMA_FILENAMES = {
  task: "task.schema.json",
  event: "event.schema.json",
  result: "result.schema.json",
} as const;

export type SchemaName = keyof typeof SCHEMA_FILENAMES;

const SOURCES = {
  task: agentTaskSchema,
  event: agentEventSchema,
  result: agentResultSchema,
} as const satisfies Record<SchemaName, z.ZodType>;

const TITLES = {
  task: "AgentTask",
  event: "AgentEvent",
  result: "AgentResult",
} as const satisfies Record<SchemaName, string>;

function build(name: SchemaName): Record<string, unknown> {
  const generated = z.toJSONSchema(SOURCES[name], {
    // Refinements and cross-field checks have no JSON Schema equivalent.
    // Emitting `any` for them is honest; throwing would just block emission of
    // the parts that *are* representable.
    unrepresentable: "any",
    io: "output",
  });

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: TITLES[name],
    description:
      `Serialized shape of ${TITLES[name]} (protocol version 1). ` +
      "Structural only: cross-field invariants are enforced by the zod " +
      "schemas in @pi-cmux/protocol and are NOT expressible here. Do not " +
      "use this file as the sole validation of untrusted input.",
    ...generated,
  };
}

export function buildJsonSchemas(): Record<SchemaName, string> {
  const out: Partial<Record<SchemaName, string>> = {};
  for (const name of Object.keys(SCHEMA_FILENAMES) as SchemaName[]) {
    // Two-space indent with a trailing newline: matches Prettier's JSON output
    // so the committed files are stable under any formatter run.
    out[name] = `${JSON.stringify(build(name), null, 2)}\n`;
  }
  return out as Record<SchemaName, string>;
}
