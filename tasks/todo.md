# Task Checklist: End-to-End Usability (Spec #2546)

Tracking artifact: Engram (single task-board observation, topic `architecture/e2e-usability-tasks`).

**Workflow:** RED (failing test) → GREEN (minimal code) → REFACTOR → `pnpm verify` at checkpoints.

---

## Task 0: pi-extension distribution ADR addendum

**Description:** Record the decision on whether `@pi-cmux/pi-extension` is published to npm or stays workspace-internal with a documented consumption flow.

**Acceptance criteria:**

- [x] ADR addendum to ADR 0009 (or new ADR) states publish vs internal decision with rationale
- [x] If internal: `apps/pi-extension/README.md` documents install/consumption from monorepo checkout
- [x] Decision respects ADR 0009 (only `@pi-cmux/agentd` publishes unless explicitly expanded)

**Verification:**

- [x] `pnpm format:check` passes on new docs
- [x] Manual: README steps are reproducible from a clean checkout

**Dependencies:** None

**Files likely touched:**

- `docs/adr/0009-release-packaging.md` (addendum) or `docs/adr/0012-pi-extension-distribution.md`
- `apps/pi-extension/README.md`

**Estimated scope:** Small (1–2 files)

---

## Task 1: cmux package scaffold + security contract tests (RED)

**Description:** Create `packages/cmux/` workspace package with typed client interface and failing tests for security invariants before any transport implementation.

**Acceptance criteria:**

- [x] `@pi-cmux/cmux` package exists with `package.json`, `tsconfig.json`, exports
- [x] `CmuxClient` interface defined: workspace create, surface create, status/progress/log/notification update
- [x] Tests assert: default socket mode is `cmuxOnly`; `allowAll` is rejected; cmux env vars are never accepted as worker config input
- [x] Tests import and validate against `CmuxStatusSink` from `@pi-cmux/pi-extension` (type compatibility)

**Verification:**

- [x] `pnpm --filter @pi-cmux/cmux test` — security + scaffold tests green (RED → GREEN)
- [x] `pnpm typecheck` passes

**Dependencies:** None

**Files likely touched:**

- `packages/cmux/package.json`
- `packages/cmux/tsconfig.json`
- `packages/cmux/src/client.ts`
- `packages/cmux/src/client.test.ts`
- `packages/cmux/src/index.ts`
- `pnpm-workspace.yaml` (if needed)

**Estimated scope:** Medium (3–5 files)

---

## Task 2: cmux transport abstraction + fake socket (RED → GREEN)

**Description:** Implement pluggable transport (Unix socket / CLI invocation) with an in-memory fake for CI. Minimal real transport that speaks cmux's documented protocol.

**Acceptance criteria:**

- [x] `CmuxTransport` interface with `send(command)` / connection lifecycle
- [x] `FakeCmuxTransport` records commands for assertions
- [x] Real transport reads `CMUX_SOCKET_PATH` from environment (cmux bridge process only — never forwarded to workers)
- [x] Tests: fake transport round-trips workspace create + status update commands
- [x] Opt-in integration test gated on `CMUX_E2E=1` (skipped in default CI)

**Verification:**

- [x] `pnpm --filter @pi-cmux/cmux test` green
- [x] Fake transport tests run without network or cmux binary

**Dependencies:** Task 1

**Files likely touched:**

- `packages/cmux/src/transport.ts`
- `packages/cmux/src/transport.test.ts`
- `packages/cmux/src/fake-transport.ts`

**Estimated scope:** Medium (3–5 files)

---

## Task 3: Status projection sink — CmuxStatusSink → cmux API (RED → GREEN)

**Description:** Implement `createCmuxApiSink(client)` that satisfies `CmuxStatusSink` and maps `StatusSnapshot` to cmux status pills, progress, and sidebar updates.

**Acceptance criteria:**

- [x] `createCmuxApiSink` maps run state → cmux status pill text/color
- [x] Progress derived from event count or latest event type (bounded, no unbounded payload)
- [x] Sink is async-safe; a `publish` failure is isolated per snapshot (`CmuxConsumerOptions.onPublishError`) and never aborts the bridge's watch loop. Not literal `Result` failures — `CmuxStatusSink.publish` is `void | Promise<void>` by contract — but the resilience intent this criterion was written for.
- [x] Tests with fake transport verify mapping for terminal and in-flight states
- [x] `CmuxStatusConsumer.follow()` integration test wires bridge → sink → fake transport

**Verification:**

- [x] `pnpm --filter @pi-cmux/cmux test` green
- [x] `pnpm --filter @pi-cmux/pi-extension test` still green (no regression)

**Dependencies:** Task 2

**Files likely touched:**

- `packages/cmux/src/status-sink.ts`
- `packages/cmux/src/status-sink.test.ts`
- `packages/cmux/src/index.ts`

**Estimated scope:** Medium (3–4 files)

---

## Task 4: Workspace/surface lifecycle (RED → GREEN)

**Description:** Implement workspace and surface creation for orchestrator runs: titles, per-worker tail surfaces, control surface for Pi.

**Acceptance criteria:**

- [x] `createRunLayout({ runId, taskId, workerKind, title })` creates cmux workspace + surfaces per spec §13 layout
- [x] Surface titles include run/task identifiers (human-readable, bounded length)
- [x] Idempotent re-call with same runId does not duplicate workspaces
- [x] Tests verify command sequence against fake transport matches spec layout

**Verification:**

- [x] `pnpm --filter @pi-cmux/cmux test` green

**Dependencies:** Task 2

**Files likely touched:**

- `packages/cmux/src/layout.ts`
- `packages/cmux/src/layout.test.ts`

**Estimated scope:** Medium (2–3 files)

---

## Task 5: Log tail surface — agentd logs --follow (RED → GREEN)

**Description:** Tail surface runs `agentd logs --follow <runId>` in a cmux pane (spec §13: worker processes don't need to live inside the pane).

**Acceptance criteria:**

- [x] `createLogTailCommand(runId)` builds argv array (no shell interpolation) for `agentd logs --follow`
- [x] cmux surface configured to run tail command, not embed worker process
- [x] Tests verify argv shape and that closing cmux workspace does not affect agentd run (documented behavior; unit-test command construction)
- [x] Notification helper for terminal state transitions

**Verification:**

- [x] `pnpm --filter @pi-cmux/cmux test` green

**Dependencies:** Task 4

**Files likely touched:**

- `packages/cmux/src/log-tail.ts`
- `packages/cmux/src/log-tail.test.ts`
- `packages/cmux/src/notifications.ts`

**Estimated scope:** Small–Medium (2–4 files)

---

## Task 6: Headless regression guard (RED → GREEN)

**Description:** Prove agentd + pi-extension work without `@pi-cmux/cmux` loaded. cmux remains optional visual client.

**Acceptance criteria:**

- [x] Integration test: pi-extension bridge connects, creates fake task, watches status — **without** importing `@pi-cmux/cmux`
- [x] `@pi-cmux/cmux` is not a dependency of `@pi-cmux/pi-extension` or `@pi-cmux/agentd`
- [x] Document manual headless smoke steps in `packages/cmux/README.md`

**Verification:**

- [x] `pnpm --filter @pi-cmux/pi-extension test` green
- [x] `pnpm --filter @pi-cmux/agentd test` green
- [x] Dependency graph check: cmux not in agentd/pi-extension package.json dependencies

**Dependencies:** Task 3

**Files likely touched:**

- `apps/pi-extension/src/headless.test.ts` (or extend existing)
- `packages/cmux/README.md`

**Estimated scope:** Small (1–2 files)

---

## Checkpoint: cmux bridge

- [x] `pnpm --filter @pi-cmux/cmux test` green (28 pass, 1 skip `CMUX_E2E`)
- [ ] Manual: cmux running, bridge creates workspace + status updates (opt-in `CMUX_E2E=1`)
- [x] Manual: headless agentd + pi-extension without cmux package

---

## Task 7: Shared adversarial + path fixtures (RED baseline)

**Description:** Add missing adversarial fixtures (malicious paths, symlink escape attempts, hung-CLI simulation hooks) and a shared test helper patterned after fake runner's `survives every adversarial fixture`.

**Acceptance criteria:**

- [x] New fixtures: `fixtures/adversarial/malicious-paths.ndjson`, `fixtures/adversarial/protocol-drift.ndjson` (or per-provider drift samples)
- [x] `packages/testkit/src/adversarial.ts` helper: `assertSurvivesAdversarialCorpus(normalizeFn, fixtures, options)`
- [x] Baseline test against protocol-level reader passes; per-adapter hardened corpus tests exist for codex/claude/cursor/antigravity

**Verification:**

- [x] `pnpm --filter @pi-cmux/testkit test` green (46 pass)
- [x] Per-adapter adversarial tests exist (all four adapters GREEN on hardened corpus — normalizers already strip paths/secrets from normalized payloads; Tasks 8–11 may focus on runner hung-CLI / boundary checks)

**Dependencies:** None (parallel with Phase 1 after Task 1)

**Files likely touched:**

- `fixtures/adversarial/malicious-paths.ndjson`
- `fixtures/adversarial/protocol-drift-*.ndjson`
- `packages/testkit/src/adversarial.ts`
- `packages/testkit/src/adversarial.test.ts`

**Estimated scope:** Medium (4–6 files)

---

## Task 8: Codex adversarial tests (RED → GREEN)

**Description:** Codex normalizer + runner survive full adversarial corpus; hung CLI times out; malicious paths rejected at runner boundary.

**Acceptance criteria:**

- [x] `normalizer.test.ts`: survives hardened provider adversarial fixtures
- [x] `runner.test.ts`: rejects cwd outside worktree via `validateWorkerPlacement`; hard timeout on hung process
- [x] Protocol drift fixture handled without crash or secret leak (hardened corpus)

**Verification:**

- [x] `pnpm --filter @pi-cmux/adapter-codex test` green (13 pass)

**Dependencies:** Task 7

**Files likely touched:**

- `packages/adapters/codex/src/normalizer.test.ts`
- `packages/adapters/codex/src/runner.test.ts`

**Estimated scope:** Small (2 files)

---

## Task 9: Claude adversarial tests (RED → GREEN)

**Description:** Same adversarial coverage as Task 8 for Claude adapter.

**Acceptance criteria:**

- [x] Same criteria as Task 8, adapted for Claude stream-json format

**Verification:**

- [x] `pnpm --filter @pi-cmux/adapter-claude test` green

**Dependencies:** Task 7

**Files likely touched:**

- `packages/adapters/claude/src/normalizer.test.ts`
- `packages/adapters/claude/src/runner.test.ts`

**Estimated scope:** Small (2 files)

---

## Task 10: Cursor adversarial tests (RED → GREEN)

**Description:** Same adversarial coverage as Task 8 for Cursor adapter.

**Acceptance criteria:**

- [x] Same criteria as Task 8, adapted for Cursor stream-json format

**Verification:**

- [x] `pnpm --filter @pi-cmux/adapter-cursor test` green

**Dependencies:** Task 7

**Files likely touched:**

- `packages/adapters/cursor/src/normalizer.test.ts`
- `packages/adapters/cursor/src/runner.test.ts`

**Estimated scope:** Small (2 files)

---

## Task 11: Antigravity adversarial tests (RED → GREEN)

**Description:** Same adversarial coverage as Task 8 for Antigravity adapter.

**Acceptance criteria:**

- [x] Same criteria as Task 8, adapted for Antigravity step format

**Verification:**

- [x] `pnpm --filter @pi-cmux/adapter-antigravity test` green

**Dependencies:** Task 7

**Files likely touched:**

- `packages/adapters/antigravity/src/normalizer.test.ts`
- `packages/adapters/antigravity/src/runner.test.ts`

**Estimated scope:** Small (2 files)

---

## Task 12: Runbook verification (RED → GREEN)

**Description:** Verify `docs/runbooks/recovery.md` and `docs/runbooks/audit-review.md` against actual behavior; fix doc drift or add regression tests.

**Acceptance criteria:**

- [x] Recovery runbook claims match `apps/agentd/src/recovery.test.ts` coverage (orphaned, unstoppable, worktree untouched)
- [x] Audit runbook claims match: policy event at sequence 0, rule names from `ruleNames()`, denied tasks still get run record
- [x] New integration test for audit trail symmetry (denied task → sequence-0 policy event)
- [x] Runbook updated where code behavior differed from docs (`RECOVERY_INCOMPLETE` vs success-log `unstoppable`)

**Verification:**

- [x] `pnpm --filter @pi-cmux/agentd test` green
- [x] Manual: operator checklist steps in recovery.md reproducible

**Dependencies:** Tasks 8–11 (can start in parallel, finish after adapters)

**Files likely touched:**

- `apps/agentd/src/audit.integration.test.ts` (new)
- `docs/runbooks/recovery.md`
- `docs/runbooks/audit-review.md`

**Estimated scope:** Medium (2–4 files)

---

## Checkpoint: hardening

- [x] All four adapters pass adversarial corpus in CI
- [x] Runbooks verified against tests
- [x] `pnpm verify` green (local). Caveat: green whenever `os.tmpdir()` is short enough to keep agentd's test sockets under the ~104-byte `sun_path` limit (macOS) — true in a normal shell, not guaranteed under an IDE-injected long `TMPDIR` (e.g. Zed's agent pty). That case now fails loud with the real cause (`apps/agentd/src/daemon.test.ts`'s `startHarness` calls `prepareDaemonDirectories` before starting the server) instead of 32 tests failing on a swallowed `EADDRINUSE`; recovery is `TMPDIR=/tmp pnpm --filter @pi-cmux/agentd test`. See Engram #2544.

---

## Task 13: Pre-release verification + tag cut

**Description:** Final gate, cut first `vX.Y.Z` tag, trigger CI release job.

**Acceptance criteria:**

- [x] `pnpm verify` green on release branch/main (local, feat branch) — same `TMPDIR`-length caveat as the hardening checkpoint above
- [x] Local: `pnpm --filter @pi-cmux/agentd run bundle && pnpm --filter @pi-cmux/agentd run verify`
- [ ] Tag `v0.1.0` (or agreed version) pushed to origin — **blocked:** changes uncommitted; tag must land on `main` after merge
- [ ] CI `release` job green (needs `NPM_TOKEN` secret configured)

**Verification:**

- [ ] GitHub Actions release job succeeds
- [ ] `agentd verify` passes in CI against tagged bundle

**Dependencies:** Tasks 0–12 complete

**Files likely touched:**

- None (operational); optional `docs/runbooks/release.md`

**Estimated scope:** Small (operational)

---

## Task 14: Post-release install smoke

**Description:** Confirm published `@pi-cmux/agentd` installs and runs from npm registry.

**Acceptance criteria:**

- [ ] Clean directory: `npm install @pi-cmux/agentd@<version>` succeeds
- [ ] `npx agentd verify` (or equivalent) passes in clean environment
- [ ] Published tarball contains bundled deps only (no private `@pi-cmux/*` references)

**Verification:**

- [ ] Manual smoke in temp directory with Node 22+

**Dependencies:** Task 13

**Files likely touched:**

- Optional release notes / README update

**Estimated scope:** Small (operational)

---

## Checkpoint: Complete (DoD #2546)

- [x] cmux integration package exists, drives real cmux via CLI/socket API (fake transport + opt-in `CMUX_E2E`)
- [x] Headless regression confirmed (Task 6)
- [x] pi-extension distribution decision documented (Task 0)
- [x] All 4 adapters adversarial-green in CI (Tasks 8–11)
- [x] Runbooks verified (Task 12)
- [ ] `vX.Y.Z` tag published, CI release green (Task 13)
- [ ] `pnpm verify` green on main
