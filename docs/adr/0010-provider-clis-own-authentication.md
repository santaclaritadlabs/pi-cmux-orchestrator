# ADR 0010 — Provider CLIs own authentication

**Status:** accepted · 2026-08-09

## Context

The worker launch path was observed to expose the operator's real `HOME`. That
violates the repository security boundary because a worker could reach unrelated
provider sessions, SSH configuration, cloud credentials, sockets, and other
user state. The production path does not currently deliver provider API keys
through the environment, so the confirmed issue is host credential exposure,
not a missing credential-delivery feature.

The project also launches provider CLIs such as Codex and Claude through
adapters. Those CLIs have their own login flows and native credential stores.
The official SDK/API patterns are different: an SDK generally receives an
already-resolved API key or token and sends it in request headers; it does not
usually provide the interactive login and session management of a CLI.

The system prioritizes local-first operation, a small deterministic control
plane, and repositories treated as untrusted input. Adding a generic
`credentials.json`, a broker, or task-scoped temporary token exchange before a
concrete use case exists would increase the attack surface and make `agentd`
provider-specific.

## Decision

Each provider CLI owns its own authentication lifecycle. `agentd` remains
credential-agnostic:

- The operator authenticates each CLI separately using that provider's native
  login, storage, refresh, and logout behavior.
- `agentd` does not implement provider login, read user credential stores, copy
  credentials between providers, mint temporary task credentials, or add a
  generic credential file format.
- A CLI may refresh its own provider session internally. That is provider-owned
  behavior, not an `agentd` authentication feature.
- `agentd` launches the selected CLI with an isolated `HOME` and, when
  configured, only the provider-specific configuration context that the CLI
  needs. It must never fall back to the operator's real `HOME` to find a login.
- If the CLI is not authenticated in the execution context, the task fails
  closed with a safe authentication-unavailable outcome. `agentd` does not
  recover by searching for another credential.

This does not reduce `agentd`'s security responsibilities. `agentd` still owns
worktree and sandbox selection, filesystem and network policy, process
supervision, cancellation, timeouts, output limits, normalized events, durable
state, and redacted audit records.

The immediate security scope is therefore to isolate `HOME` and prevent host
credential exposure. Provider authentication management is deferred until a
specific product or operational use case justifies it.

## Alternatives considered

### Centralized `agentd` credential manager

Rejected for now. It would require a provider-neutral secret model, storage,
rotation, authorization, and audit semantics before the project has a concrete
need. It would also make the control plane responsible for vendor-specific
login behavior.

### Task-scoped temporary credential broker

Rejected for now. A broker could reduce direct token exposure, but it adds a
new protocol and failure mode without being required by the current local-first
use case. Reconsider only when a concrete provider or enterprise workflow
requires it.

### Share the operator's real `HOME`

Rejected. It is simple only by making unrelated host credentials and user
configuration reachable by an untrusted worker. Provider-side controls cannot
repair that local exposure.

### Call provider SDKs directly from `agentd`

Deferred. This would move provider authentication and model execution into the
control plane, changing the adapter boundary and potentially making `agentd`
a holder of provider credentials. It is a possible future architecture, not a
requirement for the current CLI-based adapters.

## Consequences

### Positive

- `agentd` stays small and effective: it supervises execution instead of
  becoming another identity or secret-management system.
- Provider login behavior remains compatible with provider-native CLI updates.
- There is no generic secret format or provider credential schema in the core
  protocol.
- Unauthenticated tasks fail explicitly rather than silently inheriting the
  operator's `HOME` or credentials.
- The security fix can land independently of any future authentication design.

### Negative

- Each CLI must be configured in the context visible to the isolated worker;
  a login that exists only in the operator's normal `HOME` is intentionally not
  enough.
- A provider CLI worker that has access to its own provider session may still be
  able to misuse that session. Provider tasks therefore remain a distinct
  policy decision for untrusted repositories.
- Different CLIs may require different setup mechanisms, configuration paths,
  or OS credential-store behavior.

## Implementation implications

- The worker launch path must use a synthetic or task-specific `HOME` and must
  not expose the real operator `HOME`.
- Provider-specific configuration paths such as `CODEX_HOME` may be supported
  at the adapter boundary when explicitly configured; they must not imply broad
  host filesystem access.
- Provider API-key environment variables must not be inherited from the parent
  environment by default. Existing adapter allowlists for such variables must
  be reviewed against this decision.
- Authentication failures from provider CLIs should be normalized into a safe,
  non-secret failure outcome without logging raw provider output or tokens.
- A future authentication feature must be introduced by a new ADR or a
  superseding ADR with a concrete use case, threat-model analysis, and explicit
  provider scope.

## What this does not decide

- Which provider CLIs are supported or how each one stores its native session.
- Whether a future trusted-worker mode may use provider credentials.
- Whether `agentd` will eventually support a credential broker, workload
  identity, or direct provider SDK integration.
- The exact user-facing setup command for configuring a CLI inside an isolated
  execution context.
