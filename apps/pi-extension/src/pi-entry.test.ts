import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeError } from "@pi-cmux/protocol";

import {
  createPiExtensionHost,
  type PiCommandContext,
  type PiExtensionRuntime,
} from "./pi-entry.js";

type RegisteredCommand = Readonly<{
  handler: (args: string, context: PiCommandContext) => void | Promise<void>;
}>;

function runtime(): {
  pi: PiExtensionRuntime;
  commands: Map<string, RegisteredCommand>;
  notifications: {
    message: string;
    level: "info" | "warning" | "error";
  }[];
  shutdown: () => Promise<void>;
} {
  const commands = new Map<string, RegisteredCommand>();
  const notifications: {
    message: string;
    level: "info" | "warning" | "error";
  }[] = [];
  let shutdownHandler: (() => void | Promise<void>) | undefined;

  return {
    pi: {
      registerCommand: (name, options) => {
        commands.set(name, options);
      },
      on: (_event, handler) => {
        shutdownHandler = handler;
      },
    },
    commands,
    notifications,
    shutdown: async () => {
      await shutdownHandler?.();
    },
  };
}

describe("Pi runtime adapter", () => {
  it("passes a command's complete JSON payload as one bridge argument", async () => {
    const fake = runtime();
    const host = createPiExtensionHost(fake.pi);
    let receivedArgs: readonly string[] | undefined;

    host.registerCommand("agentd.create", (input) => {
      receivedArgs = input.args;
      return Promise.resolve({ ok: true, value: { runId: "run-1" } });
    });

    const command = fake.commands.get("agentd.create");
    assert.ok(command);
    await command.handler('{"objective":"two words"}', {
      ui: {
        notify: (message, level) => fake.notifications.push({ message, level }),
      },
    });

    assert.deepEqual(receivedArgs, ['{"objective":"two words"}']);
    assert.deepEqual(fake.notifications, [
      { message: '{"runId":"run-1"}', level: "info" },
    ]);
  });

  it("maps bridge errors to an error notification and empty input to no arguments", async () => {
    const fake = runtime();
    const host = createPiExtensionHost(fake.pi);
    let receivedArgs: readonly string[] | undefined;

    host.registerCommand("agentd.health", (input) => {
      receivedArgs = input.args;
      return Promise.resolve({
        ok: false,
        error: makeError("RPC_UNAUTHENTICATED", "daemon unavailable"),
      });
    });

    const command = fake.commands.get("agentd.health");
    assert.ok(command);
    await command.handler("   ", {
      ui: {
        notify: (message, level) => fake.notifications.push({ message, level }),
      },
    });

    assert.deepEqual(receivedArgs, []);
    assert.deepEqual(fake.notifications, [
      { message: "daemon unavailable", level: "error" },
    ]);
  });

  it("connects the bridge shutdown hook to Pi's session shutdown", async () => {
    const fake = runtime();
    const host = createPiExtensionHost(fake.pi);
    let disposed = false;

    host.onShutdown?.(() => {
      disposed = true;
    });
    await fake.shutdown();

    assert.equal(disposed, true);
  });
});
