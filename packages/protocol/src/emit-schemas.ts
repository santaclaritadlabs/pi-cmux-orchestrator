/**
 * Writes `schemas/*.schema.json` from the zod schemas.
 *
 * Run with `pnpm schemas:emit`. CI does not run it — CI runs the drift test and
 * `git diff --exit-code`, so a forgotten emit fails the build rather than being
 * quietly fixed up.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SCHEMA_FILENAMES,
  buildJsonSchemas,
  type SchemaName,
} from "./json-schema.ts";
import { schemasDirectory } from "./schema-paths.ts";

async function main(): Promise<void> {
  const outDir = schemasDirectory();
  await mkdir(outDir, { recursive: true });

  const schemas = buildJsonSchemas();
  for (const name of Object.keys(SCHEMA_FILENAMES) as SchemaName[]) {
    const target = path.join(outDir, SCHEMA_FILENAMES[name]);
    await writeFile(target, schemas[name], "utf8");
    process.stdout.write(`wrote ${target}\n`);
  }
}

await main();
