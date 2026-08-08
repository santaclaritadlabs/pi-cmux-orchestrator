/**
 * Locates the repository's `schemas/` directory from compiled output.
 *
 * Resolved relative to this module rather than `process.cwd()`, so the emitter
 * and the drift test agree no matter where they are invoked from.
 */

import path from "node:path";

/** `<repo>/packages/protocol/dist` -> `<repo>` */
export function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..", "..");
}

export function schemasDirectory(): string {
  return path.join(repositoryRoot(), "schemas");
}
