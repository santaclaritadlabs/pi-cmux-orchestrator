# Contributing to pi-cmux-orchestrator

Thank you for contributing.

`pi-cmux-orchestrator` is intended to provide a secure, observable, and provider-independent runtime for orchestrating coding CLI agents.

Because the project executes external processes and operates across important security boundaries, correctness, isolation, and auditability take priority over adding features quickly.

## Before Contributing

Please review:

- `README.md`;
- `SECURITY.md`;
- `CODE_OF_CONDUCT.md`;
- [`docs/architecture.md`](docs/architecture.md), which defines component responsibilities and dependency direction;
- [`docs/protocol.md`](docs/protocol.md), the versioned contract for tasks, events, and results;
- relevant Architecture Decision Records under `docs/adr/`;
- [`docs/commits.md`](docs/commits.md).

For substantial architectural changes, open an issue or design proposal before implementation. This includes changes to trust boundaries, protocol versions, process execution, sandboxing, persistence, or component responsibilities.

### Terms

- **Control plane:** deterministic orchestration code that owns task state, policy, and process lifecycle.
- **Worker:** an external provider CLI that performs an assigned task; it is not a trusted control-plane component.
- **Adapter:** the provider boundary that translates one worker's CLI protocol to the common contract.
- **Worktree:** Git write isolation for concurrent tasks, not a security boundary.
- **Fixture:** sanitized, versioned input or output used to reproduce behavior in tests.

## Development Principles

Contributions should preserve these principles:

### 1. Models decide; deterministic code controls state

LLMs may plan, classify, review, and make recommendations.

Deterministic code must control:

- process lifecycle;
- locks;
- worktrees;
- timeouts;
- persistence;
- retries;
- state transitions;
- validation;
- security policies.

### 2. Workers are not trusted control-plane components

Codex, Claude Code, Cursor Agent, Antigravity CLI, and future agents must communicate through provider adapters and normalized contracts.

A worker must not instruct another worker directly.

### 3. Raw agent output is untrusted

Never automatically transform arbitrary worker output into commands for another worker.

Structured results must be parsed and validated before entering orchestration decisions.

### 4. Worktrees are not security sandboxes

Use worktrees to isolate concurrent code changes.

Use an OS-level sandbox, container, VM, or equivalent boundary when executing untrusted code.

### 5. Minimize supply-chain dependencies

Avoid adding dependencies when equivalent functionality can reasonably be implemented with the standard library or existing project dependencies.

Do not introduce community Pi extensions, MCP servers, hooks, agent plugins, or similar executable dependencies into the critical execution path without explicit architectural and security review.

## Repository Structure

[`docs/architecture.md`](docs/architecture.md) is the source of truth for package ownership and dependency direction. At a high level:

```
apps/
  agentd/                 # daemon, local RPC, recovery, CLI

packages/
  protocol/               # versioned common contract
  core/                   # lifecycle state and durable run store
  process-supervisor/     # bounded process execution, cancellation, timeouts
  policy/                 # fail-closed policy and path containment
  worktrees/              # hardened Git worktree lifecycle
  sandbox/                # execution isolation abstraction
  observability/          # structured redacted logs
  testkit/                # fakes and reusable test fixtures
  adapters/               # one package per provider
    codex/
    claude/
    cursor/
    antigravity/

schemas/
fixtures/
tests/
docs/
  adr/
```

`packages/protocol` is the single source of truth for shared messages. Dependencies point inward: the core does not import adapters, and provider-specific details do not enter the protocol. Do not introduce a catch-all `utils` package; put code in the narrowest domain that owns it.

## Setting Up Development

Use the package manager and Node version declared in `package.json` and the repository lockfile:

```sh
pnpm install
pnpm hooks:install
```

The hook installation configures the repository's committed Git hooks; see [`docs/commits.md`](docs/commits.md).

### Reviewing an untrusted fork

Do not run installation or project scripts from an untrusted fork before reviewing its changes. In particular:

1. inspect changes to `package.json`, the lockfile, CI configuration, hooks, and executable scripts;
2. inspect added dependencies, including their installation behavior and transitive executables;
3. avoid real provider, SSH, cloud, or production credentials while evaluating the fork;
4. only install or run scripts after the review establishes they are safe.

Do not commit:

- API keys;
- OAuth tokens;
- provider credentials;
- `.env` files containing secrets;
- CLI authentication files;
- SSH material;
- personal Pi configuration;
- agent run logs containing sensitive information;
- production repository contents.

## Branches

Use a short descriptive branch name such as:

```
feat/codex-adapter
fix/process-cancellation
security/socket-permissions
docs/threat-model
```

## Commits

All commits must follow the Conventional Commit format defined in [`docs/commits.md`](docs/commits.md):

```
type(scope): description
```

Prefer small, logically coherent commits. The description is imperative, lowercase, and has no trailing period. Use a listed scope when a change belongs to one domain.

Examples:

```
feat(protocol): add versioned AgentResult schema
fix(agentd): reap worker after hard timeout
fix(worktrees): reject paths outside repository root
```

## Pull Requests

A pull request must include:

- a concise description and motivation;
- relevant architectural implications, including an ADR or design discussion when applicable;
- tests added or modified and the commands run;
- security implications, including changes to trust boundaries, paths, processes, secrets, network access, or sandboxing;
- compatibility impact on supported CLIs.

For fixes, include reproduction steps when practical. For a new or materially changed adapter, include representative sanitized provider-output fixtures.

Use this checklist in the PR description:

```md
## Summary

## Motivation

## Architecture impact

- [ ] No architectural change
- [ ] Linked ADR or design discussion:

## Security impact

- [ ] No security impact
- [ ] Reviewed paths, process execution, secrets, network access, and sandboxing
- Details:

## Tests and verification

- [ ] Added or updated tests
- Commands run:

## Provider compatibility

- [ ] Not applicable
- [ ] Codex
- [ ] Claude Code
- [ ] Cursor
- [ ] Antigravity
```

### Change requirements

| Change                                      | Minimum evidence                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Protocol or schema                          | Runtime validation, compatibility assessment, codec tests, and fixtures.                                          |
| Lifecycle or persistence                    | Valid and invalid transition tests plus restart/recovery coverage where relevant.                                 |
| Worktree, path, sandbox, network, or policy | Fail-closed behavior and adversarial tests for escapes, denial, or permission boundaries.                         |
| Adapter                                     | Parser fixtures, malformed/duplicate/truncated stream tests, cancellation, timeout, and terminal-result handling. |
| Runtime dependency                          | The dependency information required by [Dependencies](#dependencies).                                             |
| Security fix                                | A lowest-layer regression test whenever reasonably possible.                                                      |

## Tests

Changes to execution or orchestration behavior must include tests at the lowest useful layer.

Before opening a pull request, run the repository verification suite:

```sh
pnpm verify
```

It runs formatting checks, linting, typechecking, and tests. Run focused package tests while developing when they give faster feedback, but `pnpm verify` is the baseline before review. If it cannot be run, state why and which checks were run instead.

Important areas include:

- malformed JSON/NDJSON;
- partial stream records;
- duplicate events;
- unknown event types;
- process crashes;
- cancellation;
- timeouts;
- worktree conflicts;
- dirty Git state;
- daemon restart and recovery;
- agent hangs;
- prompt injection;
- malicious repository instructions;
- permissions and sandbox boundaries.

Security fixes should include a regression test whenever reasonably possible.

### Fixtures

Fixtures must be sanitized: never include credentials, private prompts, personal paths, production repository content, or raw environment values. Provider fixtures should cover the successful path and relevant failures, including malformed or partial output, duplicate records, unknown fields, missing terminal events, and version drift when applicable.

## Protocol Changes

The protocol is versioned and defined only in `packages/protocol`; see [`docs/protocol.md`](docs/protocol.md).

- Validate every untrusted message at runtime before it affects orchestration.
- Preserve the exact protocol version with persisted tasks and results.
- Treat unknown protocol versions, envelope fields, event types, and capabilities as safe failures rather than silently ignoring them.
- Adding an envelope field or otherwise changing an incompatible contract requires a new protocol version and compatibility documentation.
- Do not add provider-specific fields to the common protocol.

## Agent Adapter Requirements

Every agent integration must implement the common `AgentRunner` contract.

Provider-specific behavior belongs inside its adapter. The core orchestrator must not depend directly on provider-specific flags, message formats, model names, or session identifiers.

An adapter must:

- discover or document the supported CLI version and capabilities;
- invoke the provider with bounded arguments, an explicit environment, and no shell interpolation;
- parse and validate structured output before producing normalized events or results;
- map provider failures to safe, provider-independent errors;
- enforce configured output, buffering, timeout, and cancellation limits;
- redact credentials and sensitive prompt or environment data from logs and fixtures;
- handle missing terminal events, malformed output, unexpected fields, duplicate messages, CLI version changes, subprocess termination, and stalled processes.

Adapters report provider facts only. They do not schedule work, create worktrees, access other workers, bypass policy, or turn free-form worker text into instructions for another worker.

## Dependencies

New runtime dependencies require justification.

A pull request adding a dependency should state:

- why it is needed;
- why existing functionality is insufficient;
- its license;
- whether it executes installation scripts;
- whether it introduces transitive executable dependencies;
- its security implications.

Dependencies should use reproducible locked versions.

Avoid dependencies that execute arbitrary installation hooks unless there is a compelling reason and the behavior has been reviewed.

## Security Changes

Do not use a public issue or pull request to disclose an unpatched vulnerability.

Follow `SECURITY.md`.

## License

By contributing to this repository, you agree that your contributions will be licensed under the Apache License, Version 2.0, unless explicitly stated otherwise for content that cannot legally be licensed that way.
