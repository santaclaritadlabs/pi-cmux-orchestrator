# Runbook: worker authentication

Audience: an operator who needs a worker CLI (claude/cursor/antigravity/codex)
to be logged in before `agentd` can use it.

## Why this exists

CLAUDE.md: "Do not mount user home directories, SSH credentials, cloud
credentials, agent configuration, or host sockets into an untrusted worker."
`agentd` does not pass provider API keys to workers, and it does not hand a
worker the operator's real `HOME` either — a worker only ever sees
`~/.ssh/`, `~/.aws/`, and real shell config if something puts them there, and
nothing in `agentd` does.

Instead, each worker kind gets its own persistent, isolated `HOME`:

```
<workerHomeRoot>/<kind>
```

`workerHomeRoot` is `DaemonPaths.workerHomeRoot` — `<stateDir>-worker-home`,
a sibling of the run store, created lazily the first time a run of that kind
launches (`apps/agentd/src/orchestrator.ts`, `#prepareWorkspace`). `<kind>` is
one of `claude`, `cursor`, `antigravity`, `codex`, `fake` — `AgentTask.worker.kind`.

A worker CLI's own login mechanism (OAuth keychain, a session file, a token
under its config directory) persists under that isolated `HOME` exactly as it
would under a real one — `~/.claude/`, `~/.cursor/`, `~/.antigravity/` — so
logging in once against the isolated `HOME` is durable across every future
run of that kind. `agentd` never loads or injects credentials itself; this is
the CLI's own persistent-login mechanism, pointed at a `HOME` the operator
controls instead of their own.

## Logging a worker in

1. Find `workerHomeRoot` for this daemon. With default paths it is
   `~/.local/share/pi-agentd-worker-home` (`resolveDaemonPaths()`,
   `apps/agentd/src/paths.ts`) — one level up from
   `~/.local/share/pi-agentd`, alongside `pi-agentd-worktrees`.
2. Pick the subdirectory for the worker kind you're authenticating, and run
   that kind's real login command with `HOME` overridden. The binaries agentd
   actually spawns (`packages/adapters/*/src/runner.ts`):

   ```
   # Claude Code
   mkdir -p ~/.local/share/pi-agentd-worker-home/claude
   HOME=~/.local/share/pi-agentd-worker-home/claude claude login

   # Cursor (binary name: agent)
   mkdir -p ~/.local/share/pi-agentd-worker-home/cursor
   HOME=~/.local/share/pi-agentd-worker-home/cursor agent login

   # Antigravity (binary name: agy)
   mkdir -p ~/.local/share/pi-agentd-worker-home/antigravity
   HOME=~/.local/share/pi-agentd-worker-home/antigravity agy login

   # Codex
   mkdir -p ~/.local/share/pi-agentd-worker-home/codex
   HOME=~/.local/share/pi-agentd-worker-home/codex codex login
   ```

   Check each adapter's `runner.ts` if the CLI's actual login subcommand or
   flags have since changed — the binary names above come straight from the
   `command ??` defaults in that file, not from this runbook, so this list is
   only as current as the last time someone updated it here.

3. Confirm the login state landed where expected — e.g.
   `ls ~/.local/share/pi-agentd-worker-home/claude` should show that CLI's own
   config directory, not an empty tree.
4. From here on, every `agentd`-launched run of that worker kind reuses this
   login automatically. There is nothing to repeat per task or per run.

## What this is not

- Not a place for provider API keys. `SandboxRequest.secrets` exists for
  that and is currently always empty by design — see the architecture note
  in `packages/sandbox/src/provider.ts`. Loading credentials into a worker
  environment is a separate, deliberately out-of-scope decision.
- Not shared with the operator's real `HOME` in either direction. Deleting
  `~/.claude/` on the operator's own machine does not touch
  `<workerHomeRoot>/claude`, and vice versa.
- Not per-run or per-task. It is per **kind** — every `claude`-kind run on
  this daemon shares one login, the same way an operator's own shell shares
  one `~/.claude/` across every terminal.
