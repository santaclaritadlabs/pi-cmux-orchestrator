import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { createFixtureRepository, temporaryDirectory } from "@pi-cmux/testkit";

import { buildGitEnvironment, runGit } from "./git.ts";

describe("the git environment", () => {
  it("neutralises global and system configuration", () => {
    const env = buildGitEnvironment({});
    assert.equal(env["GIT_CONFIG_GLOBAL"], "/dev/null");
    assert.equal(env["GIT_CONFIG_SYSTEM"], "/dev/null");
    assert.equal(env["GIT_CONFIG_NOSYSTEM"], "1");
  });

  it("does not inherit variables that redirect git", () => {
    // Each of these silently points an operation somewhere else. They are kept
    // out by construction: the allowlist never mentions them.
    const env = buildGitEnvironment({
      GIT_DIR: "/tmp/elsewhere/.git",
      GIT_WORK_TREE: "/tmp/elsewhere",
      GIT_INDEX_FILE: "/tmp/elsewhere/index",
      GIT_OBJECT_DIRECTORY: "/tmp/elsewhere/objects",
      GIT_SSH_COMMAND: "/tmp/payload.sh",
      GIT_EXTERNAL_DIFF: "/tmp/payload.sh",
      PATH: "/usr/bin:/bin",
    });

    assert.equal(env["GIT_DIR"], undefined);
    assert.equal(env["GIT_WORK_TREE"], undefined);
    assert.equal(env["GIT_INDEX_FILE"], undefined);
    assert.equal(env["GIT_OBJECT_DIRECTORY"], undefined);
    assert.equal(env["GIT_SSH_COMMAND"], undefined);
    assert.equal(env["GIT_EXTERNAL_DIFF"], undefined);
    // But it still gets what it needs to run.
    assert.equal(env["PATH"], "/usr/bin:/bin");
  });

  it("strips variables that inject code into any child", () => {
    const env = buildGitEnvironment({
      LD_PRELOAD: "/tmp/payload.so",
      DYLD_INSERT_LIBRARIES: "/tmp/payload.dylib",
      NODE_OPTIONS: "--require /tmp/payload.js",
    });

    assert.equal(env["LD_PRELOAD"], undefined);
    assert.equal(env["DYLD_INSERT_LIBRARIES"], undefined);
    assert.equal(env["NODE_OPTIONS"], undefined);
  });
});

describe("argument handling", () => {
  it("refuses an option it does not recognise", async () => {
    await using directory = await temporaryDirectory("pi-cmux-git-");

    // `--upload-pack` runs a command of the caller's choosing. Nothing in this
    // package passes it, so seeing it means argv was built from something it
    // should not have been.
    const outcome = await runGit(["fetch", "--upload-pack=/tmp/payload.sh"], {
      cwd: directory.path,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "GIT_COMMAND_FAILED");
  });

  it("accepts the flags this package actually uses", async () => {
    await using directory = await temporaryDirectory("pi-cmux-git-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const outcome = await runGit(["rev-parse", "--verify", "HEAD"], {
      cwd: repository.path,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.stdout.trim(), repository.headSha);
  });

  it("requires an absolute working directory", async () => {
    const outcome = await runGit(["status"], { cwd: "relative/path" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "GIT_COMMAND_FAILED");
  });

  it("reports a failing command without echoing git's output", async () => {
    await using directory = await temporaryDirectory("pi-cmux-git-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const outcome = await runGit(
      ["rev-parse", "--verify", "--end-of-options", "no-such-ref"],
      { cwd: repository.path },
    );

    assert.equal(outcome.ok, false);
    // The ref name is attacker-chosen text; it must not reach the safe message.
    assert.ok(!outcome.error.safeMessage.includes("no-such-ref"));
    assert.equal(outcome.error.details?.["subcommand"], "rev-parse");
  });

  it("treats an allowed nonzero exit as an answer", async () => {
    await using directory = await temporaryDirectory("pi-cmux-git-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    // `rev-parse --verify --quiet` exits 1 for "no such ref", which is an
    // answer to the question rather than a failure to ask it.
    const outcome = await runGit(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", "no-such-ref"],
      { cwd: repository.path, allowExitCodes: [1] },
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.exitCode, 1);
    assert.equal(outcome.value.stdout.trim(), "");
  });
});
