/**
 * Build the artifact that actually gets published: `bundle/`, with every
 * `@pi-cmux/*` workspace dependency inlined into `bundle/cli.js`, so
 * `npm install -g @pi-cmux/agentd` needs nothing from this monorepo's
 * workspace linking.
 *
 * `apps/agentd/package.json`'s `publishConfig.directory` points `pnpm
 * publish` at this directory instead of the package root, which is why this
 * script also writes `bundle/package.json` — a minimal, self-contained
 * manifest, not a copy of the dev one. The dev manifest's `dependencies`
 * lists every `@pi-cmux/*` workspace package so `tsc`/pnpm can link them
 * locally; publishing that list verbatim would tell npm to fetch packages
 * that are `private: true` and never reach the registry, so `npm install
 * @pi-cmux/agentd` would fail outright. The bundle needs none of them at
 * runtime — they are already inlined — so the published manifest declares
 * no dependencies and no `exports` (this is a CLI, not a library; nothing
 * outside this workspace imports `@pi-cmux/agentd` as a module).
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

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentdRoot = path.resolve(here, "..");
const repoRoot = path.resolve(agentdRoot, "..", "..");
const outDir = path.join(agentdRoot, "bundle");

async function bundle(entryPoint, outfile, { shebang = false, define } = {}) {
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "info",
    ...(shebang ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    ...(define ? { define } : {}),
  });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Read the dev manifest up front: the CLI bundle needs its `version` injected
// as a literal (see the `__AGENTD_VERSION__` define below). In the release CI
// job this manifest has already been overwritten from the `vX.Y.Z` tag; in a
// local bundle run it is whatever is committed (`0.0.0` by design — see
// docs/adr/0009-release-packaging.md).
const devManifest = JSON.parse(
  await readFile(path.join(agentdRoot, "package.json"), "utf8"),
);

const cliOut = path.join(outDir, "cli.js");
await bundle(path.join(agentdRoot, "dist", "cli.js"), cliOut, {
  shebang: true,
  define: { __AGENTD_VERSION__: JSON.stringify(devManifest.version) },
});
// npm sets this on publish, but a local run of `bundle/cli.js` needs it too.
await chmod(cliOut, 0o755);

await bundle(
  path.join(repoRoot, "packages", "testkit", "dist", "replay.js"),
  path.join(outDir, "replay.js"),
);

// Everything the dev manifest needs for workspace linking and nothing this
// artifact needs at runtime: no `dependencies` (inlined), no `exports`
// (this is a CLI, not an importable library).
const publishedManifest = {
  name: devManifest.name,
  version: devManifest.version,
  type: devManifest.type,
  description: devManifest.description,
  bin: { agentd: "./cli.js" },
  publishConfig: { access: "public" },
};
await writeFile(
  path.join(outDir, "package.json"),
  `${JSON.stringify(publishedManifest, null, 2)}\n`,
);

console.log(
  `bundled: ${path.relative(repoRoot, outDir)}/{cli.js,replay.js,package.json}`,
);
