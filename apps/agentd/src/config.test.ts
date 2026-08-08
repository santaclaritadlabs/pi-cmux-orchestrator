import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { temporaryDirectory } from "@pi-cmux/testkit";

import { loadRepositories } from "./config.ts";
import { RepositoryRegistry } from "./repositories.ts";

async function writeConfig(
  directory: string,
  contents: unknown,
): Promise<string> {
  const file = path.join(directory, "repositories.json");
  await writeFile(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return file;
}

describe("the repository allowlist", () => {
  it("resolves a configured repository", () => {
    const registry = new RepositoryRegistry([
      { repoId: "acme/api", path: "/srv/repos/api" },
    ]);

    const resolved = registry.resolve("acme/api");

    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, "/srv/repos/api");
  });

  it("refuses anything it was not told about", () => {
    const registry = new RepositoryRegistry([
      { repoId: "acme/api", path: "/srv/repos/api" },
    ]);

    const resolved = registry.resolve("attacker/repo");

    assert.equal(resolved.ok, false);
    assert.equal(resolved.error.code, "POLICY_DENIED");
    assert.equal(
      resolved.error.details?.["rule"],
      "workspace.repository-allowlisted",
    );
  });

  it("does not disclose which repositories exist", () => {
    const registry = new RepositoryRegistry([
      { repoId: "acme/secret-project", path: "/srv/repos/secret" },
    ]);

    const resolved = registry.resolve("acme/api");

    assert.equal(resolved.ok, false);
    // Which repositories are configured is not information the caller was
    // granted by asking for one that is not.
    assert.ok(!JSON.stringify(resolved.error).includes("secret"));
  });

  it("refuses a relative path at construction", () => {
    // A relative path resolves against whatever directory the daemon started
    // from, which is a configuration bug and not a runtime surprise.
    assert.throws(
      () => new RepositoryRegistry([{ repoId: "acme/api", path: "repos/api" }]),
      /absolute path/,
    );
  });
});

describe("loading the allowlist", () => {
  it("starts empty when there is no configuration", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");

    const loaded = await loadRepositories(
      path.join(dir.path, "does-not-exist.json"),
    );

    // An unconfigured daemon runs, answers, and refuses every task that names
    // a repository. That is the correct empty state, not a startup failure.
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.size, 0);
  });

  it("loads what the operator wrote", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, {
      version: 1,
      repositories: [
        { repoId: "acme/api", path: "/srv/repos/api" },
        { repoId: "acme/web", path: "/srv/repos/web" },
      ],
    });

    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, true);
    assert.deepEqual([...loaded.value.ids].sort(), ["acme/api", "acme/web"]);
  });

  it("refuses malformed JSON rather than starting with nothing", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, "{ not json");

    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.error.code, "STORE_CORRUPT");
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, {
      version: 1,
      repositories: [
        { repoId: "acme/api", path: "/srv/repos/api", trusted: true },
      ],
    });

    // `trusted` looks like it grants something. Silently dropping it would
    // give the operator a setting that reads as effective and is not.
    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.error.code, "STORE_CORRUPT");
  });

  it("refuses a duplicate identifier instead of picking one", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, {
      version: 1,
      repositories: [
        { repoId: "acme/api", path: "/srv/repos/api" },
        { repoId: "acme/api", path: "/srv/repos/other" },
      ],
    });

    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.error.code, "STORE_CORRUPT");
  });

  it("refuses a relative path", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, {
      version: 1,
      repositories: [{ repoId: "acme/api", path: "../elsewhere" }],
    });

    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.error.code, "STORE_CORRUPT");
  });

  it("refuses a version it does not understand", async () => {
    await using dir = await temporaryDirectory("pi-cmux-config-");
    const file = await writeConfig(dir.path, {
      version: 2,
      repositories: [],
    });

    const loaded = await loadRepositories(file);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.error.code, "STORE_CORRUPT");
  });
});
