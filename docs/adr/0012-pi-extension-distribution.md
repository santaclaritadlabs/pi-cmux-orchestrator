# ADR 0012 — pi-extension stays workspace-internal

**Status:** accepted · 2026-08-09

## Context

End-to-end usability spec (Engram #2546) requires a written decision on whether
`@pi-cmux/pi-extension` is published to npm or consumed only from this monorepo.
ADR 0009 already decided that **one** public artifact ships (`@pi-cmux/agentd`);
every other `@pi-cmux/*` package stays `private: true` permanently unless a
later ADR explicitly expands the release boundary.

`@pi-cmux/pi-extension` is a first-party Pi bridge: it connects Pi's command
surface to the local `agentd` RPC socket. It is not a daemon, not a worker
launcher, and not required for headless operation. Pi itself is installed and
updated by the operator outside npm; the extension is loaded from a path Pi
trusts, not fetched as an independent semver product today.

Publishing the extension would imply semver guarantees, npm supply-chain review,
and a consumption story (`npm install @pi-cmux/pi-extension`) that duplicates
what a monorepo checkout already provides with tighter coupling to the exact
`agentd` protocol build under test.

## Decision

`@pi-cmux/pi-extension` **remains workspace-internal** (`private: true`). It is
**not** published to npm alongside `@pi-cmux/agentd`.

The officially supported consumption flow is documented in
`apps/pi-extension/README.md`:

1. Clone this repository (or use an approved worktree checkout).
2. Run `pnpm install:pi-extension`; it runs `pnpm install --frozen-lockfile`,
   waits for completion, runs `pnpm build`, waits for completion, and then
   writes a loader into `~/.pi/agent/extensions`.
3. For a custom extension directory, pass `--target` or `PI_EXTENSION_DIR` and
   add the generated loader to Pi's `extensions` settings.
4. Alternatively, import `@pi-cmux/pi-extension` from within another
   first-party extension in the same checkout.

No additional `@pi-cmux/*` package is published without a new ADR.

## Consequences

- Release CI continues to publish only `@pi-cmux/agentd` (ADR 0009 unchanged).
- Operators who want Pi integration build from source; they are not blocked on
  npm for the extension.
- `@pi-cmux/cmux` (visual bridge toward external cmux) also stays internal;
  cmux integration is optional and must not become a runtime dependency of
  `agentd` or `pi-extension`.
- If a future need arises to ship the extension independently (e.g. Pi marketplace
  with semver pinning), that requires a new ADR revisiting supply-chain review,
  versioning, and the coupling boundary to `agentd`'s RPC contract.

## Related

- ADR 0009 — Release packaging (monolithic tag, single npm package)
- Engram #2546 — End-to-end usability deliverable 2
- `apps/pi-extension/README.md` — supported consumption flow
