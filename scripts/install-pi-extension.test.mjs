import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  installPiExtension,
  parseInstallArgs,
} from "./install-pi-extension.mjs";

async function temporaryRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-cmux-install-"));
  const entrypoint = path.join(
    root,
    "apps",
    "pi-extension",
    "dist",
    "pi-entry.js",
  );
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "export default () => undefined;\n");
  return { root, entrypoint };
}

describe("Pi extension installer", () => {
  it("waits for install and build before writing an atomic loader", async () => {
    const repository = await temporaryRepo();
    const targetDir = path.join(repository.root, "pi", "extensions");
    const steps = [];

    try {
      const loaderPath = await installPiExtension(
        { repoRoot: repository.root, targetDir },
        async (command, args, cwd) => {
          steps.push({ command, args: [...args], cwd });
        },
      );

      assert.deepEqual(
        steps.map(({ args }) => args),
        [["install", "--frozen-lockfile"], ["build"]],
      );
      assert.equal(loaderPath, path.join(targetDir, "pi-cmux-orchestrator.js"));
      assert.equal(
        await readFile(loaderPath, "utf8"),
        `export { default } from ${JSON.stringify(pathToFileURL(repository.entrypoint).href)};\n`,
      );
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it("does not build or write the loader when install fails", async () => {
    const repository = await temporaryRepo();
    const targetDir = path.join(repository.root, "pi", "extensions");
    const loaderPath = path.join(targetDir, "pi-cmux-orchestrator.js");
    const steps = [];

    try {
      await assert.rejects(
        installPiExtension(
          { repoRoot: repository.root, targetDir },
          async (_command, args) => {
            steps.push([...args]);
            if (args[0] === "install") throw new Error("install failed");
          },
        ),
        /install failed/,
      );
      assert.deepEqual(steps, [["install", "--frozen-lockfile"]]);
      await assert.rejects(access(loaderPath), { code: "ENOENT" });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it("does not write the loader when build fails", async () => {
    const repository = await temporaryRepo();
    const targetDir = path.join(repository.root, "pi", "extensions");
    const loaderPath = path.join(targetDir, "pi-cmux-orchestrator.js");

    try {
      await assert.rejects(
        installPiExtension(
          { repoRoot: repository.root, targetDir },
          async (_command, args) => {
            if (args[0] === "build") throw new Error("build failed");
          },
        ),
        /build failed/,
      );
      await assert.rejects(access(loaderPath), { code: "ENOENT" });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it("accepts a custom target and expands a quoted home-relative path", () => {
    const parsed = parseInstallArgs(
      ["--", "--target", "~/custom/extensions"],
      "/tmp/home",
    );
    assert.equal(parsed.targetDir, "/tmp/home/custom/extensions");
  });
});
