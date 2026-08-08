# ADR 0005 — P1 supervises a real process, but a fake worker

**Status:** accepted · 2026-08-08

## Context

Spec P1 lists `CodexAdapter` alongside the RPC server, run store, process
supervisor, cancellation, timeouts and recovery — "conseguir primero
`Pi → agentd → Codex` completamente estable".

`CLAUDE.md` P1 says "fake adapter, and read-only task execution model", and puts
the first real adapter in P3 with "bounded process supervision".

The disagreement is about what P1 must prove.

## Decision

P1 supervises a **real process** running a **fake worker**.

`packages/testkit/src/replay.ts` is a genuine child process: real `spawn`, real
file descriptors, real signals, real exit codes. Only the provider is
simulated. The process supervisor built against it is the same one Codex will
use in P3 — nothing is stubbed on our side of the boundary.

The fake worker reproduces the process-level failure modes that matter:

| Flag                                     | Exercises                          |
| ---------------------------------------- | ---------------------------------- |
| `--hang`                                 | hard timeout                       |
| `--ignore-sigterm`                       | SIGTERM → SIGKILL escalation       |
| `--partial-line`                         | a record cut off mid-write         |
| `--malformed`                            | unparseable lines mid-stream       |
| `--duplicate-sequence`, `--out-of-order` | ingestion idempotency              |
| `--flood-bytes`                          | the output ceiling                 |
| `--no-terminal-event`                    | completion that cannot be inferred |
| `--exit-code`                            | nonzero exit                       |

Policy in P1 additionally rejects `mayWrite`, `mayCommit`, `sandbox: required`
and `network !== "deny"`, keeping the phase inside `CLAUDE.md`'s read-only
execution model while leaving the gates written for P2/P3.

## Alternatives rejected

**Include the real `CodexAdapter` in P1.** Follows the spec literally, but
contradicts `CLAUDE.md` twice (P1's fake adapter, P3's first adapter), and makes
the cancellation and timeout tests depend on credentials, network and a
provider's mood. Tests that need money to run get skipped, and a skipped
recovery test is worse than none.

**Fake the supervisor too (in-process adapter).** Cheaper, and proves nothing.
Cancellation, signal escalation and restart recovery are exactly the behaviours
that only exist at the process boundary.

## Consequences

- Cancellation, both timeouts, signal escalation, output limits and restart
  recovery are all tested — offline, deterministically, with no credentials.
- P3's job shrinks to writing a Codex adapter against an already-proven
  supervisor, rather than building both at once.
- `"fake"` is a first-class `worker.kind` in the protocol (see ADR 0001), so a
  run against it is representable in durable state and in the audit trail.
- `Pi → agentd → Codex` end-to-end does not exist at the end of P1. That is the
  spec's stated P1 goal and it is deliberately deferred to P3.
