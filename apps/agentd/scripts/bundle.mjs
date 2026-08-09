/**
 * Build the artifact that actually gets published: `bundle/cli.js`, with
 * every `@pi-cmux/*` workspace dependency inlined, so `npm install -g
 * @pi-cmux/agentd` needs nothing from this monorepo's workspace linking.
 *
 * `@pi-cmux/testkit`'s replay worker is bundled a second time, on its own,
 * to `bundle/replay.js`. It has to land there as a real sibling file: the
 * fake adapter locates it at runtime via `import.meta.dirname` relative to
 * wherever *its own* code is executing, and after bundling that is this
 * file's directory, not `testkit`'s original one. Skipping this step does
 * not fail the build — it fails the first task a published `agentd` ever
 * runs with `worker.kind: "fake"`, including `agentd verify` itself. See
 * docs/adr/0009-release-packaging.md for why `testkit` ships as a second
 * bundle instead of being marked external.
 *
 * Requires `pnpm build` to have already produced `dist/` for every
 * workspace package (this is a compile step over already-compiled output,
 * not a `tsc` replacement).
 */

import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentdRoot = path.resolve(here, "..");
const repoRoot = path.resolve(agentdRoot, "..", "..");
const outDir = path.join(agentdRoot, "bundle");

async function bundle(entryPoint, outfile, { shebang = false } = {}) {
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "info",
    ...(shebang ? { banner: { js: "#!/usr/bin/env node" } } : {}),
  });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const cliOut = path.join(outDir, "cli.js");
await bundle(path.join(agentdRoot, "dist", "cli.js"), cliOut, {
  shebang: true,
});
// npm sets this on publish, but a local run of `bundle/cli.js` needs it too.
await chmod(cliOut, 0o755);

await bundle(
  path.join(repoRoot, "packages", "testkit", "dist", "replay.js"),
  path.join(outDir, "replay.js"),
);

console.log(`bundled: ${path.relative(repoRoot, outDir)}/{cli.js,replay.js}`);
