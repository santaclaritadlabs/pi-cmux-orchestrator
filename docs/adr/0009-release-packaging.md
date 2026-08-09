# ADR 0009 — Release packaging: one public bundle, monolithic tag versioning

**Status:** accepted · 2026-08-09

## Context

P5 called out release packaging as unscoped. Before this decision nothing
published `agentd` anywhere: every `package.json` in the workspace was
`private: true`, there was no version, publish, or release script, no
Dockerfile, no changesets, and CI had no write-scoped job.

The question was narrowed with an explicit audience and constraints:
OSS, Node 22+ assumed (the whole orchestrator is Node; a self-contained
binary for `agentd` alone would be false simplicity), runs on a laptop or in
CI rather than on a server (which rules out Docker as the _runtime_),
success is measured as install simplicity plus local/CI parity, and the
decision was needed now rather than deferred further.

## Decision

Publish **one** public package, `@pi-cmux/agentd`, to npm. Every internal
`@pi-cmux/*` package (`core`, `protocol`, `policy`, the adapters, `testkit`,
etc.) stays `private: true` permanently — the workspace is a build-time
concept, not a release boundary, and nothing about publishing `agentd`
requires publishing them too.

- **Bundling.** `apps/agentd/scripts/bundle.mjs` (esbuild) inlines every
  `@pi-cmux/*` workspace dependency into `apps/agentd/bundle/cli.js`, and
  also writes `apps/agentd/bundle/package.json` — a minimal manifest with no
  `dependencies` and no `exports`, not a copy of the dev one. `pnpm publish`
  is pointed at that directory via `publishConfig.directory` in the dev
  manifest, so the published tarball's own `package.json` is that minimal
  one, never the dev manifest's. This is load-bearing, not cosmetic: the dev
  manifest's `dependencies` lists every `@pi-cmux/*` workspace package (so
  `tsc`/pnpm can link them locally), and every one of those is `private:
true` — publishing that list verbatim would make `npm install
@pi-cmux/agentd` try to fetch packages that were never pushed to the
  registry and fail outright. The dev manifest's own `bin`/`exports` still
  point at `dist/cli.js` unchanged, for local development only; they carry
  no weight for what gets published once `publishConfig.directory` is set.
- **Versioning.** Monolithic, and it lives in the git tag, not in a
  committed file. `apps/agentd/package.json`'s `version` field stays
  `0.0.0` in the repository; the release CI job overwrites it in its own
  checkout from the pushed `vX.Y.Z` tag immediately before publishing,
  and commits nothing back. There is no per-package versioning and no
  changesets — one tag, one version, for the one thing that gets published.
- **CI.** `.github/workflows/ci.yml` gained a `release` job, gated on
  `refs/tags/v*`, `needs: verify` (the tagged commit must pass the same
  gate as everything else), running in its own `contents: write` scope
  that `verify` and `commitlint` do not inherit.
- **`agentd verify`** is a new CLI subcommand: an in-process smoke test that
  boots the daemon's real components (`RunStore`, `WorktreeManager`,
  `RepositoryRegistry`, `SandboxRegistry`, `Orchestrator`) against a scratch
  git repository and a `worker.kind: "fake"` task, with no RPC socket, and
  asserts the run reaches `SUCCEEDED`. It exists to catch what typechecking
  and the unit/integration suite cannot: a bundler changing what a module's
  _own_ runtime location resolves to. It does not repeat `pnpm verify`
  (format/lint/typecheck/test) — that gate is unchanged and still required
  before `release` runs. CI runs `agentd verify` against the exact tagged
  bundle right before publishing it.
- **GitHub Releases with a checksummed tarball are deferred**, not
  rejected — additive once there is a reason to pin by SHA rather than by
  npm's own integrity metadata. The `release` job's `contents: write`
  permission is granted now so that addition is a diff later, not a
  permissions change.

## A concrete risk this decision surfaced

Bundling a daemon that spawns child processes was flagged up front as the
main technical risk — specifically `node:` builtins, `__dirname`-equivalents,
and dynamic imports fighting the bundler. A spike (bundle, then run a real
task through the bundle) found exactly one instance, and it was real:
`@pi-cmux/testkit`'s `replayWorkerPath()` locates its worker script via
`import.meta.dirname`, relative to _its own_ compiled module. Bundling moves
that code into `cli.js`, so at runtime the lookup resolved to `cli.js`'s own
directory instead of `testkit`'s — the fake adapter's worker failed to spawn
(`WORKER_EXITED_NONZERO`) on every task, including `agentd verify`'s own.

No source in `packages/testkit` or `packages/adapters/fake` needed to
change. `import.meta.dirname` in bundled code is not wrong, it is honest —
the module boundary really did move. So `scripts/bundle.mjs` bundles
`packages/testkit/src/replay.ts` a **second time**, on its own, to
`bundle/replay.js`, landing it as a real sibling of `bundle/cli.js`. The
existing lookup then resolves correctly with no special-casing, because it
was always relative to "wherever this code is actually running" — that now
happens to be the same directory for both files.

This is why `agentd verify` uses the `fake` worker specifically rather than
a synthetic no-op check: it is the one path that exercises this exact class
of failure.

## What this does not decide

- Homebrew, `npx`-first distribution, a self-contained binary without Node,
  and auto-update are all explicitly out — the last is a supply-chain
  prohibition (CLAUDE.md), not a preference.
- Docker is out as a _runtime_ (agentd is meant to run on a developer's
  machine and in CI, not behind a server deployment) but was also
  considered and rejected as a CI/local parity mechanism — `agentd verify`
  against the real bundle already gives that parity with less friction.
- Whether `@pi-cmux/protocol` or another package is ever worth publishing on
  its own is not decided here. Nothing today consumes it outside this
  workspace; if that changes, publishing it is additive and does not revisit
  this ADR.
- The first tag, and whether `pi-extension` is ever part of a release, are
  operational decisions for whoever cuts it, not architectural ones.
