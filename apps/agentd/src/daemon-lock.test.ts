import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { temporaryDirectory } from "@pi-cmux/testkit";

import { acquireDaemonLock, type DaemonLockOwner } from "./daemon-lock.ts";

const owner: DaemonLockOwner = { pid: 4711, startedAtMs: 1_700_000_000_000 };
const other: DaemonLockOwner = { pid: 4712, startedAtMs: 1_700_000_001_000 };

describe("the daemon lock", () => {
  it("claims a free runtime directory with a private lock file", async () => {
    await using dir = await temporaryDirectory();
    const lockPath = path.join(dir.path, "pi-agentd.lock.sqlite");

    const lock = await acquireDaemonLock({ lockPath, owner });
    assert.ok(lock.ok);
    assert.deepEqual(lock.value.owner, owner);
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);

    assert.ok((await lock.value.release()).ok);
  });

  it("refuses a second owner while the OS lock is held", async () => {
    await using dir = await temporaryDirectory();
    const lockPath = path.join(dir.path, "pi-agentd.lock.sqlite");

    const first = await acquireDaemonLock({ lockPath, owner });
    assert.ok(first.ok);

    const second = await acquireDaemonLock({ lockPath, owner: other });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "DAEMON_ALREADY_RUNNING");

    assert.ok((await first.value.release()).ok);
  });

  it("lets exactly one of two concurrent starts win", async () => {
    await using dir = await temporaryDirectory();
    const lockPath = path.join(dir.path, "pi-agentd.lock.sqlite");

    const [a, b] = await Promise.all([
      acquireDaemonLock({ lockPath, owner }),
      acquireDaemonLock({ lockPath, owner: other }),
    ]);

    assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
    if (a.ok) assert.ok((await a.value.release()).ok);
    if (b.ok) assert.ok((await b.value.release()).ok);
  });

  it("can be reacquired after release", async () => {
    await using dir = await temporaryDirectory();
    const lockPath = path.join(dir.path, "pi-agentd.lock.sqlite");

    const first = await acquireDaemonLock({ lockPath, owner });
    assert.ok(first.ok);
    assert.ok((await first.value.release()).ok);
    assert.ok((await first.value.release()).ok, "release is idempotent");

    const second = await acquireDaemonLock({ lockPath, owner: other });
    assert.ok(second.ok);
    assert.ok((await second.value.release()).ok);
  });

  it("is released by the OS when its process dies", async () => {
    await using dir = await temporaryDirectory();
    const lockPath = path.join(dir.path, "pi-agentd.lock.sqlite");
    const script = [
      'const { DatabaseSync } = require("node:sqlite")',
      "const db = new DatabaseSync(process.argv[1], { timeout: 0 })",
      'db.exec("BEGIN EXCLUSIVE")',
      'process.stdout.write("ready\\n")',
      "setInterval(() => undefined, 1000)",
    ].join(";");

    const child = spawn(process.execPath, ["-e", script, lockPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => {
        resolve();
      });
    });

    const whileAlive = await acquireDaemonLock({ lockPath, owner });
    assert.equal(whileAlive.ok, false);

    child.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      child.once("close", () => {
        resolve();
      }),
    );

    const afterCrash = await acquireDaemonLock({ lockPath, owner });
    assert.ok(afterCrash.ok);
    assert.ok((await afterCrash.value.release()).ok);
  });
});
