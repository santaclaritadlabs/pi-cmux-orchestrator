/**
 * The policy engine.
 *
 * **Default deny.** A task is admitted only if every rule that applies to it
 * allows it. There is no "allow unless denied" path, and no rule may be skipped
 * because an earlier one passed.
 *
 * Each decision produces an `AgentEvent` of type `policy`, not a log line.
 * CLAUDE.md requires policy decisions be auditable, and a log line is not an
 * audit record: it is not ordered, not persisted with the run, and not part of
 * the replayable history.
 *
 * P1 deliberately refuses more than P2/P3 will. `CLAUDE.md` P1 specifies a
 * read-only execution model, so writes, commits, network and required sandboxes
 * are all denied here — with the rule for each already written, so P2 turns
 * them on rather than inventing them. See docs/adr/0005.
 */

import {
  PROTOCOL_VERSION,
  makeError,
  err,
  ok,
  type AgentEvent,
  type AgentTask,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

import { assertContained } from "./path-containment.ts";

/** Which phase's rules to apply. Named so the gates are visible, not implied. */
export type PolicyProfile = Readonly<{
  /** P1: false. P2 onwards: true. */
  allowWrites: boolean;
  /** P1: false. Requires `allowWrites`. */
  allowCommits: boolean;
  /** P1: false — there is no sandbox implementation yet. */
  sandboxAvailable: boolean;
  /** P1: false. */
  allowNetwork: boolean;
}>;

/** The only profile P1 ships. Everything that can be denied, is. */
export const READ_ONLY_PROFILE: PolicyProfile = {
  allowWrites: false,
  allowCommits: false,
  sandboxAvailable: false,
  allowNetwork: false,
};

/**
 * P2: writes are allowed, because there is now something to bound them.
 *
 * The permission follows the enforcement, never the other way round. A worker
 * may write because it has a dedicated worktree, its declared paths are proven
 * to be inside that worktree, and a sandbox provider has accepted the placement
 * — not because a task asked politely.
 *
 * Commits stay denied: a branch that only `agentd` can create is a handoff
 * artifact, and P2 has no approval flow to authorise one. Network stays denied
 * because no provider can yet enforce an allowlist. `sandboxAvailable` is left
 * `false` here and overwritten by whoever probes the host — a profile that
 * claims isolation nobody verified is worse than one that claims none.
 */
export const WORKSPACE_WRITE_PROFILE: PolicyProfile = {
  allowWrites: true,
  allowCommits: false,
  sandboxAvailable: false,
  allowNetwork: false,
};

export type PolicyDecision = Readonly<{
  allowed: boolean;
  /** The rule that decided, so an audit traces to a line of policy. */
  rule: string;
  reason: string;
}>;

type Rule = Readonly<{
  name: string;
  /** Returns a denial reason, or `undefined` to allow. */
  evaluate: (
    task: AgentTask,
    profile: PolicyProfile,
  ) => string | undefined | Promise<string | undefined>;
}>;

const RULES: readonly Rule[] = [
  {
    name: "worker.kind-supported",
    evaluate: (task) =>
      // P1 executes only the fake worker. A real provider adapter arriving
      // without a policy review must not simply start working.
      task.worker.kind === "fake"
        ? undefined
        : `worker kind '${task.worker.kind}' is not enabled in this phase`,
  },
  {
    name: "constraints.no-push",
    evaluate: (task) => {
      // The type says this is `false` and the schema makes `true`
      // unrepresentable, so TypeScript considers the check dead. It is kept as
      // a genuine *runtime* check — widened to `unknown` so the compiler does
      // not optimise it away — because a task reaching the engine through a
      // cast, a stale `task.json`, or a future caller that skipped the codec
      // must still be refused. This is the single most important invariant in
      // the system; it does not rest on the type checker alone.
      const mayPush: unknown = task.constraints.mayPush;
      return mayPush === false ? undefined : "workers may never push";
    },
  },
  {
    name: "constraints.writes",
    evaluate: (task, profile) =>
      task.constraints.mayWrite && !profile.allowWrites
        ? "write access is not available in this phase"
        : undefined,
  },
  {
    name: "constraints.commits",
    evaluate: (task, profile) =>
      task.constraints.mayCommit && !profile.allowCommits
        ? "commit access is not available in this phase"
        : undefined,
  },
  {
    name: "constraints.network",
    evaluate: (task, profile) =>
      task.constraints.network !== "deny" && !profile.allowNetwork
        ? `network '${task.constraints.network}' is not available in this phase`
        : undefined,
  },
  {
    name: "constraints.sandbox",
    evaluate: (task, profile) =>
      // CLAUDE.md: "If required isolation is unavailable, reject the task; do
      // not silently fall back to the host."
      task.constraints.sandbox === "required" && !profile.sandboxAvailable
        ? "the task requires isolation, which is not available"
        : undefined,
  },
  {
    name: "workspace.allowed-paths-contained",
    evaluate: async (task) => {
      // Every declared write surface must be inside the assigned worktree.
      // A path outside it is not a narrower permission — it is a wider one.
      for (const allowed of task.constraints.allowedPaths) {
        const contained = await assertContained(
          allowed,
          task.workspace.worktreePath,
        );
        if (!contained.ok) {
          return "an allowedPath resolves outside the assigned worktree";
        }
      }
      return undefined;
    },
  },
  {
    name: "limits.bounded",
    evaluate: (task) =>
      // Belt and braces with the schema: an unbounded run cannot be supervised.
      task.limits.hardTimeoutMs > 0 &&
      task.limits.hardTimeoutMs >= task.limits.softTimeoutMs
        ? undefined
        : "the task must declare a positive, ordered pair of timeouts",
  },
];

/**
 * Decide whether a task may run.
 *
 * Every rule is evaluated in order and the **first denial wins**, so the
 * reported reason is the most specific one that applies rather than the last.
 */
export async function decide(
  task: AgentTask,
  profile: PolicyProfile = READ_ONLY_PROFILE,
): Promise<Result<PolicyDecision, AgentdError>> {
  for (const rule of RULES) {
    const denial = await rule.evaluate(task, profile);
    if (denial !== undefined) {
      return err(
        makeError("POLICY_DENIED", "the task was denied by policy", {
          details: { rule: rule.name, reason: denial },
        }),
      );
    }
  }

  return ok({
    allowed: true,
    rule: "default",
    reason: "every applicable rule allowed the task",
  });
}

/** The names of every rule, so a runbook can enumerate what is enforced. */
export function ruleNames(): readonly string[] {
  return RULES.map((rule) => rule.name);
}

/**
 * Turn a decision into the audit record that goes on the event log.
 *
 * A policy decision that exists only in a log line is not auditable: it is not
 * ordered against the run's other events and not replayable.
 */
export function policyEvent(
  taskId: string,
  runId: string,
  sequence: number,
  timestamp: string,
  outcome: Result<PolicyDecision, AgentdError>,
): AgentEvent {
  const payload = outcome.ok
    ? {
        decision: "allowed",
        rule: outcome.value.rule,
        reason: outcome.value.reason,
      }
    : {
        decision: "denied",
        rule: String(outcome.error.details?.["rule"] ?? "unknown"),
        reason: String(outcome.error.details?.["reason"] ?? "denied"),
      };

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    runId,
    sequence,
    timestamp,
    type: "policy",
    payload,
  };
}
