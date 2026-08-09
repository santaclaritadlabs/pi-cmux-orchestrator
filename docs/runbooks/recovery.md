# Runbook: daemon restart recovery

Audience: an operator bringing `agentd` back up after a crash, an upgrade, or
a host reboot, and needing to know what state the system is in.

## What recovery does automatically

`recoverRuns` (`apps/agentd/src/recovery.ts`) runs once, before the RPC socket
opens, so no client can ever observe a run still claiming `RUNNING` from a
previous incarnation. For every run on disk:

1. Its lock is cleared unconditionally. A lock means "a daemon is working
   this run", which is false by construction at boot.
2. A run that is already terminal, `ORPHANED`, or `QUEUED` (never launched)
   is left alone.
3. Anything else is investigated: is the recorded PID dead, alive, or
   unverifiable (start time doesn't match)? All three outcomes end the same
   way — the run moves to `ORPHANED` — but a worker still alive is first
   stopped (`SIGTERM`, then `SIGKILL` after a grace period).

`ORPHANED` is not a failure verdict. It means the daemon has no evidence the
work finished, so it refuses to guess. See
[`docs/adr/0008-deferred-worker-adoption.md`](../adr/0008-deferred-worker-adoption.md)
for why a surviving worker is stopped rather than adopted — the short version
is that `agentd` is not that process's parent after a restart, so it can never
observe its exit code.

`agentd start` logs a one-line summary on every boot:

```
recovery complete { inspected, orphaned, terminated, unstoppable }
```

`unstoppable` is the number that needs a human. It means a surviving worker
did not die even after `SIGKILL` — check for a process wedged in
uninterruptible I/O and stop it by hand.

## What recovery deliberately does not do

It does not touch worktrees. An `ORPHANED` run may hold the only copy of
whatever the worker produced, so its worktree claim is left exactly as it
was — reported, never reclaimed automatically
(`WorktreeManager.listUnreleased`, `packages/worktrees/src/manager.ts`).

## Operator checklist after a restart

1. **Read the boot log line.** If `orphaned` is `0`, there is nothing to do.
2. **List the orphaned runs**, if any:
   ```
   agentd runs
   ```
   Anything in state `ORPHANED` was mid-flight when the daemon went away.
3. **Inspect what each one was doing**, if the work needs to be judged before
   moving on:
   ```
   agentd logs <runId>
   ```
   The event log is the audit trail — see
   [`docs/runbooks/audit-review.md`](./audit-review.md).
4. **List worktrees nobody has released**:
   ```
   agentd worktrees
   ```
   Each line is a worktree still claimed by a run, with the path and when it
   was claimed. If the run that claimed it is `ORPHANED`, decide by hand
   whether the work in that worktree is worth keeping.
   - **Worth keeping**: leave it. Nothing in the system will touch it.
   - **Not worth keeping**: remove it through git, not by deleting the
     directory —
     `git -C <repoPath> worktree remove --force -- <worktreePath>` — so git's
     own bookkeeping stays consistent. There is currently no `agentd` command
     that performs the removal for you; `WorktreeManager.release()` exists in
     code but is only reachable from a run that still holds the claim, which
     an `ORPHANED` run's owner no longer does programmatically. Treat this as
     a manual, audited step, not something to script casually — the whole
     point of "reported, never reclaimed automatically" is that an operator
     makes the call.
5. **If `unstoppable > 0`**, find the PID from the recovery log
   (`stopping a worker that outlived its daemon`) and kill it by hand, then
   confirm the worktree it was writing to.

## What this runbook does not cover

Adopting a surviving worker instead of stopping it is a deferred design
decision (ADR-0008), not a bug. Do not treat `ORPHANED` runs from a live
worker as something to "fix" by making recovery smarter — the fix, if one is
ever made, changes the daemon's process-supervision model, not this runbook.
