/**
 * `@pi-cmux/adapter-fake` — the P1 execution path.
 *
 * The NDJSON reader here is the one every real provider adapter inherits in
 * P3+, so its tolerance for broken streams is the project's answer to provider
 * protocol drift.
 */

export * from "./ndjson-stream.ts";
export * from "./runner.ts";
