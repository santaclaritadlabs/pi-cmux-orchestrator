import assert from "node:assert/strict";

import type { AgentEvent } from "@pi-cmux/protocol";

import { readFixture } from "./fixtures.ts";

export type AdversarialNormalizeBatch = Readonly<{
  events: readonly AgentEvent[];
  rejected: number;
}>;

export type AdversarialNormalizer = (raw: string) => AdversarialNormalizeBatch;

const TRAVERSAL_PATTERN = /\.\.(?:[/\\]|$)/;
const SECRET_PATTERN = /sk-proj-[A-Za-z0-9]+/;

export function serializedEventsContainParentTraversal(
  batch: AdversarialNormalizeBatch,
): boolean {
  const serialized = JSON.stringify(batch.events);
  return TRAVERSAL_PATTERN.test(serialized);
}

export function serializedEventsContainSecrets(
  batch: AdversarialNormalizeBatch,
): boolean {
  const serialized = JSON.stringify(batch.events);
  return SECRET_PATTERN.test(serialized);
}

/** Baseline survival checks every adapter normalizer must meet. */
export function assertSurvivesAdversarialBatch(
  fixtureName: string,
  batch: AdversarialNormalizeBatch,
): void {
  assert.ok(
    batch.events.length > 0,
    `${fixtureName}: some normalized events must survive`,
  );
  for (const event of batch.events) {
    assert.equal(event.protocolVersion, "1");
  }
}

/** Provider-specific drift/path fixtures require stricter checks (Tasks 8–11). */
function isHardenedFixture(name: string): boolean {
  return name.includes("protocol-drift-") || name.includes("malicious-paths-");
}

/** Stricter checks for drift and malicious-path fixtures (Tasks 8–11). */
export function assertHardenedAdversarialBatch(
  fixtureName: string,
  batch: AdversarialNormalizeBatch,
): void {
  assertSurvivesAdversarialBatch(fixtureName, batch);

  if (fixtureName.includes("protocol-drift-")) {
    assert.ok(
      batch.rejected >= 1,
      `${fixtureName}: hostile drift records must be rejected`,
    );
    assert.equal(
      serializedEventsContainSecrets(batch),
      false,
      `${fixtureName}: provider secrets must not leak into normalized events`,
    );
  }

  if (fixtureName.includes("malicious-paths-")) {
    assert.equal(
      serializedEventsContainParentTraversal(batch),
      false,
      `${fixtureName}: path traversals must not appear in normalized events`,
    );
    assert.equal(
      serializedEventsContainSecrets(batch),
      false,
      `${fixtureName}: sensitive file contents must not leak`,
    );
  }
}

export async function assertSurvivesAdversarialCorpus(
  normalizer: AdversarialNormalizer,
  fixtureNames: readonly string[],
  options: Readonly<{ hardened?: boolean }> = {},
): Promise<void> {
  for (const name of fixtureNames) {
    const raw = await readFixture("adversarial", name);
    const batch = normalizer(raw);
    if (options.hardened === true || isHardenedFixture(name)) {
      assertHardenedAdversarialBatch(name, batch);
    } else {
      assertSurvivesAdversarialBatch(name, batch);
    }
  }
}
