/**
 * `@pi-cmux/adapter-fake` — the P1 execution path.
 *
 * Shared NDJSON framing lives in `@pi-cmux/protocol`; this package only owns
 * fake-provider invocation and event validation.
 */

export * from "./runner.ts";
