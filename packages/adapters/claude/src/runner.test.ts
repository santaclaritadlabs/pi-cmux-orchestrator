import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleTask, type AgentTask } from "@pi-cmux/protocol";
import { temporaryDirectory } from "@pi-cmux/testkit";

import {
  normalizeStream,
  readEvents,
  start,
  type StartArgs,
} from "./runner.ts";

const RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";
const NODE_PATH = path.dirname(process.execPath);

// @ts-expect-error StartArgs requires a sandbox-provided environment.
const startArgsWithoutEnvironment: StartArgs = {
  task: sampleTask(),
  runId: RUN_ID,
  stdoutPath: "/tmp/stdout.ndjson",
  stderrPath: "/tmp/stderr.log",
  cwd: "/tmp",
};
void startArgsWithoutEnvironment;

function taskWith(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ...sampleTask(),
    limits: { softTimeoutMs: 30_000, hardTimeoutMs: 60_000 },
    ...overrides,
  };
}

async function writeWorker(root: string): Promise<string> {
  const worker = path.join(root, "claude-fixture.mjs");
  await writeFile(
    worker,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const argsPath = process.env.ARGS_FILE;",
      "if (argsPath) writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));",
      "if (process.env.HANG === '1') { setInterval(() => {}, 1000); }",
      "else {",
      "  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'fixture complete' }] } }));",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(worker, 0o755);
  return worker;
}

describe("Claude runner", () => {
  it("builds safe argv, requiring approval when the task may not write", async () => {
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
          PATH: NODE_PATH,
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
      task.objective,
      "--output-format",
      "stream-json",
      "--verbose",
      "--bare",
      "--permission-mode",
      "dontAsk",
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

  it("uses acceptEdits only when the task permits writes", async () => {
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
          PATH: NODE_PATH,
        },
      },
      { command: worker },
    );
    assert.ok(handle.ok);
    await handle.value.completed;
    assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
      "-p",
      task.objective,
      "--output-format",
      "stream-json",
      "--verbose",
      "--bare",
      "--permission-mode",
      "acceptEdits",
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
        env: { HANG: "1", PATH: NODE_PATH },
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
    `${JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n${JSON.stringify(result)}\n`,
    { taskId: result.taskId, runId: RUN_ID },
  );
  assert.equal(batch.events.length, 1);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.rejected, 0);
});
