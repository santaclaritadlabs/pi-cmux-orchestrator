import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { temporaryDirectory } from "@pi-cmux/testkit";

import {
  assertContained,
  checkPathAccess,
  isLexicallyContained,
} from "./path-containment.ts";

describe("lexical containment", () => {
  it("accepts a path inside the container", () => {
    assert.equal(isLexicallyContained("/a/b/c.txt", "/a/b"), true);
    assert.equal(isLexicallyContained("/a/b/c/d", "/a/b"), true);
  });

  it("treats a directory as containing itself", () => {
    // A worker allowed to write to its worktree may write to the root.
    assert.equal(isLexicallyContained("/a/b", "/a/b"), true);
    assert.equal(isLexicallyContained("/a/b/", "/a/b"), true);
  });

  it("rejects a sibling that merely shares a prefix", () => {
    // The classic bug: "/a/bc".startsWith("/a/b") is true.
    assert.equal(isLexicallyContained("/a/bc", "/a/b"), false);
    assert.equal(isLexicallyContained("/a/b-other/x", "/a/b"), false);
    assert.equal(isLexicallyContained("/a/bcd", "/a/b"), false);
  });

  it("collapses traversal before comparing", () => {
    assert.equal(isLexicallyContained("/a/b/../c", "/a/b"), false);
    assert.equal(isLexicallyContained("/a/b/x/../y", "/a/b"), true);
    assert.equal(isLexicallyContained("/a/b/../../etc/passwd", "/a/b"), false);
  });

  it("rejects a parent of the container", () => {
    assert.equal(isLexicallyContained("/a", "/a/b"), false);
    assert.equal(isLexicallyContained("/", "/a/b"), false);
  });
});

describe("containment follows symlinks", () => {
  it("rejects a symlink pointing out of the worktree", async () => {
    // This is the case lexical checking cannot see: the path looks contained
    // right up until it is written through.
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");

    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "sensitive");
    await symlink(outside, path.join(worktree, "escape"));

    const candidate = path.join(worktree, "escape", "secret.txt");

    // Lexically it looks fine...
    assert.equal(isLexicallyContained(candidate, worktree), true);
    // ...but resolving says otherwise.
    const checked = await assertContained(candidate, worktree);
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
    assert.match(checked.error.safeMessage, /symlink/);
  });

  it("accepts a symlink that stays inside the worktree", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    await mkdir(path.join(worktree, "real"), { recursive: true });
    await writeFile(path.join(worktree, "real", "file.txt"), "ok");
    await symlink(path.join(worktree, "real"), path.join(worktree, "alias"));

    const checked = await assertContained(
      path.join(worktree, "alias", "file.txt"),
      worktree,
    );
    assert.equal(checked.ok, true);
  });

  it("catches a symlinked parent of a file that does not exist yet", async () => {
    // A worker about to *create* a file: the path does not exist, but its
    // parent directory might be a symlink somewhere else.
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(worktree, "src"));

    const checked = await assertContained(
      path.join(worktree, "src", "new-file.ts"),
      worktree,
    );
    assert.equal(checked.ok, false);
  });

  it("allows a not-yet-existing file under a genuine directory", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    await mkdir(path.join(worktree, "src"), { recursive: true });

    const checked = await assertContained(
      path.join(worktree, "src", "new-file.ts"),
      worktree,
    );
    assert.equal(checked.ok, true);
  });

  it("accepts the same directory spelled through a symlinked prefix", async () => {
    // The reverse of the classic bug, and the one that actually bites on
    // macOS, where `/tmp` and `/var/folders` are symlinks into `/private`.
    // A caller holding the unresolved spelling and a callee holding the
    // resolved one are talking about the same directory, and refusing that is
    // a false rejection — the lexical comparison disagrees with the filesystem.
    await using dir = await temporaryDirectory();
    const real = path.join(dir.path, "real");
    const alias = path.join(dir.path, "alias");
    await mkdir(path.join(real, "src"), { recursive: true });
    await symlink(real, alias);

    assert.equal(
      isLexicallyContained(path.join(alias, "src"), real),
      false,
      "the two spellings do not look alike",
    );

    const checked = await assertContained(path.join(alias, "src"), real);
    assert.equal(checked.ok, true);
    // And the canonical form is what comes back, so callers converge.
    assert.equal(checked.value, path.join(await realpath(real), "src"));
  });

  it("still refuses traversal spelled through a symlinked prefix", async () => {
    await using dir = await temporaryDirectory();
    const real = path.join(dir.path, "real");
    const alias = path.join(dir.path, "alias");
    await mkdir(real, { recursive: true });
    await mkdir(path.join(dir.path, "outside"), { recursive: true });
    await symlink(real, alias);

    const checked = await assertContained(
      path.join(alias, "..", "outside"),
      real,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "PATH_ESCAPE");
  });
});

describe("containment fails closed", () => {
  it("refuses relative paths on either side", async () => {
    const relative = await assertContained("relative/path", "/a/b");
    assert.equal(relative.ok, false);
    assert.equal(relative.error.code, "PATH_ESCAPE");

    const container = await assertContained("/a/b/c", "relative");
    assert.equal(container.ok, false);
  });

  it("does not echo the candidate path in the error", async () => {
    // The candidate can carry untrusted content; the container is ours.
    const checked = await assertContained("/etc/passwd-SECRETMARKER", "/a/b");
    assert.equal(checked.ok, false);
    assert.equal(JSON.stringify(checked.error).includes("SECRETMARKER"), false);
  });
});

describe("allow and deny lists", () => {
  it("admits a path inside an allowed directory", async () => {
    await using dir = await temporaryDirectory();
    const src = path.join(dir.path, "src");
    await mkdir(src, { recursive: true });

    const checked = await checkPathAccess(
      path.join(src, "index.ts"),
      [src],
      [],
    );
    assert.equal(checked.ok, true);
  });

  it("refuses a path matching nothing — the allowlist is exhaustive", async () => {
    await using dir = await temporaryDirectory();
    const src = path.join(dir.path, "src");
    await mkdir(src, { recursive: true });

    const checked = await checkPathAccess(
      path.join(dir.path, "elsewhere.ts"),
      [src],
      [],
    );
    assert.equal(checked.ok, false);
    assert.match(checked.error.safeMessage, /not inside any allowed/);
  });

  it("lets deny win over allow", async () => {
    // A path inside an allowed directory but also inside a forbidden one must
    // be refused; otherwise a broad allow silently outranks a narrow deny.
    await using dir = await temporaryDirectory();
    const src = path.join(dir.path, "src");
    const secrets = path.join(src, "secrets");
    await mkdir(secrets, { recursive: true });

    const checked = await checkPathAccess(
      path.join(secrets, "key.pem"),
      [src],
      [secrets],
    );
    assert.equal(checked.ok, false);
    assert.match(checked.error.safeMessage, /forbidden/);
  });

  it("refuses everything when the allowlist is empty", async () => {
    await using dir = await temporaryDirectory();
    const checked = await checkPathAccess(
      path.join(dir.path, "anything.ts"),
      [],
      [],
    );
    assert.equal(checked.ok, false);
  });
});
