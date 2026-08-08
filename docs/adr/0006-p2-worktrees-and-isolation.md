# ADR 0006 — P2 is worktrees and isolation, not adapters

**Status:** accepted · 2026-08-08

## Context

The two normative documents disagree about P2.

`pi-cmux-orchestrator-spec.md` §P2 lists `ClaudeAdapter`, `CursorAdapter`,
`AntigravityAdapter` and `WorktreeManager` together. `CLAUDE.md` P2 is
"durable worktree management, canonical path enforcement, sandbox abstraction,
and a required-isolation policy for untrusted repositories", and puts the first
real adapter in P3 with the rest in P5.

The intersection both documents support is the worktree and isolation work.

## Decision

P2 delivers `packages/worktrees`, `packages/sandbox`, the repository allowlist,
and the wiring that makes a run's workspace real. No provider adapter is added.

The ordering argument is the same one behind ADR 0005: an adapter is the thing
that runs untrusted provider code inside a worktree, and building three of them
before the worktree can confine anything is building the payload before the
container. Three adapters against an unbounded workspace is three times the
exposure, not three times the progress.

Concretely, P2 turns **writes on**. `WORKSPACE_WRITE_PROFILE` allows `mayWrite`
where `READ_ONLY_PROFILE` denied it, and that permission is earned by the
machinery landing underneath it: a dedicated worktree per run, path containment
proven against the real filesystem, and a sandbox provider that has accepted the
placement. Commits and network stay denied — neither has an enforcement story
yet, and a permission without enforcement is a comment.

## What P2 refuses, and why each refusal exists

| Refusal                       | Because                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `REPO_UNSAFE`                 | repository config that names a program runs it on checkout       |
| `WORKTREE_CONFLICT`           | two writers must never share a working directory (spec §12)      |
| `WORKTREE_OWNERSHIP_UNPROVEN` | deleting an unprovable worktree destroys work nobody can recover |
| `PATH_ESCAPE`                 | a worktree outside the root, or nested with the primary checkout |
| `SANDBOX_UNAVAILABLE`         | `sandbox: "required"` with nothing able to enforce it            |
| `POLICY_DENIED`               | a repository the operator never configured                       |

## Consequences

- Hooks are the sharp edge. `git worktree add` performs a checkout, and a
  checkout fires `post-checkout`. Every invocation forces
  `-c core.hooksPath=/dev/null`, and the test for it asserts against a control
  checkout that _does_ fire the hook — otherwise the test would pass for a
  repository whose hook was never going to run.
- Content filters cannot be disabled from the command line: `.gitattributes`
  selects them and repository config defines the command. So repository config
  is audited before use and an executable directive is a refusal, not something
  to sanitise. See `inspectRepositoryConfig`.
- `AgentTask` carries a `repoId`, not a path, so the identifier→path mapping is
  operator configuration (`repositories.json`). A task cannot name a directory.
- Cleanup is **not** automatic. A finished run's worktree is released — final
  HEAD and dirty state recorded — and the files are kept, because the run an
  operator most wants to inspect is the one that just failed.
- `AgentResult.changes` finally reports something observed. It was previously
  hardcoded `dirty: false`, which was a claim the daemon had no basis for.
- The host denylist has **two tiers**, and the distinction was forced by a
  smoke test rather than reasoned out in advance. Denying `$HOME` outright is
  the obvious rule and makes the daemon unable to run anything: on a
  single-user machine, worktrees live under the home directory. So a
  credential directory is denied _as a location_ — nothing inside, nothing
  enclosing — while `$HOME` is denied only _as a grant_: being handed it whole
  is refused, working inside it is normal. The dangerous children are
  enumerated, so the second tier does not have to cover them by proxy.
- The worktree root is a **sibling** of the state directory
  (`~/.local/share/pi-agentd-worktrees`), not a child. The state directory
  holds the run store and is strictly denied, because a worker that can write
  `state.json` or `events.ndjson` forges its own audit trail — which is worse
  than any credential on the list. A worktree nested inside it would be
  refused by that same rule.

## Alternatives rejected

**Follow the spec and add three adapters.** Triples the amount of untrusted
provider code before there is anything to confine it with, and leaves
`WorktreeManager` — the thing that does the confining — competing for attention
with three protocol parsers.

**Let tasks name a repository path directly.** Simpler, and it makes whoever
composes tasks the authority on which directory `agentd` checks out. Pi is not
a trusted source of filesystem locations.

**Remove the worktree automatically when a run ends.** Tidier, and it deletes
the evidence at exactly the moment it becomes interesting. Cleanup stays
explicit and retryable, as CLAUDE.md requires.
