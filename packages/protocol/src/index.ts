/**
 * `@pi-cmux/protocol` — the single source of truth for the wire contract.
 *
 * CLAUDE.md: "Schemas are versioned and backward-compatible within a major
 * version. Persist the exact protocol version with every task."
 *
 * Nothing provider-specific belongs here. Adapters normalize into these types
 * at their edge; core never sees a vendor format.
 */

export * from "./result.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./primitives.ts";
export * from "./run-state.ts";
export * from "./capabilities.ts";
export * from "./task.ts";
export * from "./event.ts";
export * from "./agent-result.ts";
export * from "./codec.ts";
export * from "./ndjson-stream.ts";
export * from "./samples.ts";
