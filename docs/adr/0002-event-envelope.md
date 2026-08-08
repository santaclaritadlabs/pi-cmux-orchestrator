# ADR 0002 — Event envelope: open payload, `runId` in, `agent` out

**Status:** accepted · 2026-08-08

## Context

Spec §7 says every event carries `version, run_id, task_id, agent, seq,
timestamp, type, data`. `CLAUDE.md` declares a flat envelope with
`payload: Record<string, unknown>` and no `runId` or `agent`.

Two questions had to be answered separately: how typed should a payload be, and
which correlation fields belong on the envelope.

## Decision

### The payload stays open, with typed schemas beside it

`AgentEvent.payload` is `Record<string, unknown>`, bounded but unconstrained in
shape. Per-type payload schemas (`statusPayloadSchema`, `logPayloadSchema`, …)
are exported separately and applied on demand by `parseEventPayload`.

This is the one place the contract is deliberately open. A provider gaining a
payload field must not invalidate the envelope, because the envelope is what
carries `sequence` — and `sequence` is what recovery depends on.

The rule that falls out: **a payload that fails its schema does not invalidate
the event.** The record is still valid, still orderable, and must still be
persisted. Only the typed view is unavailable.

### `runId` is on the envelope

A task can be attempted more than once. Events must attribute to the attempt,
not merely to the task, or a retry's events interleave with the original's in
any consumer that groups by `taskId`.

### `agent` is not on the envelope

The spec puts it on every event. We leave it off.

It is derivable from the run's `metadata.json`, and a consumer tailing
`runs/<runId>/events.ndjson` already knows which run it is reading. A
denormalized copy on every record buys nothing and can disagree with the task —
at which point a reader has to decide which one to believe.

## Consequences

- A discriminated union `TypedAgentEvent` is exported for consumers that want
  exhaustive `switch` handling. `@typescript-eslint/switch-exhaustiveness-check`
  makes a missing arm a build failure.
- Envelopes are `strictObject`, so adding an envelope field is a **major**
  version change. Adding a payload field is not. This asymmetry is the point.
- cmux (P4) reads the worker kind from run metadata, not from each event.
- Payloads are bounded at 10,000 values and 32 levels of nesting, measured with
  an iterative walk — a recursive check would overflow on exactly the input it
  is meant to reject.
