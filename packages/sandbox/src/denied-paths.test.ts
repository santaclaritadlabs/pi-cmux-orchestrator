import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assertNoneDenied,
  assertNotDenied,
  deniedHostPaths,
} from "./denied-paths.ts";

const HOME = "/home/dev";
const DENIED = deniedHostPaths({ home: HOME });

describe("the host denylist", () => {
  it("covers the credentials the spec names", () => {
    assert.ok(DENIED.strict.includes(path.join(HOME, ".ssh")));
    assert.ok(DENIED.strict.includes(path.join(HOME, ".aws")));
    assert.ok(DENIED.strict.includes(path.join(HOME, ".config/gcloud")));
    assert.ok(DENIED.strict.includes("/var/run/docker.sock"));
  });

  it("covers agent configuration, which is an execution path", () => {
    // A worker that writes another agent's config can install a hook, a skill
    // or an MCP server into the control plane.
    assert.ok(DENIED.strict.includes(path.join(HOME, ".claude")));
    assert.ok(DENIED.strict.includes(path.join(HOME, ".codex")));
    assert.ok(DENIED.strict.includes(path.join(HOME, ".config/pi")));
  });

  it("covers the daemon's own run store", () => {
    // Forging an audit trail is worse than reading a credential.
    assert.ok(
      DENIED.strict.includes(path.join(HOME, ".local/share/pi-agentd")),
    );
  });

  it("puts the home directory in the enclosing-only tier", () => {
    // Not strict: worktrees legitimately live under $HOME on a dev machine.
    assert.ok(!DENIED.strict.includes(HOME));
    assert.ok(DENIED.enclosingOnly.includes(HOME));
  });

  it("accepts an extra path the caller supplies", () => {
    const denied = deniedHostPaths({
      home: HOME,
      extra: ["/run/pi-agentd.sock"],
    });
    assert.ok(denied.strict.includes("/run/pi-agentd.sock"));
  });
});

describe("refusing a denied path", () => {
  it("refuses the denied directory itself", async () => {
    const checked = await assertNotDenied(path.join(HOME, ".ssh"), DENIED);
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
  });

  it("refuses a file inside one", async () => {
    const checked = await assertNotDenied(
      path.join(HOME, ".ssh/id_ed25519"),
      DENIED,
    );
    assert.equal(checked.ok, false);
  });

  it("refuses a path that encloses one", async () => {
    // `/` is not a secret; granting it grants everything that is.
    const enclosing = await assertNotDenied("/", DENIED);
    assert.equal(enclosing.ok, false);
    assert.equal(enclosing.error.code, "PATH_ESCAPE");
  });

  it("refuses the home directory as a grant", async () => {
    const checked = await assertNotDenied(HOME, DENIED);
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
  });

  it("allows a worktree that merely lives under the home directory", async () => {
    // The rule that the default daemon layout depends on: `$HOME` may not be
    // handed over whole, but working inside it is the normal case.
    const checked = await assertNotDenied(
      path.join(HOME, ".local/share/pi-agentd-worktrees/AUTH-41"),
      DENIED,
    );
    assert.equal(checked.ok, true);
  });

  it("still refuses a worktree nested in the daemon's run store", async () => {
    // The sibling layout exists precisely because this is refused.
    const checked = await assertNotDenied(
      path.join(HOME, ".local/share/pi-agentd/worktrees/AUTH-41"),
      DENIED,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
  });

  it("allows an ordinary workspace path", async () => {
    const checked = await assertNotDenied("/srv/worktrees/AUTH-41", DENIED);
    assert.equal(checked.ok, true);
  });

  it("is not fooled by a sibling that shares a prefix", async () => {
    // `/home/dev-tools` is not inside `/home/dev`.
    const checked = await assertNotDenied("/home/dev-tools/project", DENIED);
    assert.equal(checked.ok, true);
  });

  it("stops at the first refusal in a list", async () => {
    const checked = await assertNoneDenied(
      ["/srv/worktrees/AUTH-41/src", path.join(HOME, ".aws/credentials")],
      DENIED,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
  });
});
