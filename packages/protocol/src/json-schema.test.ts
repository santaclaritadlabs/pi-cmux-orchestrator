import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  SCHEMA_FILENAMES,
  buildJsonSchemas,
  type SchemaName,
} from "./json-schema.ts";
import { schemasDirectory } from "./schema-paths.ts";

const names = Object.keys(SCHEMA_FILENAMES) as SchemaName[];

describe("committed JSON Schemas", () => {
  it("matches what the zod schemas emit", async () => {
    // The failure mode this guards against: someone edits a zod schema and the
    // serialized contract under schemas/ keeps describing the old shape.
    const generated = buildJsonSchemas();

    for (const name of names) {
      const file = path.join(schemasDirectory(), SCHEMA_FILENAMES[name]);
      const committed = await readFile(file, "utf8");
      assert.equal(
        committed,
        generated[name],
        `${SCHEMA_FILENAMES[name]} is stale — run \`pnpm schemas:emit\``,
      );
    }
  });

  it("emits deterministically", async () => {
    // A non-deterministic emitter would make the drift check useless: every
    // run would produce a diff.
    const first = buildJsonSchemas();
    await Promise.resolve();
    const second = buildJsonSchemas();
    assert.deepEqual(first, second);
  });

  it("labels itself as structural-only", () => {
    // Anyone reaching for these files to validate untrusted input must be told
    // in the file itself that cross-field invariants are missing.
    const generated = buildJsonSchemas();
    for (const name of names) {
      const parsed: unknown = JSON.parse(generated[name]);
      assert.equal(typeof parsed, "object");
      const doc = parsed as Record<string, unknown>;
      assert.match(String(doc["description"]), /Structural only/);
      assert.equal(typeof doc["title"], "string");
    }
  });
});
