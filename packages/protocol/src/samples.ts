/**
 * Canonical valid messages, for tests and for the fake adapter.
 *
 * Each builder returns a minimal message that passes validation, plus an
 * override hook. Tests then mutate exactly one field, which keeps a failing
 * assertion pointed at the rule it is about rather than at incidental setup.
 */

import type { AgentEvent } from "./event.ts";
import type { AgentResult } from "./agent-result.ts";
import type { AgentTask } from "./task.ts";
import { PROTOCOL_VERSION } from "./task.ts";

const SAMPLE_DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const SAMPLE_RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";
export const SAMPLE_TASK_ID = "AUTH-41";

export function sampleTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: SAMPLE_TASK_ID,
    objective: "Add a regression test for the token refresh path.",
    role: "implement",
    workspace: {
      repoId: "acme/api",
      worktreePath: "/Users/dev/.worktrees/AUTH-41-codex",
      baseRef: "main",
    },
    worker: { kind: "fake", profile: "default" },
    constraints: {
      allowedPaths: ["/Users/dev/.worktrees/AUTH-41-codex/src"],
      forbiddenPaths: [],
      network: "deny",
      networkAllowlist: [],
      sandbox: "preferred",
      mayWrite: true,
      mayCommit: false,
      mayPush: false,
      capabilities: [],
    },
    limits: { softTimeoutMs: 60_000, hardTimeoutMs: 300_000 },
    dependencies: [],
    inputs: [{ name: "spec", digest: SAMPLE_DIGEST }],
    ...overrides,
  };
}

export function sampleEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: SAMPLE_TASK_ID,
    runId: SAMPLE_RUN_ID,
    sequence: 0,
    timestamp: "2026-08-08T05:00:00.000Z",
    type: "status",
    payload: { state: "RUNNING" },
    ...overrides,
  };
}

export function sampleResult(
  overrides: Partial<AgentResult> = {},
): AgentResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: SAMPLE_TASK_ID,
    runId: SAMPLE_RUN_ID,
    status: "succeeded",
    summary: "Added a regression test covering token refresh.",
    exitCode: 0,
    findings: [],
    tests: [{ name: "refresh returns a new token", status: "passed" }],
    changedFiles: ["src/auth/refresh.test.ts"],
    artifacts: [],
    changes: {
      worktreePath: "/Users/dev/.worktrees/AUTH-41-codex",
      headSha: "0".repeat(40),
      dirty: false,
    },
    warnings: [],
    ...overrides,
  };
}
