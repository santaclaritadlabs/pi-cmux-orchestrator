# ADR 0004 — TypeScript 6, `node:test`, and a dependency floor

**Status:** accepted · 2026-08-08

## Context

Greenfield repository. The project's thesis is that the control plane should be
small, deterministic and auditable, and `CLAUDE.md` treats every dependency as
supply-chain surface. The toolchain should reflect that rather than fight it.

## Decisions

### TypeScript 6.0.3, not 7.0.2

TypeScript 7 is `latest` — the native compiler, dramatically faster. We pin 6.

`typescript-eslint@8.66.0` declares `peerDependencies.typescript: ">=4.8.4
<6.1.0"`. Its canary (`8.66.1-alpha.10`) declares the same. **No published
version supports TypeScript 7**, so choosing 7 means giving up type-aware lint.

For this project that trade is not close. `no-floating-promises` and
`no-misused-promises` are load-bearing in a daemon built on supervised async
processes: a dropped rejection is a task that never reaches a terminal state,
which is precisely the failure mode `agentd` exists to prevent.

TypeScript 6.0.3 is stable and is the newest release the typed-lint toolchain
supports. Revisit when `typescript-eslint` ships TypeScript 7 support.

### `node:test`, not vitest

Node 22 ships a capable runner. vitest would add vite, esbuild, rollup and
several hundred transitive packages to the dev tree for watch mode and nicer
snapshots. Given the supply-chain stance, the built-in runner wins.

Cost: no watch mode, and tests run against compiled `dist/` output rather than
sources. `--enable-source-maps` keeps stack traces pointing at `.ts`.

### zod, not hand-written validators

`CLAUDE.md` requires runtime validation at every untrusted boundary. zod has
zero runtime dependencies and no install scripts. Hand-writing validators for
three message types plus payload schemas would be more of our own code in the
most security-sensitive position in the system.

### `.npmrc` controls

- `ignore-scripts=true` — a compromised transitive package gets no execution at
  install. **Consequence:** the project relies on no lifecycle hooks at all;
  every script chains with explicit `&&`. (pnpm also disables `pre`/`post`
  scripts by default, so relying on them would be fragile regardless.)
- `save-exact=true`, lockfile committed.
- `minimum-release-age=1440` — refuses anything published in the last 24 hours.
  This fired on the very first install: eslint `10.8.1` was 17 hours old and was
  refused, so the project pins `10.8.0`. The control works.
- `engine-strict=true`, `auto-install-peers=false`.

### `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`

Source imports `./foo.ts`; `tsc` emits `./foo.js`. The specifier names the file
that actually exists on disk, and the door stays open to running sources
directly under Node's type stripping. `erasableSyntaxOnly` keeps that viable —
and is why `enum` is banned at lint level too.

### Security rules encoded in the linter

`CLAUDE.md`'s prose rules are enforced mechanically where possible:

| Rule                   | Mechanism                                     |
| ---------------------- | --------------------------------------------- |
| No shell interpolation | `no-restricted-syntax` on `shell: true`       |
| No `exec`/`execSync`   | `no-restricted-imports`                       |
| No `any`               | `no-explicit-any` + `no-unsafe-*`             |
| Exhaustive unions      | `switch-exhaustiveness-check`                 |
| No dropped promises    | `no-floating-promises`, `no-misused-promises` |

Verified with a probe file: all four fire.

## Consequences

- The entire dev dependency tree is 92 packages.
- CI runs `format:check`, `lint`, `typecheck`, `test`, then
  `git diff --exit-code` to catch un-regenerated JSON Schemas.
- Pinning TypeScript 6 is a deliberate lag. It is recorded here so it reads as a
  decision rather than neglect.
