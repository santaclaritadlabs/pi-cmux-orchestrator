# ADR 0007 — Worker adoption after daemon restart is deferred

**Status:** deferred · 2026-08-08

## Context

A worker can outlive the `agentd` process that launched it. The restarted
daemon can prove that the PID still names the recorded process and can read its
durable output, but it is not the process's parent and therefore cannot reap it
or recover its exit status. Merely tailing the output would leave the run
`RUNNING` forever once the worker exits.

The current recovery behavior stops a surviving worker and marks its run
`ORPHANED`. This is fail-closed and bounded, but it does not preserve useful
work across a daemon restart.

## Decision pending

Do not choose an adoption architecture in P2 or pull one into the critical path
of the first adapter. Revisit the decision in P5 hardening, or earlier only if
surviving an `agentd` restart becomes an explicit product requirement.

The later decision must compare at least:

- a first-party sidecar that remains the worker's parent and durably persists
  its exit status;
- a platform supervisor abstraction able to provide equivalent reap and
  timeout guarantees;
- keeping `stop + ORPHANED` as the permanent local-first behavior.

Any adoption design must preserve the original sandbox, network policy,
process-group ownership, output ceilings, cancellation deadline, protocol
version and complete audit trail. PID liveness plus output tailing is not an
acceptable substitute for a durable terminal outcome.

## Current consequence

Until that phase makes the decision, boot recovery terminates a worker that
outlived its daemon and transitions the run to `ORPHANED`. No success or failure
is inferred from a process exit that `agentd` could not observe.
