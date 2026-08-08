/**
 * `@pi-cmux/sandbox` — what a worker is allowed to reach, and who enforces it.
 *
 * The abstraction, the host denylist, and a fail-closed selector. Real
 * isolating providers plug in behind {@link SandboxProvider}; nothing in the
 * control plane learns how they work.
 */

export * from "./provider.ts";
export * from "./denied-paths.ts";
export * from "./host.ts";
export * from "./registry.ts";
