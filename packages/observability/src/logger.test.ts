import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger, type LogLevel } from "./logger.ts";

function capture(level: LogLevel = "debug"): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    sink: (line) => lines.push(line),
    now: () => new Date("2026-08-08T05:00:00.000Z"),
  });
  return { lines, logger };
}

/** The emitted line at `index`, asserted to exist and parsed. */
function recordAt(lines: string[], index = 0): Record<string, unknown> {
  const line = lines[index];
  assert.ok(
    line !== undefined,
    `expected a log line at index ${String(index)}`,
  );
  return JSON.parse(line) as Record<string, unknown>;
}

function firstLine(lines: string[]): string {
  const line = lines[0];
  assert.ok(line !== undefined, "expected a log line");
  return line;
}

describe("log record shape", () => {
  it("emits one NDJSON object per call", () => {
    const { lines, logger } = capture();
    logger.info("worker started");

    assert.equal(lines.length, 1);
    const line = firstLine(lines);
    assert.ok(line.endsWith("\n"));
    assert.equal(
      line.trimEnd().includes("\n"),
      false,
      "a record must occupy exactly one line",
    );

    const record = recordAt(lines);
    assert.equal(record["level"], "info");
    assert.equal(record["message"], "worker started");
    assert.equal(record["timestamp"], "2026-08-08T05:00:00.000Z");
    assert.equal(record["component"], "agentd");
  });

  it("carries correlation fields from child context", () => {
    const { lines, logger } = capture();
    logger
      .child({ component: "supervisor", runId: "run_01J", taskId: "AUTH-41" })
      .warn("hard timeout approaching");

    const record = recordAt(lines);
    assert.equal(record["component"], "supervisor");
    assert.equal(record["runId"], "run_01J");
    assert.equal(record["taskId"], "AUTH-41");
  });

  it("keeps parent context when a child narrows part of it", () => {
    const { lines, logger } = capture();
    logger
      .child({ runId: "run_01J" })
      .child({ component: "adapter" })
      .info("spawned");

    const record = recordAt(lines);
    assert.equal(record["runId"], "run_01J");
    assert.equal(record["component"], "adapter");
  });

  it("refuses to let caller fields overwrite structural fields", () => {
    // Otherwise a log line could be made to misattribute itself to another run.
    const { lines, logger } = capture();
    logger.child({ runId: "run_real" }).info("hello", {
      runId: "run_forged",
      level: "debug",
      timestamp: "1999-01-01T00:00:00.000Z",
      message: "forged",
    });

    const record = recordAt(lines);
    assert.equal(record["runId"], "run_real");
    assert.equal(record["level"], "info");
    assert.equal(record["message"], "hello");
    assert.equal(record["timestamp"], "2026-08-08T05:00:00.000Z");
  });
});

describe("level filtering", () => {
  it("drops records below the configured level", () => {
    const { lines, logger } = capture("warn");
    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    logger.error("kept");

    assert.equal(lines.length, 2);
    assert.equal(recordAt(lines, 0)["level"], "warn");
    assert.equal(recordAt(lines, 1)["level"], "error");
  });

  it("applies the level to children too", () => {
    const { lines, logger } = capture("error");
    logger.child({ component: "rpc" }).warn("dropped");
    assert.equal(lines.length, 0);
  });
});

describe("logging is redacted", () => {
  it("redacts secrets in the message", () => {
    const { lines, logger } = capture();
    logger.error("auth failed for sk-abcdefghijklmnop123456");
    assert.equal(firstLine(lines).includes("sk-abcdefghijklmnop123456"), false);
  });

  it("redacts secrets in fields, however deeply nested", () => {
    const { lines, logger } = capture();
    logger.info("spawning", {
      argv: ["codex", "--key", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
      config: { nested: { authorization: "Basic zzz" } },
    });

    const line = firstLine(lines);
    assert.equal(line.includes("ghp_abcdefghijklmnopqrstuvwxyz0123"), false);
    assert.equal(line.includes("Basic zzz"), false);
    // Non-secret argv survives, so the log still says what ran.
    assert.match(line, /codex/);
  });

  it("never emits a raw environment block", () => {
    const { lines, logger } = capture();
    logger.info("worker env", {
      env: { OPENAI_API_KEY: "sk-live", PATH: "/usr/bin" },
    });

    const line = firstLine(lines);
    assert.equal(line.includes("sk-live"), false);
    assert.equal(line.includes("/usr/bin"), false);
  });
});

describe("the logger cannot take the process down", () => {
  it("survives a cyclic field", () => {
    const { lines, logger } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    assert.doesNotThrow(() => {
      logger.info("cyclic field", { cyclic });
    });
    assert.equal(lines.length, 1);
    // Redaction already breaks the cycle, so the real record survives.
    assert.match(firstLine(lines), /cyclic field/);
  });

  it("does not throw on a BigInt, which JSON.stringify rejects", () => {
    const { lines, logger } = capture();
    assert.doesNotThrow(() => {
      logger.info("big", { size: 2n ** 70n });
    });
    assert.match(firstLine(lines), /1180591620717411303424n/);
  });
});
