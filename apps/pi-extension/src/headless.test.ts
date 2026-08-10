import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { DaemonClient } from "@pi-cmux/agentd";
import { makeError, type AgentdError, type Result } from "@pi-cmux/protocol";

import {
  CmuxStatusConsumer,
  createCmuxTextSink,
  PiAgentdBridge,
} from "./index.ts";

const run = {
  runId: "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
  taskId: "task_01JQZX3K5T7V9B2N4M6P8R0AWC",
  state: "SUCCEEDED" as const,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:01.000Z",
};

function fakeClient(values: Readonly<Record<string, unknown>>): DaemonClient {
  return {
    call: (method): Promise<Result<unknown, AgentdError>> => {
      const value = values[method];
      return Promise.resolve(
        value === undefined
          ? { ok: false, error: makeError("INTERNAL", "missing") }
          : { ok: true, value },
      );
    },
    close: () => undefined,
  };
}

describe("headless pi-extension operation", () => {
  it("does not depend on @pi-cmux/cmux", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    assert.equal(packageJson.dependencies?.["@pi-cmux/cmux"], undefined);
  });

  it("watches status with a text sink only", async () => {
    const bridge = PiAgentdBridge.fromClient(
      fakeClient({
        "task.status": run,
        "task.events": [],
      }),
    );

    const messages: string[] = [];
    const consumer = new CmuxStatusConsumer(
      bridge,
      createCmuxTextSink({
        write: (text) => {
          messages.push(text);
        },
      }),
    );

    const followed = await consumer.follow(run.runId);
    assert.equal(followed.ok, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /SUCCEEDED/);
  });

  it("agentd package.json does not depend on @pi-cmux/cmux", async () => {
    const agentdPackage = JSON.parse(
      await readFile(
        new URL("../../agentd/package.json", import.meta.url),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    assert.equal(agentdPackage.dependencies?.["@pi-cmux/cmux"], undefined);
  });
});
