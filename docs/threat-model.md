# Threat model

## Baseline assumption

**Every repository is untrusted until proven otherwise.** Repository content is
data, never instruction. That includes `AGENTS.md`, `CLAUDE.md`, READMEs, issue
text, tool output, package scripts, git hooks, and anything an agent writes.

Pi's own documentation is explicit that project trust is _not_ a sandbox, that
extensions run with the user's full permissions, and that prompt injection from
repository files is an expected risk. So the boundary cannot be "Pi decided this
repo was fine".

## Adversaries

| Adversary                  | Capability                                                | Primary defence                                                                     |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Malicious repository       | Arbitrary file content, package scripts, hooks, CI config | No implicit execution; workers sandboxed; content never becomes instruction         |
| Compromised dependency     | Code execution at install or import time                  | `ignore-scripts=true`, exact pins, lockfile, 24h release cooldown                   |
| Compromised worker         | Arbitrary output, arbitrary syscalls within its sandbox   | Output is schema-validated; writes confined; no credentials beyond its own provider |
| Local unprivileged process | Anything the user can do that we do not prevent           | `0700` directory, `0600` socket, token handshake                                    |
| Operator mistake           | Running the wrong thing                                   | Fail-closed defaults; destructive steps gated behind explicit confirmation          |

## What is out of scope

Stated plainly, because an unstated exclusion reads as a claim:

- **A local process running as the same user.** It can read the socket token
  from the filesystem. Unix permissions do not separate a user from themself.
- **A malicious provider CLI binary.** We supervise it; we do not sandbox the
  binary from its own credentials.
- **Kernel or hypervisor escape** from the sandbox layer (P2).
- **The host's own supply chain** — Node, git, the OS.

## Defences

### Nothing loads from a repository into the control plane

No repository may cause an MCP server, Pi extension, Claude/Codex skill, hook,
plugin, shell profile or executable configuration to load into `agentd`. The
control plane's configuration comes from the control plane.

Zero mandatory community extensions ship. First-party integrations are pinned,
reviewed and independently updatable.

### Supply chain

`.npmrc` carries four controls, each load-bearing:

- `ignore-scripts=true` — a compromised transitive package gets no code
  execution merely because we installed it. The project relies on **no**
  lifecycle hooks; every script chains with explicit `&&`.
- `save-exact=true` + committed lockfile — no floating ranges.
- `minimum-release-age=1440` — refuses versions published in the last 24 hours.
  A hijacked package is usually yanked within hours. _This already fired once
  in practice:_ eslint `10.8.1` was 17 hours old and was refused, so the project
  pins `10.8.0`.
- `engine-strict=true`.

CI runs `pnpm install --frozen-lockfile`. It can never resolve a version the
lockfile does not already pin.

### No shell, ever

Commands are spawned with argv arrays and `shell: false`. This is enforced at
lint time, not by convention:

```js
"no-restricted-syntax": [{ selector: "Property[key.name='shell'][value.value=true]" }]
"no-restricted-imports": [{ name: "node:child_process", importNames: ["exec", "execSync"] }]
```

Verified: a probe file using `shell: true`, `exec`, `any` and `enum` produces
four lint errors.

### Worker environment is built, not inherited

A worker's environment is constructed from an explicit allowlist — never
`process.env`. `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`
are removed specifically, so control of cmux never becomes an implicit worker
capability.

Each worker receives only its own provider's credentials. Never
`all credentials → every worker`.

### Never mounted into an untrusted worker

`~/.ssh` · `~/.aws` · `~/.config/gcloud` · `~/.gnupg` · `~/.kube` ·
`~/.git-credentials` · the Docker socket · the cmux socket · GitHub credentials
· production secrets.

Agent configuration is on the list for the same reason credentials are:
`~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/pi`. A worker that can write
another agent's configuration installs a hook, a skill or an MCP server into the
control plane, which is the load path CLAUDE.md forbids.

So is the daemon's own run store, `~/.local/share/pi-agentd`. A worker that can
write `state.json` or `events.ndjson` forges its own audit trail — worse than
reading any credential above. The worktree root is therefore a **sibling** of
the state directory, never a child.

The list has two tiers, because "denied" means two different things. A
credential directory is denied _as a location_: nothing may be inside it and
nothing may enclose it. `$HOME` and `/` are denied only _as a grant_: a write
surface of `/Users/dev` hands over every secret above at once, while
`/Users/dev/projects/wt` is exactly what a run needs. Denying `$HOME` outright
is the obvious rule and leaves the daemon unable to run anything.

The repository is **copied**, not mounted read/write from the host.

### Fail closed

The policy engine's default is deny. If required isolation is unavailable the
task is **rejected** — there is no silent fallback to the host. Unknown protocol
versions, unknown event types and unknown capabilities all fail closed with a
safe error.

### Writes are confined

Every mutable task gets its own worktree, created from an explicit base SHA
recorded durably before launch. Two writers never share a working directory —
the ownership record is created with `O_EXCL`, so a race resolves in the kernel
rather than in a check-then-act window. Workers never push: `mayPush` is
`z.literal(false)`, so the request is not representable.

Path containment is enforced independently of prompt text, and decided on
`realpath`-resolved paths rather than on how a path was spelled.

A worktree is never deleted unless three independent claims agree: the ownership
record names the run asking, it was written for that exact canonical path, and
`git` itself reports the directory as a worktree of the recorded repository.

### `git` is never invoked innocently

`git` executes code on behalf of the repository in more places than is obvious,
and `git worktree add` performs a checkout, which is one of them.

Suppressed from the command line, where `-c` outranks repository config:

| Mechanism          | Forced to                  |
| ------------------ | -------------------------- |
| repository hooks   | `core.hooksPath=/dev/null` |
| filesystem monitor | `core.fsmonitor=false`     |
| `ext::` transport  | `protocol.ext.allow=never` |
| credential helpers | `credential.helper=`       |
| pager              | `core.pager=cat`           |

Neutralised through the environment: `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` point at `/dev/null`, so the operator's `~/.gitconfig`
cannot influence a run. The environment is built from an allowlist, which is
what keeps `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_SSH_COMMAND` and
every future `GIT_*` variable out without having to enumerate them.

What **cannot** be disabled from the command line is a content filter:
`.gitattributes` selects the driver and repository config supplies the command,
and it runs during checkout. So repository config is audited before use, and a
repository declaring `filter.*.smudge`, `core.fsmonitor`, `credential.helper`,
`diff.*.textconv`, `merge.*.driver` or any other executable directive is
refused with `REPO_UNSAFE`. It is not sanitised: a repository that wants a
smudge filter may be entirely legitimate, and deciding that is a policy question
with an operator attached.

### A task cannot name a directory

`AgentTask.workspace` carries a `repoId`, never a repository path. The mapping
from identifier to path is operator configuration (`repositories.json`) and is
an allowlist with no discovery and no search path. Whoever composes tasks does
not get to choose what `agentd` checks out.

### Logs are redacted

One redactor, in `packages/observability`, on every sink. Three layers: key
names, value patterns anchored on vendor prefixes, and truncation. Bounded in
depth and node count, and cycle-safe — a redactor that can be made to hang is
itself the vulnerability.

Patterns are prefix-anchored rather than entropy-based on purpose: entropy
heuristics eat git SHAs and digests, which we log deliberately.

## Known limitations

Recorded because an undocumented gap is worse than a documented one. Each has a
test asserting the current behaviour.

### Socket peer authentication is filesystem permissions plus a token

Node does not expose `LOCAL_PEERCRED` on macOS, so `agentd` cannot verify the
peer's uid at the kernel level. What it actually does:

- socket directory `0700`, socket `0600`
- a per-startup token in a `0600` file, presented in a mandatory `daemon.hello`

This authenticates _"a process that can read a file only this user can read"_ —
not _"a process we approved"_. A local process running as the same user can
read the token. That is the accepted boundary, stated rather than implied.

### Worker liveness depends on `ps`

Recovery answers "is our worker still running?" with two checks: `kill(pid, 0)`
for existence, and `ps -p <pid> -o lstart=` to confirm the process started when
we recorded it starting. The second is what distinguishes our worker from an
unrelated process that inherited a recycled pid.

If `ps` cannot answer, liveness is `"unknown"` and the run is orphaned. That is
the fail-closed direction — an unverifiable process is never treated as ours —
but it is also a **silent degradation**: a platform where the query fails
orphans every surviving worker, and nothing about the outcome says why.

This is not hypothetical. An earlier implementation used `ps -o etimes=`, a
GNU/procps extension that macOS `ps` rejects outright, so on the project's
primary development platform _every_ worker that outlived a daemon restart was
orphaned. It is now `lstart` (absolute, supported on both BSD and GNU) with
`etime` as a fallback, and `packages/process-supervisor/src/pid-liveness.test.ts`
asserts the "alive" path against a real process so a future regression fails
loudly instead of quietly.

### Redaction is best-effort

A secret split across two fields, or one with no recognisable shape, passes
through. There is a test asserting exactly this, so the limitation stays visible
instead of being discovered during an incident.

The control that actually holds is credential minimisation — not giving a worker
a secret it does not need. Redaction is the second line.

### JSON Schema files under-specify

They cannot express cross-field invariants. Every file says so in its own
`description`.

### The only sandbox provider enforces nothing

`HostSandboxProvider` declares `filesystemConfinement`, `networkControl` and
`processIsolation` all `false`, and that is the honest answer: it runs the
worker on the host. What follows from it is the point —

- `sandbox: "required"` cannot be satisfied and the task is refused with
  `SANDBOX_UNAVAILABLE`. The refusal is structural, not a special case: the
  selector picks only from providers whose capabilities satisfy the mode, and
  that set is empty;
- `sandbox: "preferred"` runs, and the selection is reported as `degraded` and
  logged. A task that asked for isolation and did not get it is a fact someone
  should be able to find afterwards;
- `network` other than `deny` is refused with `NETWORK_DENIED`, because a
  provider that cannot restrict network access is not entitled to grant it.

Declaring nothing does not mean enforcing nothing. The host provider still
refuses a write surface reaching the denylist, and still re-checks that every
`allowedPath` is inside the worktree — admission may have been minutes and one
symlink ago.

Until a real provider lands (P5), **untrusted repositories are not adequately
isolated by this daemon**. The controls that do hold are the worktree, path
containment, the built environment, the repository config audit, and the
denylist. None of them contains a worker that has already achieved code
execution on the host.

### Worktrees are not garbage-collected

A released worktree keeps its files, deliberately. Nothing reclaims disk space
on its own, and `listUnreleased` reports claims from a previous incarnation
rather than acting on them: a worktree whose run's outcome is unknown may hold
the only copy of that run's work.

## Adversarial test corpus

`fixtures/adversarial/` is committed and exercised on every CI run:

| Fixture                         | Covers                                                 |
| ------------------------------- | ------------------------------------------------------ |
| `malformed-json.ndjson`         | truncated objects, wrong quoting, prose, blank lines   |
| `partial-line.ndjson`           | a record cut off mid-write, as a killed process leaves |
| `unknown-event-type.ndjson`     | forward-incompatible type — must fail closed           |
| `duplicate-sequence.ndjson`     | same sequence, different content                       |
| `out-of-order-sequence.ndjson`  | arrival order ≠ sequence order                         |
| `missing-terminal-event.ndjson` | completion must not be inferable                       |
| `prompt-injection.ndjson`       | repository text instructing the agent                  |
| `control-characters.ndjson`     | embedded newlines, bidi overrides, escapes             |

The injection fixture asks the worker to set `commandForNextAgent` and to grant
`mayPush`. The tests assert that even a _fully compliant_ worker's result is
rejected by schema.

The fake worker (`@pi-cmux/testkit`) reproduces the process-level cases live:
hang, ignore SIGTERM (forcing SIGKILL escalation), nonzero exit, output flood,
truncated final record.

## Review triggers

Re-read this document when changing: the protocol envelope, the policy engine,
the process supervisor's environment or signal handling, the redactor, the
socket, or anything under `.npmrc`.
