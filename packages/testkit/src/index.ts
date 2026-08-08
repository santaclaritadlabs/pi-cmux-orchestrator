/**
 * `@pi-cmux/testkit` — fakes that behave like the real thing.
 *
 * The fake worker is a real process. The fake clock is the only thing that
 * lies, and it lies on purpose so timeout and recovery behaviour is testable
 * without sleeping.
 */

export * from "./harness.ts";
export * from "./replay-options.ts";
export * from "./fixtures.ts";
export * from "./git-fixture.ts";
