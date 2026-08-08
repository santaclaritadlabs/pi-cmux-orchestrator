# Protocol

`packages/protocol` is the single source of truth. Nothing else defines the
contract, and nothing provider-specific belongs in it.

Current version: **`"1"`**.

## Three messages

| Message       | Direction                   | Cardinality                 |
| ------------- | --------------------------- | --------------------------- |
| `AgentTask`   | Pi → `agentd` → worker      | one per run                 |
| `AgentEvent`  | worker → `agentd` → Pi/cmux | many, ordered by `sequence` |
| `AgentResult` | worker → `agentd` → Pi      | **exactly one**, terminal   |

## Where the shape came from

`CLAUDE.md` and `pi-cmux-orchestrator-spec.md` describe different shapes. The
merged contract takes naming and versioning from `CLAUDE.md` and capability
fields from the spec. See [`adr/0001`](./adr/0001-merged-protocol-shape.md).

One global rule from that merge: **all durations are milliseconds and carry an
`Ms` suffix.** The spec used seconds. Mixing units in a system whose whole job
is enforcing timeouts is how a 300-second limit becomes a 300-millisecond one.

## Rules that hold everywhere

### Versioning

`protocolVersion` is checked **before** shape. An unknown version fails with
`PROTOCOL_VERSION_UNSUPPORTED` rather than a cascade of shape errors, so the
operator sees the real problem.

Within version `"1"` the envelopes are `strictObject`: unknown fields are
rejected, not ignored. Adding an envelope field therefore requires version
`"2"`. That is what makes "backward-compatible within a major version"
enforceable rather than aspirational — an old reader can never be handed a
record it silently half-understands.

The one intentionally open area is `AgentEvent.payload`, so a provider gaining
a field does not invalidate the envelope. Payloads are validated separately, on
demand, by `parseEventPayload`.

### Nothing throws

Every codec returns a `Result`. Malformed input is an expected operational
condition, not a defect. Exceptions are reserved for programmer errors
(`InvariantViolation`).

### Validation errors never echo the input

zod renders offending values into its messages. The input here is untrusted —
repository text, provider output, RPC payloads — so `safeMessage` is built from
issue **paths** only (`constraints.network:invalid_value`). The full zod error
is kept in `cause`, which `toWireError` drops before anything leaves the
process.

Without this, a malicious repository could get arbitrary text into our logs
simply by causing a task to be rejected.

### Everything is bounded

Objectives, summaries, arrays and payloads all carry explicit ceilings, named
in `LIMITS`. Payloads are additionally bounded in node count (10,000) and
nesting depth (32), measured with an iterative walk — a recursive check would
overflow on exactly the input it is meant to reject.

### Paths are canonical or rejected

Every path is absolute (or explicitly relative, for `changedFiles`), free of
NUL, and free of `.`, `..`, `//` and trailing slashes. Non-canonical paths are
**rejected, not normalised**: the contract carries canonical paths, so a
non-canonical one means the producer skipped a step.

`taskId` is charset-restricted for the same reason — it reaches a directory
name, so `../../etc/passwd` must never validate as an identifier.

## `AgentTask`

```text
protocolVersion: "1"
taskId              // path-safe: ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
parentTaskId?
objective
role                // investigate | design | implement | test | review | security-review
workspace   { repoId, worktreePath, baseRef }
worker      { kind: codex|claude|cursor|antigravity|fake, profile }
constraints {
  allowedPaths[], forbiddenPaths[]
  network: deny | allowlist | allow
  networkAllowlist[]
  sandbox: required | preferred | none
  mayWrite, mayCommit
  mayPush: false                    // literal — not representable as true
  capabilities[]
}
limits      { softTimeoutMs, hardTimeoutMs, maxTurns?, budgetUsd? }
dependencies[]
inputs      [{ name, digest, path? }]
```

### Cross-field invariants

Each closes a way a task could be internally inconsistent, which the policy
engine would otherwise have to guess its way through:

- `hardTimeoutMs >= softTimeoutMs`
- `networkAllowlist` is non-empty **exactly when** `network` is `allowlist` —
  an allowlist under `deny` reads as intent that will not be honoured, so it is
  rejected rather than ignored
- `mayCommit` requires `mayWrite`
- `mayWrite` requires at least one `allowedPath` — a writer bounded only by its
  worktree must state its write surface
- a task cannot be its own parent, or its own dependency
- `inputs[].name` is unique

`mayPush` is `z.literal(false)`. A task requesting push cannot be constructed,
let alone validated.

## `AgentEvent`

```text
protocolVersion: "1"
taskId, runId
sequence            // monotonic within a run, from 0
timestamp           // RFC 3339, UTC, must end in Z
type                // status | log | tool | artifact | test | policy | heartbeat
payload             // open, but bounded
```

Two deliberate deviations from spec §7, recorded in
[`adr/0002`](./adr/0002-event-envelope.md): `runId` is present (a task may be
attempted more than once), and `agent` is absent (derivable from run metadata;
a denormalized copy is a field that can drift).

Ordering and idempotency: events are append-only. A repeated `sequence` with
identical content is dropped; a repeated `sequence` with _different_ content is
a `SEQUENCE_CONFLICT`. Parsers do not reorder — ordering is the store's job, and
a parser that silently sorted would hide the anomaly.

Typed payload schemas exist per event type. A payload that fails its schema does
**not** invalidate the envelope: the record is still orderable and must still be
persisted. Dropping it would lose the sequence, and the sequence is what
recovery depends on.

## `AgentResult`

```text
protocolVersion: "1"
taskId, runId
status              // succeeded | failed | cancelled | timed_out | blocked
summary
exitCode?
findings[], tests[], changedFiles[], artifacts[]
changes  { worktreePath, headSha?, dirty }
warnings[]
failure? { code, safeMessage, retryable }
```

### The worker reports facts

There is no `commandForNextAgent`, no `executeThis`, no
`instructionsForParent`. Because the schema is strict, a worker inventing such a
field gets its **result rejected** rather than the field quietly ignored. See
`fixtures/adversarial/prompt-injection.ndjson` and its test.

### Every non-success is attributable

`failure` is required exactly when `status !== "succeeded"` — including
`cancelled` and `timed_out`. "Why did this run not succeed?" is answerable from
the result alone.

`failure.retryable` must agree with the error taxonomy. Otherwise a worker could
mark a `POLICY_DENIED` retryable and drive a retry loop against a fail-closed
decision.

### Claims versus observations

`changedFiles` and `tests` are what the _worker said_. `changes.headSha` and
`changes.dirty` are what _`agentd` observed_. CLAUDE.md: "Do not accept a worker
claim of success as proof."

## Error taxonomy

Codes are a stable public contract — they appear in results, audit events and
RPC responses, so renaming one is a protocol change.

`retryable` and `category` are **derived from the code**, never supplied at the
call site, so they cannot drift between callers. No `policy`-category error is
ever retryable; a test enforces that across the whole catalogue.

## JSON Schema

`schemas/*.schema.json` are generated from the zod schemas and checked by a
drift test plus `git diff --exit-code` in CI. Regenerate with
`pnpm schemas:emit`.

**They are documentation, not enforcement.** JSON Schema cannot express the
cross-field invariants above. Anything validating untrusted input must use the
zod codecs.

## Changing the protocol

1. Change the zod schema and the hand-written `Readonly<{...}>` type. The
   `MutuallyAssignable` guard fails the build if you change only one.
2. Add or update tests, including the adversarial cases.
3. Run `pnpm schemas:emit` and commit the result.
4. Adding an envelope field is a **major** version change. Adding a payload
   field is not.
