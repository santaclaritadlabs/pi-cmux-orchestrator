# ADR 0011 — MVP defers real sandbox isolation

**Status:** accepted · 2026-08-09

## Context

`packages/sandbox` defines a `SandboxProvider` interface (`kind: "none" |
"process" | "vm"`) precisely so a real isolating provider — containers, a
microVM — can be plugged in later without changing `agentd`, the policy
engine, or the adapters. Only `HostSandboxProvider` exists today. It declares
`filesystemConfinement`, `networkControl`, and `processIsolation` all `false`,
which is the honest answer: it runs the worker on the host.

Before this decision, `packages/policy/src/decide.ts` treated that gap as an
unconditional block: the `worker.kind-requires-sandbox` rule demanded
`sandbox: "required"` for the `claude`, `cursor`, and `antigravity` worker
kinds, and `constraints.sandbox` then refused `"required"` whenever
`sandboxAvailable` was false — which it always is, since `sandboxAvailable`
is computed from `SandboxRegistry.canEnforceIsolation()`, and no registered
provider satisfies `satisfiesRequired()`. Net effect: those three worker
kinds could never be admitted by policy, full stop, regardless of what
repository or task was involved. Only `codex` and `fake` could run.

The project is prioritizing an MVP now and deferring the real sandbox
provider (containers, a microVM) as a later, incremental improvement — not
because the risk it addresses stopped mattering, but because building it is
a substantial, separately-scoped piece of work (rootless-vs-rootful,
network-allowlist enforcement, CI without Docker-in-Docker) that would block
the MVP on infrastructure the MVP does not otherwise need.

There is still no repository-trust model. Nothing in this codebase can tell
"a repository the operator chose to run" apart from "a repository someone
else handed the operator" — so this decision is necessarily a blanket one,
not one scoped to "trusted" repositories, because that category does not
exist yet.

## Decision

`worker.kind-requires-sandbox` now admits `sandbox: "preferred"` in addition
to `"required"` for `claude`, `cursor`, and `antigravity`. `"none"` remains
refused.

This is deliberately not a silent fallback. `SandboxRegistry.select()`
already has defined semantics for `"preferred"` without an enforcing
provider: it selects `HostSandboxProvider`, marks the placement `degraded:
true`, and logs it (`packages/sandbox/src/registry.ts`). Every task that
runs under this exception therefore produces an audited fact — "this run
had no real isolation" — rather than either being refused outright or
running unmarked. `"none"` stays refused specifically because it would
discard that record.

The operator is accepting, for the duration of the MVP, that repositories
run against `claude`, `cursor`, and `antigravity` are not isolated from the
host beyond what `HostSandboxProvider` already enforces (worktree
confinement, path containment, the built environment, the denylist, the
repository-config audit — see `docs/threat-model.md`). None of those
controls stop a worker that has already achieved code execution on the
host.

This does not change the `codex` or `fake` worker kinds, and it does not
change `constraints.sandbox`'s refusal of `sandbox: "required"` when
isolation is unavailable — a task that explicitly demands real isolation is
still refused, never silently downgraded.

## Alternatives considered

### Build a real `SandboxProvider` first (containers or a microVM)

Rejected for now, not permanently. This is the actual fix and remains the
plan — `packages/sandbox`'s interface is already shaped for it, and the
`worker.kind-requires-sandbox` rule is written as self-removing so landing a
real provider changes zero policy code. Deferred because it is a
substantial, separately-scoped effort the MVP should not be blocked on.

### Scope the exception to explicitly trusted repositories

Rejected for now. There is no repository-trust concept anywhere in the
codebase — `AgentTask.workspace` only carries a `repoId` resolved through an
operator-configured allowlist with no notion of "trusted" vs "untrusted".
Introducing one is itself nontrivial scope (schema change, policy rule,
`repositories.json` shape, and a threat-model update for what "trusted"
is allowed to mean) and was rejected as premature ahead of the MVP for the
same reason the real sandbox provider was. Worth reconsidering once there is
a concrete reason to distinguish repositories rather than treat all of them
uniformly.

### Leave the block in place and ship the MVP without these adapters

Rejected. The MVP's explicit goal is to exercise the Claude, Cursor, and
Antigravity adapters shipped in P5; leaving the policy gate unconditional
would make that code permanently unreachable until the real sandbox
provider lands, with no path to validate the adapters end-to-end in the
meantime.

## Consequences

### Positive

- Claude, Cursor, and Antigravity worker kinds are reachable for the MVP.
- The exception is audited, not silent: every degraded run is visible in
  the run's policy and sandbox events, not inferred after the fact.
- `worker.kind-requires-sandbox` remains self-removing — no rule change is
  needed when a real provider lands; `"preferred"` simply stops being
  degraded.
- `sandbox: "required"` still fails closed. An operator or caller who
  explicitly asks for real isolation is still refused, never silently
  downgraded to host execution.

### Negative

- Every task run against these three worker kinds executes an unmodified
  provider CLI directly on the host, for every repository, with no
  per-repository trust distinction. `docs/threat-model.md`'s "Every
  repository is untrusted until proven otherwise" baseline is, for these
  three kinds during the MVP, an operating assumption backed only by
  worktree/path/env/denylist controls — not by process isolation.
- This is a time-bounded, not permanent, acceptance. It should be revisited
  the moment a real `SandboxProvider` exists, or sooner if the MVP's
  repository set changes in a way that raises the risk.

## Implementation implications

- `packages/policy/src/decide.ts`: `worker.kind-requires-sandbox` admits
  `sandbox: "required"` or `"preferred"`; refuses `"none"`.
- Callers that submit tasks for these three worker kinds should default
  `constraints.sandbox` to `"preferred"` (already the default task-submission
  path in `apps/agentd/src/cli.ts`) rather than `"required"`, since
  `"required"` will continue to be refused until a real provider exists.
- `docs/threat-model.md`'s sandbox "Known limitations" section is updated to
  state this as an accepted, ADR-recorded exception rather than an implicit
  gap.

## What this does not decide

- What the real sandbox provider will be (containers vs. microVM vs.
  something else) or when it lands.
- Any repository-trust model.
- Whether `sandbox: "preferred"` should remain the default once a real
  provider exists — at that point `"preferred"` starts actually enforcing,
  which is a behavior change worth its own review even without a rule
  change.
