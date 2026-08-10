# Implementation Plan: End-to-End Usability (Spec #2546)

## Overview

Close the gap between the current repo state and a **usable end-to-end** orchestrator per Engram spec [#2546](architecture/usability-gap-spec). Four deliverables in dependency order: (1) `packages/cmux` bridge toward the external cmux CLI/socket API, (2) a written pi-extension distribution decision, (3) P5 adapter hardening close-out (sandbox excluded), and (4) first release tag with green CI.

**TDD policy:** Every implementation task is preceded by a RED test task. No production code until the corresponding test fails for the right reason. Verification gate for every task: `pnpm --filter <pkg> test` (focused) and `pnpm verify` at checkpoints.

**Out of scope (explicit, per #2546):** real sandbox isolation provider (ADR 0011), building cmux itself, native Windows, adapters beyond the existing four + fake, per-package npm versioning, weakening sandbox policy.

## Current State (baseline)

| Area                                        | Status                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cmux/`                            | **Missing** — spec calls for it; only `CmuxStatusSink` contract exists in `apps/pi-extension/src/cmux-consumer.ts`                          |
| `CmuxStatusConsumer`                        | Implemented + unit-tested in pi-extension; text sink only, no real cmux socket                                                              |
| Adversarial fixtures                        | Exist in `fixtures/adversarial/`; exercised by `testkit` + **fake** runner only                                                             |
| Codex/Claude/Cursor/Antigravity normalizers | Provider fixtures + partial malformed handling; **no** adversarial corpus per adapter                                                       |
| Codex/Claude/Cursor/Antigravity runners     | argv/cancel/result tests; **no** hung-CLI, malicious-path, or adversarial-stream tests                                                      |
| Runbooks                                    | `docs/runbooks/recovery.md` and `audit-review.md` written; recovery has `recovery.test.ts`; audit trail not integration-verified end-to-end |
| Release                                     | ADR 0009 + CI `release` job exist; **no** `vX.Y.Z` tag published yet                                                                        |
| pi-extension distribution                   | Undecided (ADR 0009 defers to operational decision)                                                                                         |

## Architecture Decisions

- **`packages/cmux` is a bridge, not a UI.** Same boundary role as `pi-extension` toward `agentd`: consumes `CmuxStatusSink`, talks to cmux's existing CLI/Unix socket API, never schedules tasks or owns lifecycle.
- **Headless must keep working.** cmux package is optional; agentd + pi-extension operate without it.
- **Security invariants are test-enforced:** `CMUX_SOCKET_MODE=cmuxOnly` (never default `allowAll`); `CMUX_SOCKET_PATH` / `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` never reach workers (already enforced in sandbox; cmux package must not regress).
- **Fake-first transport.** cmux socket client gets a fake/in-memory transport for CI; real cmux integration validated manually behind an opt-in env gate (same pattern as adapter e2e).
- **pi-extension stays workspace-internal** unless ADR explicitly decides otherwise — recommend internal + README (aligns with ADR 0009: only `@pi-cmux/agentd` publishes).

## Task List

### Phase 0: Decisions (no code, unblocks Phase 4)

- [ ] **Task 0:** pi-extension distribution ADR addendum

### Phase 1: cmux integration package

- [ ] **Task 1:** Package scaffold + security contract tests (RED)
- [ ] **Task 2:** cmux transport abstraction + fake socket (RED → GREEN)
- [ ] **Task 3:** Status projection sink — `CmuxStatusSink` → cmux API (RED → GREEN)
- [ ] **Task 4:** Workspace/surface lifecycle (RED → GREEN)
- [ ] **Task 5:** Log tail surface — `agentd logs --follow` (RED → GREEN)
- [ ] **Task 6:** Headless regression guard (RED → GREEN)

### Checkpoint: cmux bridge

- [ ] `pnpm --filter @pi-cmux/cmux test` green
- [ ] Manual smoke: cmux running locally, bridge creates workspace + updates status
- [ ] Manual smoke: agentd + pi-extension work with cmux package **not** loaded

### Phase 2: Adapter hardening close-out

- [ ] **Task 7:** Shared adversarial + path fixtures (RED baseline)
- [ ] **Task 8:** Codex adversarial tests (RED → GREEN)
- [ ] **Task 9:** Claude adversarial tests (RED → GREEN)
- [ ] **Task 10:** Cursor adversarial tests (RED → GREEN)
- [ ] **Task 11:** Antigravity adversarial tests (RED → GREEN)
- [ ] **Task 12:** Runbook verification (RED → GREEN)

### Checkpoint: hardening

- [ ] All four adapters pass adversarial corpus in CI
- [ ] Runbook claims match tested behavior

### Phase 3: Release execution

- [ ] **Task 13:** Pre-release verification + tag cut
- [ ] **Task 14:** Post-release install smoke

### Checkpoint: Complete (Definition of Done #2546)

- [ ] All seven DoD criteria from spec #2546 met
- [ ] `pnpm verify` green on main
- [ ] Human review before closing

## Risks and Mitigations

| Risk                                       | Impact | Mitigation                                                                                              |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| cmux external API undocumented in repo     | High   | Read `pi-cmux-orchestrator-spec.md` §13–§14; spike with fake transport first; manual gate for real cmux |
| Adversarial gaps differ per provider       | Med    | Shared fixture corpus + per-adapter normalizer/runner tests; follow fake runner pattern                 |
| Release requires NPM_TOKEN secret          | Med    | Verify bundle locally with `agentd verify` before tag; document secret setup in release checklist       |
| cmux package accidentally becomes required | High   | Explicit headless regression test (Task 6); optional dependency in workspace                            |

## Open Questions

1. **cmux API surface:** Confirm exact socket message schema / CLI subcommands from running cmux instance (not fully specified in repo). Task 2 spike resolves this.
2. **First version number:** Recommend `v0.1.0` (pre-1.0, signals MVP). Confirm before Task 13.
3. **pi-extension internal vs publish:** Recommend internal-only per ADR 0009; confirm in Task 0.

## Parallelization

| Safe in parallel                                  | Must be sequential                   |
| ------------------------------------------------- | ------------------------------------ |
| Tasks 8–11 (per-adapter adversarial) after Task 7 | Phase 1 tasks 1→6 (dependency chain) |
| Task 0 (ADR) alongside Task 1                     | Task 13 after all prior phases       |
| Task 12 runbook tests alongside 8–11              |                                      |

## Reference

- Spec: Engram #2546 (`architecture/usability-gap-spec`)
- Technical detail: `pi-cmux-orchestrator-spec.md` §13 (cmux design), §14 (socket security), P4 (cmux primitives)
- Governing constraints: `CLAUDE.md`, `docs/threat-model.md`, ADR 0009, ADR 0011
