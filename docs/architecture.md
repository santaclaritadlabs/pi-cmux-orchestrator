# Architecture

## The one sentence

**Pi decides what to do. `agentd` guarantees it happens.**

Models are good at choosing. They are not a mechanism for guaranteeing state.
PID management, locking, worktrees, retries, timeouts, validation, persistence
and policy therefore live in deterministic code we own, and nowhere else.

## Three planes

```text
                    USER
                     │
              ┌──────▼───────┐
              │     cmux     │   visual plane
              │   cockpit    │   observe · navigate · intervene
              └──────┬───────┘
              ┌──────▼───────┐
              │      Pi      │   decision plane
              │              │   intent · decomposition · routing
              └──────┬───────┘
                     │  local JSON-RPC over a 0600 Unix socket
              ┌──────▼───────┐
              │    agentd    │   execution plane
              │              │   lifecycle · policy · durability · recovery
              └──────┬───────┘
        ┌────────────┼────────────┬─────────────┐
        ▼            ▼            ▼             ▼
     Codex        Claude       Cursor      Antigravity      (adapters)
        └────────────┴────────────┴─────────────┘
                     ▼
                  worktrees                                 (write isolation)
```

### cmux — visual plane

Displays status, logs and navigation, and lets a human intervene. It is
**never a control-plane dependency**: it does not schedule, does not choose
workers, does not parse provider streams, and does not own task state.

The consequence that matters: agent processes do not live inside a cmux pane.
A pane runs `agentd logs --follow <runId>`, so closing a workspace by accident
kills a tail, not a worker. Pi can rebuild the entire UI by asking `agentd`.

### Pi — decision plane

Determines intent, produces task plans, calls `agentd` over RPC, and summarizes
outcomes. Pi holds no authoritative state: no PIDs, no timeouts, no worktrees.
Restarting Pi does not disturb a running execution.

Pi may _propose_ policy-relevant actions. It cannot bypass policy, sandboxing
or approval gates, because it does not execute anything itself.

### agentd — execution plane

The only component allowed to start a worker process. Validates requests,
resolves policy, manages worktrees and sandboxes, launches workers through
adapters, persists lifecycle state, streams normalized events, handles
cancellation, timeouts and recovery, and returns results.

### Adapters — provider edge

Translate one provider's CLI protocol into the project protocol. An adapter
owns process invocation, stream parsing, capability discovery and error mapping
for its provider. It makes no orchestration decisions, never touches another
worker, never creates a worktree, and cannot weaken policy.

Pi must never learn that `--output-format`, `--permission-mode` or `--sandbox`
exist. That is the adapter's business.

## Why workers never talk to each other

Every worker receives an `AgentTask` and returns `AgentEvent`s and one
`AgentResult`. There is no channel between workers, and no field in the result
through which one worker can instruct another — no `commandForNextAgent`, no
`executeThis`, no `instructionsForParent`. The schema rejects them.

The worker reports facts. Pi decides what happens next.

This is the structural defence against prompt injection propagating between
agents: text that a malicious repository gets into one worker's output arrives
at Pi as _data in a summary field_, not as an instruction another worker will
execute.

## Package layout

| Package                       | Owns                                            |
| ----------------------------- | ----------------------------------------------- |
| `packages/protocol`           | The versioned contract. Single source of truth. |
| `packages/observability`      | Structured logging and the redactor.            |
| `packages/testkit`            | Fake worker process, fake clock, fixtures.      |
| `packages/core`               | Lifecycle state machine, run store. _(P1)_      |
| `packages/process-supervisor` | Bounded spawn, cancellation, timeouts. _(P1)_   |
| `packages/policy`             | Fail-closed decisions, path containment. _(P1)_ |
| `packages/worktrees`          | Worktree lifecycle, hardened `git`. _(P2)_      |
| `packages/sandbox`            | Isolation abstraction, host denylist. _(P2)_    |
| `packages/adapters/*`         | One package per provider. _(P1 fake, P3+ real)_ |
| `apps/agentd`                 | The daemon: socket, RPC, recovery, CLI. _(P1)_  |

Dependencies point one way: `protocol` depends on nothing; everything depends on
`protocol`; `core` never imports an adapter.

There is deliberately no `utils` package. Code lives behind the narrowest
boundary that owns it.

## Data flow of one run

```text
Pi ──task.create──▶ agentd
                      │ validate against the protocol schemas
                      │ resolve repoId against the operator allowlist
                      │ resolve policy (default: deny)
                      │ persist task.json + state.json   ← durable before launch
                      ▼
                 WorktreeManager
                      │ audit repository config      ← REPO_UNSAFE if executable
                      │ pin baseRef to a SHA
                      │ claim ownership (O_EXCL)     ← durable before creation
                      │ git worktree add --detach    ← hooks disabled
                      ▼
                 SandboxRegistry
                      │ select a provider for the task's sandbox mode
                      │ refuse denied host paths, unenforceable network
                      ▼
                 ProcessSupervisor
                      │ spawn([...argvPrefix, argv], shell:false, env by allowlist)
                      │ cwd = the worktree
                      │ child stdio ──▶ fd ──▶ runs/<runId>/stdout.ndjson
                      ▼
                  worker process
                      │
                      ▼
                 EventNormalizer  (tails the file, not a pipe)
                      │
                      ▼
              runs/<runId>/events.ndjson   append-only, ordered by sequence
```

### Why the child writes to a file descriptor, not a pipe

`agentd` is not in the data path. The worker's stdout is a file descriptor
pointing at `stdout.ndjson`; the daemon tails that file.

If the daemon dies mid-run and restarts, the worker keeps writing and the
daemon can resume reading from its last persisted offset. With a pipe, a daemon
restart severs the stream and every active run collapses to `ORPHANED` with no
way to learn what happened.

This one decision is most of what makes recovery real rather than aspirational.

## Durable state

```text
~/.local/share/pi-agentd/runs/<runId>/
├── task.json        the exact task, with its protocol version
├── state.json       written tmp → fsync → rename → fsync(dir). Never in place.
├── events.ndjson    append-only, idempotent by sequence
├── stdout.ndjson    raw worker output, written by the worker itself
├── stderr.log
├── result.json      exactly one terminal result
├── metadata.json    pid, process start time, offsets
└── artifacts/
```

`runId` is a ULID, so a directory listing is already in creation order and
recovery can walk runs oldest-first without opening a single file.

## Lifecycle

```text
QUEUED → PREPARING → RUNNING → VALIDATING → SUCCEEDED
                        ├──▶ BLOCKED
                        ├──▶ CANCELLED
                        └──▶ FAILED        VALIDATING ──▶ FAILED

ORPHANED   outcome indeterminate after a restart
```

`ORPHANED` is **not** terminal. A run whose outcome cannot be proven must be
resolved explicitly, with evidence. It is never inferred to have succeeded.

## Related documents

- [`protocol.md`](./protocol.md) — the contract and its compatibility rules
- [`threat-model.md`](./threat-model.md) — what we defend against, and what we do not
- [`adr/`](./adr/) — decisions, with their reasoning and their costs
