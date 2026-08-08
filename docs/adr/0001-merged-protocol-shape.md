# ADR 0001 — Merged protocol shape

**Status:** accepted · 2026-08-08

## Context

The project is specified by two normative documents that disagree.

`CLAUDE.md` declares:

```ts
protocolVersion: "1"; taskId; workspace { repoId, worktreePath, baseRef };
worker { kind, profile }; constraints { allowedPaths, network: "deny"|"allow",
sandbox, maxDurationMs, capabilities }
```

`pi-cmux-orchestrator-spec.md` §8 declares:

```ts
version: 1; id; role; workspace { repo, worktree, baseCommit };
constraints { allowedPaths, forbiddenPaths, network: "none"|"allowlist"|"default",
mayWrite, mayCommit, mayPush }; limits { softTimeoutSeconds, hardTimeoutSeconds };
dependencies; resultSchema
```

Events and results diverge similarly (`seq`/`sequence`, `data`/`payload`,
`success`/`succeeded`).

`CLAUDE.md` states that it overrides and that conflicts must be surfaced rather
than improvised. This was surfaced and decided by the user.

## Decision

Merge, with a clear rule for each side:

- **Naming and versioning follow `CLAUDE.md`**: `protocolVersion: "1"`,
  `taskId`, `sequence`, `payload`, `status: "succeeded"`.
- **Capability fields come from the spec**: `role`, `limits`, `dependencies`,
  `forbiddenPaths`, `mayWrite`/`mayCommit`/`mayPush`, `findings`, `tests`,
  `changedFiles`.

Two consequences that are not simply "take both":

1. **All durations are milliseconds**, suffixed `Ms`. The spec used seconds.
   A system whose job is enforcing timeouts cannot carry two units.
2. **`mayPush` is `z.literal(false)`**, not a boolean with a check. The spec
   says workers never push; making `true` unrepresentable is stronger than
   validating it away.

`worker.kind` gains `"fake"`, because P1's only execution path is the fake
adapter and a run recorded against it must be representable in durable state
and in the audit trail.

`resultSchema` from the spec is dropped: per-task result schemas would let a
task widen its own contract, which is the opposite of what the strict result
schema is for.

## Alternatives rejected

**`CLAUDE.md` verbatim.** Smallest and strictest, but loses `role`,
`limits`, `dependencies`, `findings` and `tests` — all of which the task DAG and
routing in P3/P4 need. We would have added them back later as a breaking change.

**Spec verbatim.** Would require editing `CLAUDE.md`, the document that declares
itself authoritative, as a side effect of a protocol decision.

## Consequences

- Neither source document matches the code exactly. This ADR and
  `docs/protocol.md` are the reconciliation, and both are linked from the
  protocol source.
- The hand-written types and the zod schemas are kept in agreement by a
  compile-time `MutuallyAssignable` guard, so drift fails the build.
- `exactOptionalPropertyTypes` and zod disagree about optional properties
  (`k?: V` versus `k?: V | undefined`). A `DeepExactOptional` helper normalises
  for the comparison. The distinction is meaningless on this contract because
  JSON cannot transmit an explicitly-undefined property.
