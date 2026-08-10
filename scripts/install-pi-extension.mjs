import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOADER_NAME = "pi-cmux-orchestrator.js";
const ENTRYPOINT = path.join("apps", "pi-extension", "dist", "pi-entry.js");

export function parseInstallArgs(
  argv,
  home = homedir(),
  environment = process.env,
) {
  let targetDir =
    environment["PI_EXTENSION_DIR"] ??
    path.join(home, ".pi", "agent", "extensions");

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      return { help: true, targetDir: expandHome(targetDir, home) };
    }
    if (argument === "--target" || argument === "-t") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--target requires a directory path");
      }
      targetDir = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      const value = argument.slice("--target=".length);
      if (value === "") throw new Error("--target requires a directory path");
      targetDir = value;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  return {
    help: false,
    repoRoot: REPOSITORY_ROOT,
    targetDir: expandHome(targetDir, home),
  };
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

function runCommand(command, args, cwd) {
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${String(code)}`,
        ),
      );
    });
  });
}

export async function installPiExtension(options, runner = runCommand) {
  const repoRoot = path.resolve(options.repoRoot);
  const entrypoint = path.join(repoRoot, ENTRYPOINT);
  const targetDir = path.resolve(options.targetDir);

  await runner("pnpm", ["install", "--frozen-lockfile"], repoRoot);
  await runner("pnpm", ["build"], repoRoot);
  await access(entrypoint);

  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const loaderPath = path.join(targetDir, LOADER_NAME);
  const loader = `export { default } from ${JSON.stringify(pathToFileURL(entrypoint).href)};\n`;
  const temporaryPath = path.join(
    targetDir,
    `.${LOADER_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, loader, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, loaderPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return loaderPath;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: pnpm install:pi-extension -- [--target <directory>]",
      "",
      "Runs pnpm install --frozen-lockfile, waits for it, runs pnpm build,",
      "then writes a Pi loader into the target directory.",
      "",
      `Default target: ${path.join("$HOME", ".pi", "agent", "extensions")}`,
      "Environment override: PI_EXTENSION_DIR",
    ].join("\n") + "\n",
  );
}

async function main() {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const loaderPath = await installPiExtension(options);
    process.stdout.write(`Pi extension installed at ${loaderPath}\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Pi extension installation failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
