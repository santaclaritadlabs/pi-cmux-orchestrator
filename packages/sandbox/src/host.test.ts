import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostSandboxProvider } from "./host.ts";
import type { SandboxRequest } from "./provider.ts";

const REAL_OPERATOR_HOME = "/Users/an-operator-nobody-should-see";
const WORKTREE = "/srv/worktrees/AUTH-41";
const WORKER_HOME = "/srv/worker-home/claude";

function baseRequest(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    taskId: "AUTH-41",
    worktreePath: WORKTREE,
    allowedPaths: [],
    network: "deny",
    networkAllowlist: [],
    workerHome: WORKER_HOME,
    ...overrides,
  };
}

describe("the host provider's worker HOME", () => {
  it("uses request.workerHome, never the real process.env.HOME", async (t) => {
    // A distinctive stand-in for the daemon operator's actual home. If this
    // value ever reaches a worker's environment, Finding A has regressed.
    const originalHome = process.env["HOME"];
    process.env["HOME"] = REAL_OPERATOR_HOME;
    t.after(() => {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    });

    const prepared = await new HostSandboxProvider().prepare(baseRequest());

    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.env["HOME"], WORKER_HOME);
    assert.notEqual(prepared.value.env["HOME"], REAL_OPERATOR_HOME);
  });

  it("lets an explicit HOME win even if it were ever passed as a secret", async () => {
    const prepared = await new HostSandboxProvider().prepare(
      baseRequest({ secrets: { HOME: "/should-never-survive" } }),
    );

    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.env["HOME"], WORKER_HOME);
  });
});
