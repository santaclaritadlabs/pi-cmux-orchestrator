import { spawn } from "node:child_process";

import {
  err,
  fromThrown,
  makeError,
  ok,
  type AgentdError,
  type Result,
} from "@pi-cmux/protocol";

/** Default cmux CLI binary name on PATH. */
export const DEFAULT_CMUX_CLI = "cmux";

export async function runCmuxCli(
  argv: readonly string[],
  options: Readonly<{
    cliPath?: string;
    env?: Readonly<Record<string, string>>;
  }> = {},
): Promise<Result<void, AgentdError>> {
  const cliPath = options.cliPath ?? DEFAULT_CMUX_CLI;
  if (argv.length === 0) {
    return err(makeError("SCHEMA_INVALID", "cmux CLI argv is empty"));
  }

  return await new Promise((resolve) => {
    const child = spawn(cliPath, [...argv], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (cause) => {
      resolve(
        err(fromThrown("INTERNAL", "cmux CLI process failed to start", cause)),
      );
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve(ok(undefined));
        return;
      }
      const detail = stderr.trim();
      resolve(
        err(
          makeError(
            "INTERNAL",
            detail.length > 0
              ? `cmux CLI exited with code ${String(code)}: ${detail}`
              : `cmux CLI exited with code ${String(code)}`,
          ),
        ),
      );
    });
  });
}
