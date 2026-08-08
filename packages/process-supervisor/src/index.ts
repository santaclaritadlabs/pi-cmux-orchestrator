/**
 * `@pi-cmux/process-supervisor` — the only place a worker process is started.
 *
 * argv arrays, no shell, an allowlisted environment, file descriptors instead
 * of pipes, process-group kills, and escalating termination.
 */

export * from "./environment.ts";
export * from "./pid-liveness.ts";
export * from "./supervisor.ts";
