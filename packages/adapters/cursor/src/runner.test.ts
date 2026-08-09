import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleTask, type AgentTask } from "@pi-cmux/protocol";
import { temporaryDirectory } from "@pi-cmux/testkit";

import { normalizeStream, readEvents, start } from "./runner.ts";

const RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";

function taskWith(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ...sampleTask(),
    limits: { softTimeoutMs: 30_000, hardTimeoutMs: 60_000 },
    ...overrides,
  };
}

async function writeWorker(root: string): Promise<string> {
  const worker = path.join(root, "cursor-fixture.mjs");
  await writeFile(
    worker,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const argsPath = process.env.ARGS_FILE;",
      "if (argsPath) writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));",
      "if (process.env.HANG === '1') { setInterval(() => {}, 1000); }",
      "else {",
      "  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture complete' }] } }));",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(worker, 0o755);
  return worker;
}

describe("Cursor runner", () => {
  it("builds safe argv and appends a validated terminal result", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const argsFile = path.join(dir.path, "args.json");
    const stdoutPath = path.join(dir.path, "stdout.ndjson");
    const task = taskWith({
      objective: "inspect; do not execute shell",
      constraints: {
        ...sampleTask().constraints,
        mayWrite: false,
      },
    });

    const handle = await start(
      {
        task,
        runId: RUN_ID,
        stdoutPath,
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: {
          ARGS_FILE: argsFile,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        },
      },
      { command: worker },
    );
    assert.ok(handle.ok);
    const outcome = await handle.value.completed;
    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.exitCode, 0);

    assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
      "-p",
      "--output-format",
      "stream-json",
      task.objective,
    ]);
    const batch = await readEvents(stdoutPath, 0, {
      atEof: true,
      taskId: task.taskId,
      runId: RUN_ID,
    });
    assert.ok(batch.ok);
    assert.equal(batch.value.events.length, 1);
    assert.equal(batch.value.results.length, 1);
    assert.equal(batch.value.results[0]?.status, "succeeded");
  });

  it("adds --force only when the task permits writes", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const argsFile = path.join(dir.path, "args.json");
    const task = taskWith({
      constraints: { ...sampleTask().constraints, mayWrite: true },
    });
    const handle = await start(
      {
        task,
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: {
          ARGS_FILE: argsFile,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        },
      },
      { command: worker },
    );
    assert.ok(handle.ok);
    await handle.value.completed;
    assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      task.objective,
    ]);
  });

  it("cancels a running process through the supervisor", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const task = taskWith();
    const handle = await start(
      {
        task,
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: { HANG: "1", PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      },
      { command: worker, supervisor: { terminationGraceMs: 200 } },
    );
    assert.ok(handle.ok);
    handle.value.cancel();
    const outcome = await handle.value.completed;
    assert.equal(outcome.reason, "cancelled");
  });
});

it("keeps protocol results separate from provider events", () => {
  const result = {
    protocolVersion: "1",
    taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
    runId: RUN_ID,
    status: "succeeded",
    summary: "done",
    findings: [],
    tests: [],
    changedFiles: [],
    artifacts: [],
    changes: { worktreePath: "/tmp/worktree", dirty: false },
    warnings: [],
  };
  const batch = normalizeStream(
    `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n${JSON.stringify(result)}\n`,
    { taskId: result.taskId, runId: RUN_ID },
  );
  assert.equal(batch.events.length, 1);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.rejected, 0);
});
