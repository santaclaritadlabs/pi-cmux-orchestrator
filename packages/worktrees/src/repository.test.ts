import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createFixtureRepository,
  git,
  setLocalConfig,
  temporaryDirectory,
} from "@pi-cmux/testkit";

import {
  describeWorktree,
  identifyRepository,
  inspectRepositoryConfig,
  listWorktreePaths,
  parseConfigList,
  resolveCommit,
} from "./repository.ts";

describe("parsing git config output", () => {
  it("splits a NUL-separated listing", () => {
    const entries = parseConfigList("core.bare\nfalse\0user.name\nFixture\0");
    assert.deepEqual(entries, [
      { key: "core.bare", value: "false" },
      { key: "user.name", value: "Fixture" },
    ]);
  });

  it("keeps a value that contains newlines intact", () => {
    // The reason `-z` is used at all: a line-based parser would read the second
    // line as a separate key and never see the directive hidden on it.
    const entries = parseConfigList(
      "filter.x.smudge\n/bin/sh -c 'payload'\nmore\0",
    );
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.key, "filter.x.smudge");
    assert.equal(entry.value, "/bin/sh -c 'payload'\nmore");
  });

  it("treats a valueless key as true", () => {
    assert.deepEqual(parseConfigList("core.bare\0"), [
      { key: "core.bare", value: "true" },
    ]);
  });
});

describe("repository identity", () => {
  it("reports the work tree root and the shared git directory", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const identity = await identifyRepository(repository.path);

    assert.equal(identity.ok, true);
    assert.equal(
      path.basename(identity.value.topLevel),
      path.basename(repository.path),
    );
    assert.ok(path.isAbsolute(identity.value.commonDir));
    assert.equal(path.basename(identity.value.commonDir), ".git");
  });

  it("refuses a directory that is not a work tree", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");

    const identity = await identifyRepository(directory.path);

    assert.equal(identity.ok, false);
    assert.equal(identity.error.code, "GIT_COMMAND_FAILED");
  });
});

describe("the repository configuration audit", () => {
  it("accepts an ordinary repository", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const audit = await inspectRepositoryConfig(repository.path);

    assert.equal(audit.ok, true);
    assert.deepEqual(audit.value.executableKeys, []);
  });

  it("refuses a content filter, which runs during checkout", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    // This is the one `-c core.hooksPath` cannot defend against: the filter is
    // selected by the repository's own .gitattributes and runs on checkout.
    await setLocalConfig(
      repository.path,
      "filter.payload.smudge",
      "/bin/sh -c id",
    );

    const audit = await inspectRepositoryConfig(repository.path);

    assert.equal(audit.ok, false);
    assert.equal(audit.error.code, "REPO_UNSAFE");
    assert.equal(audit.error.details?.["keys"], "filter.payload.smudge");
    // The value is attacker-chosen. It must not travel with the error.
    assert.ok(!JSON.stringify(audit.error.details).includes("/bin/sh"));
  });

  it("refuses a filesystem monitor and a credential helper", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    await setLocalConfig(repository.path, "core.fsmonitor", "/tmp/payload.sh");
    await setLocalConfig(
      repository.path,
      "credential.helper",
      "/tmp/payload.sh",
    );

    const audit = await inspectRepositoryConfig(repository.path);

    assert.equal(audit.ok, false);
    assert.equal(
      audit.error.details?.["keys"],
      "core.fsmonitor,credential.helper",
    );
  });

  it("accepts a monitor that is explicitly turned off", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    // `false` is the documented way to disable it. Refusing the safe state
    // would push operators towards deleting the key instead of setting it.
    await setLocalConfig(repository.path, "core.fsmonitor", "false");

    const audit = await inspectRepositoryConfig(repository.path);

    assert.equal(audit.ok, true);
  });

  it("matches keys regardless of case", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    await setLocalConfig(repository.path, "core.hooksPath", "/tmp/hooks");

    const audit = await inspectRepositoryConfig(repository.path);

    assert.equal(audit.ok, false);
    assert.equal(audit.error.code, "REPO_UNSAFE");
  });
});

describe("resolving the base of a run", () => {
  it("pins a branch to the commit it names now", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const resolved = await resolveCommit(repository.path, "main");

    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, repository.headSha);
  });

  it("refuses a ref that does not exist", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const resolved = await resolveCommit(repository.path, "no-such-branch");

    assert.equal(resolved.ok, false);
    assert.equal(resolved.error.code, "GIT_COMMAND_FAILED");
  });
});

describe("describing a worktree", () => {
  it("reports a clean tree at its HEAD", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const status = await describeWorktree(repository.path);

    assert.equal(status.ok, true);
    assert.equal(status.value.headSha, repository.headSha);
    assert.equal(status.value.dirty, false);
    assert.deepEqual(status.value.changedFiles, []);
  });

  it("reports a filename containing a space", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );
    // Any status format other than `-z` either quotes this or breaks on it.
    await writeFile(path.join(repository.path, "a file.txt"), "x\n", "utf8");

    const status = await describeWorktree(repository.path);

    assert.equal(status.ok, true);
    assert.equal(status.value.dirty, true);
    assert.deepEqual(status.value.changedFiles, ["a file.txt"]);
  });

  it("counts a rename once, not twice", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
      [{ path: "before.txt", contents: "same contents\n" }],
    );
    await git(repository.path, ["mv", "before.txt", "after.txt"]);

    const status = await describeWorktree(repository.path);

    assert.equal(status.ok, true);
    // The old name is a second NUL-separated field of the same record.
    assert.deepEqual(status.value.changedFiles, ["after.txt"]);
  });
});

describe("listing worktrees", () => {
  it("includes the primary checkout", async () => {
    await using directory = await temporaryDirectory("pi-cmux-repo-");
    const repository = await createFixtureRepository(
      path.join(directory.path, "repo"),
    );

    const listed = await listWorktreePaths(repository.path);

    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
    assert.equal(
      path.basename(listed.value[0] ?? ""),
      path.basename(repository.path),
    );
  });
});
