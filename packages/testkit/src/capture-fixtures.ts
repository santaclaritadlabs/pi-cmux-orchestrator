/**
 * Captures real provider output into `fixtures/<provider>/`.
 *
 * Run by hand, once, by an operator:
 *
 *     pnpm fixtures:capture --provider codex --confirm
 *
 * **This is the only code in the repository that runs a provider CLI.** It
 * needs network and credentials, it costs money, and it is never run by CI or
 * by any test. `--confirm` is required so it cannot be triggered by accident.
 *
 * Why capture at all, when CLAUDE.md's P0 says "no real CLI execution": the
 * alternative is hand-writing fixtures from documentation and validating the
 * P3 parsers against a format we assumed. Recording the real bytes once, then
 * testing offline against them forever, is what makes the adapters' tests
 * meaningful. See docs/adr/0003.
 *
 * Every capture records the resolved binary path and its `--version` in
 * `metadata.json`. That matters more than it looks: on this machine `codex`
 * and `claude` resolve to cmux shims under a temp directory, so "which binary
 * produced this?" is not answerable from the command name alone.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { redactString } from "@pi-cmux/observability";

import { fixturesDirectory, type Provider } from "./fixtures.ts";

type Invocation = Readonly<{
  provider: Provider;
  command: string;
  /** Argv only. No shell, ever — CLAUDE.md, security rules. */
  args: readonly string[];
  versionArgs: readonly string[];
}>;

const OBJECTIVE =
  "Add a one-line comment above the greet function in src/greet.js " +
  "explaining what it returns. Change nothing else.";

/**
 * Flags chosen to minimise what each provider loads from the repository.
 * Claude gets `--bare`, which the spec notes strips plugin, skill, MCP, hook
 * and CLAUDE.md auto-discovery — appropriate when pointing a CLI at a
 * throwaway repo whose content we are about to record.
 */
const INVOCATIONS: readonly Invocation[] = [
  {
    provider: "codex",
    command: "codex",
    args: ["exec", "--json", OBJECTIVE],
    versionArgs: ["--version"],
  },
  {
    provider: "claude",
    command: "claude",
    args: ["-p", "--output-format", "stream-json", "--bare", OBJECTIVE],
    versionArgs: ["--version"],
  },
  {
    provider: "cursor",
    command: "agent",
    args: ["-p", "--output-format", "stream-json", OBJECTIVE],
    versionArgs: ["--version"],
  },
  {
    provider: "antigravity",
    command: "agy",
    args: ["-p", "--output-format", "stream-json", OBJECTIVE],
    versionArgs: ["--version"],
  },
];

type SpawnResult = Readonly<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
      // Inherit the environment here deliberately: a provider CLI needs its own
      // credentials to run at all. This script is an operator tool, not the
      // control plane — `agentd` builds a worker's environment by allowlist.
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 300_000,
    );

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

/** Resolves the real path behind a command name, following the PATH. */
async function resolveBinary(command: string): Promise<string> {
  try {
    const result = await run("/usr/bin/which", [command], { timeoutMs: 5_000 });
    return result.stdout.trim() || "<unresolved>";
  } catch {
    return "<unresolved>";
  }
}

async function readVersion(
  command: string,
  versionArgs: readonly string[],
): Promise<string> {
  try {
    const result = await run(command, versionArgs, { timeoutMs: 15_000 });
    return `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  } catch {
    return "<unavailable>";
  }
}

/** A throwaway git repository with one trivial file to edit. */
async function createSandboxRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-cmux-capture-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "greet.js"),
    "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "README.md"),
    "# capture sandbox\n\nDisposable repository used to record provider output.\n",
    "utf8",
  );

  await run("git", ["init", "--quiet"], { cwd: dir });
  await run("git", ["add", "."], { cwd: dir });
  await run(
    "git",
    [
      "-c",
      "user.email=capture@example.invalid",
      "-c",
      "user.name=fixture capture",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: dir },
  );

  return dir;
}

async function capture(
  invocation: Invocation,
  repoDir: string,
): Promise<boolean> {
  const { provider, command, args, versionArgs } = invocation;
  process.stdout.write(`\n=== ${provider} ===\n`);

  const binary = await resolveBinary(command);
  const version = await readVersion(command, versionArgs);
  process.stdout.write(`  binary:  ${binary}\n  version: ${version}\n`);

  if (binary === "<unresolved>") {
    process.stdout.write("  skipped: command not found on PATH\n");
    return false;
  }

  const started = Date.now();
  const result = await run(command, args, { cwd: repoDir });
  const durationMs = Date.now() - started;

  const outDir = path.join(fixturesDirectory(), provider);
  await mkdir(outDir, { recursive: true });

  // Redact line by line so a credential in one record cannot survive by
  // hiding behind the truncation of another. `Infinity` disables truncation:
  // fixtures must stay byte-faithful apart from the redactions themselves.
  const redacted = result.stdout
    .split("\n")
    .map((line) => redactString(line, Number.POSITIVE_INFINITY))
    .join("\n");

  await writeFile(path.join(outDir, "trivial-edit.ndjson"), redacted, "utf8");

  await writeFile(
    path.join(outDir, "metadata.json"),
    `${JSON.stringify(
      {
        provider,
        capturedAt: new Date().toISOString(),
        binary,
        version,
        command,
        args,
        objective: OBJECTIVE,
        exitCode: result.code,
        signal: result.signal,
        durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrExcerpt: redactString(result.stderr.slice(0, 2_000)),
        note:
          "Redacted with @pi-cmux/observability redactString. Review by hand " +
          "before committing: redaction is best-effort, not a guarantee.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(
    `  wrote:   ${path.join(outDir, "trivial-edit.ndjson")} (exit ${String(result.code)})\n`,
  );
  return true;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes("--confirm");
  const providerIndex = argv.indexOf("--provider");
  const requested =
    providerIndex >= 0 ? (argv[providerIndex + 1] ?? "all") : "all";

  if (!confirmed) {
    process.stderr.write(
      [
        "capture-fixtures runs real provider CLIs.",
        "It requires network access and credentials, and it costs money.",
        "",
        "Re-run with --confirm to proceed:",
        "  pnpm fixtures:capture --provider all --confirm",
        "",
        "Review the redacted output by hand before committing it.",
        "",
      ].join("\n"),
    );
    return 64;
  }

  const selected = INVOCATIONS.filter(
    (i) => requested === "all" || i.provider === requested,
  );
  if (selected.length === 0) {
    process.stderr.write(`unknown provider '${requested}'\n`);
    return 64;
  }

  const repoDir = await createSandboxRepo();
  process.stdout.write(`sandbox repo: ${repoDir}\n`);

  try {
    let captured = 0;
    for (const invocation of selected) {
      // Sequential on purpose: concurrent captures would interleave edits to
      // the same sandbox repo and produce fixtures that contradict each other.
      if (await capture(invocation, repoDir)) captured += 1;
      await run("git", ["checkout", "--", "."], { cwd: repoDir });
    }

    process.stdout.write(
      `\ncaptured ${String(captured)} of ${String(selected.length)} providers\n` +
        "review `git diff fixtures/` by hand before committing\n",
    );
    return captured === 0 ? 1 : 0;
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
