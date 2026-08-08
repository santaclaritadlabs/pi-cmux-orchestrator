import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { ok, type AgentdError, type Result } from "@pi-cmux/protocol";

import { HostSandboxProvider } from "./host.ts";
import {
  NO_CAPABILITIES,
  satisfiesRequired,
  type SandboxAvailability,
  type SandboxCapabilities,
  type SandboxPlacement,
  type SandboxProvider,
  type SandboxRequest,
} from "./provider.ts";
import { SandboxRegistry } from "./registry.ts";

const HOME = "/home/dev";
const WORKTREE = "/srv/worktrees/AUTH-41";

const ENFORCING: SandboxCapabilities = {
  filesystemConfinement: true,
  networkControl: true,
  processIsolation: true,
};

/** A provider that claims whatever a test needs it to claim. */
class StubProvider implements SandboxProvider {
  public readonly id: string;
  public readonly kind: "none" | "process" | "vm";
  readonly #availability: SandboxAvailability;

  public constructor(
    id: string,
    kind: "none" | "process" | "vm",
    availability: SandboxAvailability,
  ) {
    this.id = id;
    this.kind = kind;
    this.#availability = availability;
  }

  public async probe(): Promise<SandboxAvailability> {
    return await Promise.resolve(this.#availability);
  }

  public async prepare(
    request: SandboxRequest,
  ): Promise<Result<SandboxPlacement, AgentdError>> {
    return await Promise.resolve(
      ok({
        providerId: this.id,
        kind: this.kind,
        capabilities: this.#availability.available
          ? this.#availability.capabilities
          : NO_CAPABILITIES,
        cwd: request.worktreePath,
        argvPrefix: ["stub-sandbox", "--"],
        env: {},
      }),
    );
  }
}

function baseRequest(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    taskId: "AUTH-41",
    worktreePath: WORKTREE,
    allowedPaths: [path.join(WORKTREE, "src")],
    network: "deny",
    networkAllowlist: [],
    home: HOME,
    ...overrides,
  };
}

describe("what counts as isolation", () => {
  it("requires both confinement and process isolation", () => {
    assert.equal(satisfiesRequired(ENFORCING), true);
    assert.equal(satisfiesRequired(NO_CAPABILITIES), false);
    // Confinement alone still leaves the worker able to signal or trace host
    // processes; isolation alone still leaves it able to write the host.
    assert.equal(
      satisfiesRequired({ ...NO_CAPABILITIES, filesystemConfinement: true }),
      false,
    );
    assert.equal(
      satisfiesRequired({ ...NO_CAPABILITIES, processIsolation: true }),
      false,
    );
  });
});

describe("selection", () => {
  it("refuses a required sandbox when only the host is available", async () => {
    const registry = new SandboxRegistry([new HostSandboxProvider()]);

    const selected = await registry.select("required");

    assert.equal(selected.ok, false);
    assert.equal(selected.error.code, "SANDBOX_UNAVAILABLE");
  });

  it("refuses a required sandbox when the enforcing provider cannot run here", async () => {
    const registry = new SandboxRegistry([
      new StubProvider("vm", "vm", {
        available: false,
        reason: "no hypervisor",
      }),
      new HostSandboxProvider(),
    ]);

    const selected = await registry.select("required");

    assert.equal(selected.ok, false);
    assert.equal(selected.error.code, "SANDBOX_UNAVAILABLE");
  });

  it("chooses an enforcing provider when one exists", async () => {
    const registry = new SandboxRegistry([
      new StubProvider("vm", "vm", {
        available: true,
        capabilities: ENFORCING,
      }),
      new HostSandboxProvider(),
    ]);

    const selected = await registry.select("required");

    assert.equal(selected.ok, true);
    assert.equal(selected.value.provider.id, "vm");
    assert.equal(selected.value.degraded, false);
  });

  it("prefers isolation over registration order for 'preferred'", async () => {
    const registry = new SandboxRegistry([
      new HostSandboxProvider(),
      new StubProvider("vm", "vm", {
        available: true,
        capabilities: ENFORCING,
      }),
    ]);

    const selected = await registry.select("preferred");

    assert.equal(selected.ok, true);
    assert.equal(selected.value.provider.id, "vm");
  });

  it("reports degradation when 'preferred' settles for the host", async () => {
    const registry = new SandboxRegistry([new HostSandboxProvider()]);

    const selected = await registry.select("preferred");

    assert.equal(selected.ok, true);
    assert.equal(selected.value.provider.id, "host");
    // The task asked for isolation and did not get it. Silence here is how a
    // fail-closed system quietly stops being one.
    assert.equal(selected.value.degraded, true);
  });

  it("answers whether this host can enforce isolation at all", async () => {
    assert.equal(
      await new SandboxRegistry([
        new HostSandboxProvider(),
      ]).canEnforceIsolation(),
      false,
    );
    assert.equal(
      await new SandboxRegistry([
        new StubProvider("vm", "vm", {
          available: true,
          capabilities: ENFORCING,
        }),
      ]).canEnforceIsolation(),
      true,
    );
  });

  it("refuses when there is no provider at all", async () => {
    const selected = await new SandboxRegistry([]).select("none");
    assert.equal(selected.ok, false);
    assert.equal(selected.error.code, "SANDBOX_UNAVAILABLE");
  });

  it("does not fall back after a provider rejects the request", async () => {
    const registry = new SandboxRegistry([new HostSandboxProvider()]);

    // The host provider cannot grant network, so this is refused. A registry
    // that then tried the next provider would be turning a refusal into a
    // search for someone who says yes.
    const prepared = await registry.prepare(
      "none",
      baseRequest({ network: "allow" }),
    );

    assert.equal(prepared.ok, false);
    assert.equal(prepared.error.code, "NETWORK_DENIED");
  });
});

describe("the host provider", () => {
  it("prepares a placement rooted at the worktree", async () => {
    const prepared = await new HostSandboxProvider().prepare(baseRequest());

    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.cwd, WORKTREE);
    assert.deepEqual(prepared.value.argvPrefix, []);
    assert.deepEqual(prepared.value.capabilities, NO_CAPABILITIES);
  });

  it("refuses network it cannot restrict", async () => {
    for (const network of ["allow", "allowlist"] as const) {
      const prepared = await new HostSandboxProvider().prepare(
        baseRequest({
          network,
          networkAllowlist: network === "allowlist" ? ["example.com"] : [],
        }),
      );
      assert.equal(prepared.ok, false);
      assert.equal(prepared.error.code, "NETWORK_DENIED");
    }
  });

  it("refuses a write surface that reaches host credentials", async () => {
    const prepared = await new HostSandboxProvider().prepare(
      baseRequest({ allowedPaths: [path.join(HOME, ".ssh")] }),
    );

    assert.equal(prepared.ok, false);
    assert.equal(prepared.error.code, "PATH_ESCAPE");
  });

  it("refuses a worktree that sits on top of the home directory", async () => {
    const prepared = await new HostSandboxProvider().prepare(
      baseRequest({ worktreePath: HOME, allowedPaths: [] }),
    );

    assert.equal(prepared.ok, false);
    assert.equal(prepared.error.code, "PATH_ESCAPE");
  });

  it("refuses an allowed path outside the worktree", async () => {
    const prepared = await new HostSandboxProvider().prepare(
      baseRequest({ allowedPaths: ["/srv/worktrees/AUTH-42/src"] }),
    );

    assert.equal(prepared.ok, false);
    assert.equal(prepared.error.code, "PATH_ESCAPE");
  });

  it("passes only the secrets it was given, and nothing forbidden", async () => {
    const prepared = await new HostSandboxProvider().prepare(
      baseRequest({ secrets: { OPENAI_API_KEY: "sk-test" } }),
    );

    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.env["OPENAI_API_KEY"], "sk-test");
    // Spec §14: control of cmux must not be an implicit worker capability.
    assert.equal(prepared.value.env["CMUX_SOCKET_PATH"], undefined);
    assert.equal(prepared.value.env["NODE_OPTIONS"], undefined);
  });
});
