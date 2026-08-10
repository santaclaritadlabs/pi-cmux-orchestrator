import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCmuxCli } from "./cli-transport.ts";

describe("runCmuxCli", () => {
  it("resolves ok when the CLI exits 0", async () => {
    const result = await runCmuxCli(["-e", "process.exit(0)"], {
      cliPath: process.execPath,
    });
    assert.equal(result.ok, true);
  });

  it("includes the CLI's stderr in the error on a nonzero exit", async () => {
    const script =
      "process.stderr.write('workspace not found\\n'); process.exit(2)";
    const result = await runCmuxCli(["-e", script], {
      cliPath: process.execPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.error.safeMessage, /exited with code 2/);
    assert.match(result.error.safeMessage, /workspace not found/);
  });

  it("reports a code-only message when the CLI wrote nothing to stderr", async () => {
    const result = await runCmuxCli(["-e", "process.exit(3)"], {
      cliPath: process.execPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.safeMessage, "cmux CLI exited with code 3");
  });

  it("rejects an empty argv before spawning anything", async () => {
    const result = await runCmuxCli([]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SCHEMA_INVALID");
  });

  it("reports the CLI failing to start", async () => {
    const result = await runCmuxCli(["--noop"], {
      cliPath: "/definitely/not/a/real/cmux/binary",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INTERNAL");
  });
});
