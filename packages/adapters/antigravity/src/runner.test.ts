import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleTask, type AgentTask } from "@pi-cmux/protocol";
import {
  assertSurvivesAdversarialCorpus,
  providerAdversarialFixtures,
  readFixture,
  temporaryDirectory,
} from "@pi-cmux/testkit";

import {
  normalizeStream,
  readEvents,
  start,
  type StartArgs,
} from "./runner.ts";

const RUN_ID = "run_01JQZX3K5T7V9B2N4M6P8R0AWC";
const NODE_PATH = path.dirname(process.execPath);

function taskWith(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ...sampleTask(),
    limits: { softTimeoutMs: 30_000, hardTimeoutMs: 60_000 },
    ...overrides,
  };
}

function taskInWorktree(
  worktreePath: string,
  overrides: Partial<AgentTask> = {},
): AgentTask {
  return taskWith({
    workspace: { ...sampleTask().workspace, worktreePath },
    ...overrides,
  });
}

const startArgsWithoutEnv = {
  task: taskInWorktree("/tmp/worktree"),
  runId: RUN_ID,
  stdoutPath: "/tmp/stdout.ndjson",
  stderrPath: "/tmp/stderr.log",
  cwd: "/tmp/worktree",
};

// @ts-expect-error StartArgs requires an environment supplied by the sandbox.
void (startArgsWithoutEnv satisfies StartArgs);

async function writeWorker(root: string): Promise<string> {
  const worker = path.join(root, "agy-fixture.mjs");
  await writeFile(
    worker,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const argsPath = process.env.ARGS_FILE;",
      "if (argsPath) writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));",
      "if (process.env.HANG === '1') { setInterval(() => {}, 1000); }",
      "else {",
      "  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'fixture complete' } }));",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(worker, 0o755);
  return worker;
}

describe("Antigravity runner", () => {
  it("builds a read-only argv (no auto-approve flag) when the task may not write", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const argsFile = path.join(dir.path, "args.json");
    const stdoutPath = path.join(dir.path, "stdout.ndjson");
    const task = taskInWorktree(dir.path, {
      objective: "inspect; do not execute shell",
      constraints: { ...sampleTask().constraints, mayWrite: false },
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

  it("adds --dangerously-skip-permissions when the task may write", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const argsFile = path.join(dir.path, "args.json");
    const task = taskInWorktree(dir.path, {
      objective: "make the change",
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
      "--dangerously-skip-permissions",
    ]);
  });

  it("reports a denied tool call as blocked, not succeeded, even though `agy` exits 0 and its own result envelope claims SUCCESS", async () => {
    // Real captured transcript: exit code 0 and `result.status: "SUCCESS"`
    // both survive a `run_command` denied by the user (step_update state
    // "ERROR" on the tool step). This is the exact false-success case the
    // terminal status must not trust the exit code or the provider's own
    // result envelope for.
    await using dir = await temporaryDirectory();
    const raw = await readFixture(
      "antigravity",
      "captured-tool-error-example.ndjson",
    );
    const worker = path.join(dir.path, "agy-tool-error-fixture.mjs");
    await writeFile(
      worker,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(process.env.FIXTURE_CONTENT ?? '');",
      ].join("\n"),
      "utf8",
    );
    await chmod(worker, 0o755);

    const stdoutPath = path.join(dir.path, "stdout.ndjson");
    const task = taskInWorktree(dir.path, { objective: "run pwd" });

    const handle = await start(
      {
        task,
        runId: RUN_ID,
        stdoutPath,
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: dir.path,
        env: {
          FIXTURE_CONTENT: raw,
          PATH: NODE_PATH,
        },
      },
      { command: worker },
    );
    assert.ok(handle.ok);
    const outcome = await handle.value.completed;
    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.exitCode, 0);

    const batch = await readEvents(stdoutPath, 0, {
      atEof: true,
      taskId: task.taskId,
      runId: RUN_ID,
    });
    assert.ok(batch.ok);
    assert.equal(batch.value.results.length, 1);
    assert.notEqual(batch.value.results[0]?.status, "succeeded");
    assert.equal(batch.value.results[0]?.status, "blocked");
    assert.equal(
      batch.value.results[0].failure?.code,
      "WORKER_PERMISSION_DENIED",
    );
  });
});

describe("adversarial corpus (Task 11)", () => {
  const streamOptions = {
    taskId: sampleTask().taskId,
    runId: RUN_ID,
  };

  it("survives hardened provider fixtures through normalizeStream", async () => {
    await assertSurvivesAdversarialCorpus(
      (raw) => normalizeStream(raw, streamOptions),
      providerAdversarialFixtures("antigravity"),
      { hardened: true },
    );
  });

  it("rejects a cwd outside the assigned worktree before spawning", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });

    const handle = await start(
      {
        task: taskInWorktree(worktree),
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: outside,
        env: { PATH: NODE_PATH },
      },
      { command: process.execPath },
    );

    assert.equal(handle.ok, false);
    assert.equal(handle.error.code, "PATH_ESCAPE");
  });

  it("rejects a cwd that resolves outside the worktree via symlink", async () => {
    await using dir = await temporaryDirectory();
    const worktree = path.join(dir.path, "worktree");
    const outside = path.join(dir.path, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(worktree, "escape"));

    const handle = await start(
      {
        task: taskInWorktree(worktree),
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: path.join(worktree, "escape"),
        env: { PATH: NODE_PATH },
      },
      { command: process.execPath },
    );

    assert.equal(handle.ok, false);
    assert.equal(handle.error.code, "PATH_ESCAPE");
  });

  it("terminates a hung worker at the hard timeout", async () => {
    await using dir = await temporaryDirectory();
    const worker = await writeWorker(dir.path);
    const worktree = path.join(dir.path, "worktree");
    await mkdir(worktree, { recursive: true });
    const task = taskInWorktree(worktree, {
      limits: { softTimeoutMs: 50, hardTimeoutMs: 200 },
    });

    const handle = await start(
      {
        task,
        runId: RUN_ID,
        stdoutPath: path.join(dir.path, "stdout.ndjson"),
        stderrPath: path.join(dir.path, "stderr.log"),
        cwd: worktree,
        env: { HANG: "1", PATH: NODE_PATH },
      },
      { command: worker, supervisor: { terminationGraceMs: 200 } },
    );
    assert.ok(handle.ok);
    const outcome = await handle.value.completed;
    assert.equal(outcome.reason, "timed_out");
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.softTimeoutElapsed, true);
  });
});
