/**
 * Real Git repositories, built on demand.
 *
 * Worktree behaviour cannot be faked usefully: the properties worth testing —
 * that a hook does not fire, that a detached HEAD really is detached, that
 * `worktree remove` refuses a directory it does not own — are properties of
 * git, and a stub would only assert that our stub behaves as we expect.
 *
 * So these fixtures shell out to the real `git`, deliberately *without* the
 * hardening the production path applies. A fixture that inherited
 * `core.hooksPath=/dev/null` could not be used to prove that production
 * disables hooks, because the hook would not have fired either way.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Identity and signing settings the fixture must pin.
 *
 * A developer machine with `commit.gpgsign=true` would otherwise make every
 * fixture commit prompt for a passphrase and hang the test run.
 */
const FIXTURE_CONFIG = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

export type FixtureFile = Readonly<{ path: string; contents: string }>;

export type FixtureRepository = Readonly<{
  path: string;
  headSha: string;
  branch: string;
}>;

export async function git(
  directory: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await run("git", [...FIXTURE_CONFIG, ...args], {
    cwd: directory,
    encoding: "utf8",
  });
  return stdout;
}

/** Create a repository with one commit, and return what it points at. */
export async function createFixtureRepository(
  directory: string,
  files: readonly FixtureFile[] = [
    { path: "README.md", contents: "fixture\n" },
  ],
): Promise<FixtureRepository> {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);

  for (const file of files) {
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }

  await git(directory, ["add", "--all"]);
  await git(directory, ["commit", "--quiet", "-m", "fixture"]);

  const headSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
  return { path: directory, headSha, branch: "main" };
}

/**
 * Install an executable hook that leaves a trace when it runs.
 *
 * The trace is the assertion: production must produce a worktree *and* no
 * marker file. Checking only that the command succeeded would pass even if the
 * hook had run.
 */
export async function installHook(
  repositoryPath: string,
  hook: "post-checkout" | "post-commit" | "pre-commit",
  markerPath: string,
): Promise<void> {
  const hooksDirectory = path.join(repositoryPath, ".git", "hooks");
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(
    path.join(hooksDirectory, hook),
    `#!/bin/sh\necho fired > ${JSON.stringify(markerPath)}\n`,
    { encoding: "utf8", mode: 0o755 },
  );
}

/** Write a key into the repository's own `.git/config`. */
export async function setLocalConfig(
  repositoryPath: string,
  key: string,
  value: string,
): Promise<void> {
  await git(repositoryPath, ["config", "--local", key, value]);
}
