import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { temporaryDirectory } from "@pi-cmux/testkit";

import { validateWorkerPlacement } from "./worker-placement.ts";

describe("validateWorkerPlacement", () => {
  it("rejects a cwd outside the worktree", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });

    const result = await validateWorkerPlacement(outside, worktree);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PATH_ESCAPE");
  });

  it("rejects a cwd that resolves outside the worktree via symlink", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(worktree, "escape"));

    const cwd = path.join(worktree, "escape");
    const result = await validateWorkerPlacement(cwd, worktree);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "PATH_ESCAPE");
  });

  it("accepts a cwd inside the worktree", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    await mkdir(worktree, { recursive: true });

    const result = await validateWorkerPlacement(worktree, worktree);

    assert.equal(result.ok, true);
  });
});
