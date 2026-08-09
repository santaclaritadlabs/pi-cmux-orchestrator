# Runbook: reviewing the policy audit trail

Audience: an operator who needs to answer "what did the policy engine decide,
and why" for one run, or across many.

## Where the audit trail lives

There is no separate audit subsystem. The record _is_ the event log:
`Orchestrator.createTask` (`apps/agentd/src/orchestrator.ts`) calls `decide()`
(`packages/policy/src/decide.ts`) exactly once per task and writes the outcome
as that run's first event, at `sequence: 0`, before anything else can be
appended:

```json
{
  "type": "policy",
  "sequence": 0,
  "payload": {
    "decision": "allowed" | "denied",
    "rule": "<the name of the rule that decided it>",
    "reason": "<human-readable reason, present on denial>"
  }
}
```

This happens for **every** `task.create` call, including one the allowlist or
policy engine goes on to deny. A denied task still gets a run record and a
sequence-0 event — the audit trail is deliberately symmetric, so "no run
exists for this attempt" is never a way to hide that the attempt was made.
The rule name comes from the closed rule set in `packages/policy/src/decide.ts`
(`RULES`), which is default-deny and denies on the first matching rule — the
`rule` field is always the one that actually decided the outcome, not
necessarily the first rule in the list.

## What rules can decide

`ruleNames()` (`packages/policy/src/decide.ts`) enumerates the full, closed
rule set currently enforced — it exists specifically so a runbook does not
have to hardcode the list and drift from the code. Any `rule` value on a
policy event will be one of these names, or `"default"` for an allow that no
rule objected to.

## How to review one run

```
agentd logs <runId>
```

The first line printed is always the policy event, since it is sequence 0.
Everything after it is normalized worker output for the same run, if the
policy allowed it to start.

## How to review across many runs

There is no aggregate query today — `agentd runs` lists run IDs and current
state but not their policy outcome, and there is no `agentd audit` command.
To review denials across the whole state directory, the current mechanism is
reading each run's sequence-0 event directly, e.g.:

```
for r in $(agentd runs | awk '{print $1}'); do
  agentd logs "$r" | head -n1
done
```

This is a stopgap, not a documented interface: it depends on `agentd runs`
and `agentd logs` output shapes staying stable, which they are not
contractually guaranteed to. If cross-run audit review becomes a routine
operational need, the right fix is a dedicated read path (store-level query
or an `agentd audit` command), not a shell loop kept as institutional
knowledge.

## What is intentionally not in the audit trail

- **Raw prompts and secrets.** CLAUDE.md requires a complete audit trail
  "without recording secrets or sensitive prompts unnecessarily." The policy
  event records the _decision_, not the task's full content; provider output
  is redacted before it becomes a `log` event (`redactString`/
  `redactProviderText`, `@pi-cmux/observability`) and asserted in every
  adapter's normalizer tests.
- **Raw provider payloads.** Retained, if at all, only in a redacted debug
  envelope behind an explicit local setting (see `docs/protocol.md`) — never
  as part of the normalized, audited event stream.

## What this runbook does not cover

Retention policy (how long event logs are kept on disk) and log shipping to
an external system are not implemented and not scoped here. Today the audit
trail lives exactly as long as the run's directory under the daemon's state
dir does.
