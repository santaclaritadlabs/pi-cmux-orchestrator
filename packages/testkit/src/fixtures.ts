/**
 * Fixture loading.
 *
 * Fixtures are byte-exact recordings, so they are read as raw text and split
 * only on `\n`. Nothing here normalises, trims or reformats: a fixture that
 * ends without a trailing newline is testing exactly that.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** `<repo>/packages/testkit/dist` -> `<repo>/fixtures` */
export function fixturesDirectory(): string {
  return path.join(import.meta.dirname, "..", "..", "..", "fixtures");
}

export type Provider = "codex" | "claude" | "cursor" | "antigravity";

export function fixturePath(
  group: Provider | "adversarial",
  name: string,
): string {
  return path.join(fixturesDirectory(), group, name);
}

export async function readFixture(
  group: Provider | "adversarial",
  name: string,
): Promise<string> {
  return await readFile(fixturePath(group, name), "utf8");
}

/**
 * Split a fixture into physical lines.
 *
 * A trailing newline yields no final empty element, but a file that ends
 * *without* one yields its last partial record — which several adversarial
 * fixtures depend on.
 */
export function splitLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export const ADVERSARIAL_FIXTURES = [
  "malformed-json.ndjson",
  "partial-line.ndjson",
  "unknown-event-type.ndjson",
  "duplicate-sequence.ndjson",
  "out-of-order-sequence.ndjson",
  "missing-terminal-event.ndjson",
  "prompt-injection.ndjson",
  "control-characters.ndjson",
  "malicious-paths.ndjson",
] as const;

export type AdversarialFixture = (typeof ADVERSARIAL_FIXTURES)[number];

export type AdversarialProvider = "codex" | "claude" | "cursor" | "antigravity";

export const PROVIDER_ADVERSARIAL_FIXTURES: Readonly<
  Record<AdversarialProvider, readonly string[]>
> = {
  codex: ["protocol-drift-codex.ndjson", "malicious-paths-codex.ndjson"],
  claude: ["protocol-drift-claude.ndjson", "malicious-paths-claude.ndjson"],
  cursor: ["protocol-drift-cursor.ndjson", "malicious-paths-cursor.ndjson"],
  antigravity: [
    "protocol-drift-antigravity.ndjson",
    "malicious-paths-antigravity.ndjson",
  ],
};

export function providerAdversarialFixtures(
  provider: AdversarialProvider,
): readonly string[] {
  return PROVIDER_ADVERSARIAL_FIXTURES[provider];
}
