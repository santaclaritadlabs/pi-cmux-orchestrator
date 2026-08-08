/**
 * Structured logging.
 *
 * Every record is one NDJSON line on **stderr**. stderr rather than stdout
 * because `agentd`'s CLI writes machine-readable output on stdout, and a log
 * line interleaved into that stream would corrupt it.
 *
 * Correlation fields (`component`, and where applicable `runId`/`taskId`) are
 * part of the context, not optional decoration: CLAUDE.md requires logs be
 * "attributable to the task". `child()` is how a component narrows context once
 * rather than repeating it at every call.
 *
 * Everything — message and fields alike — goes through `redact` on the way out.
 */

import { redact, type RedactOptions } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Readonly<{
  /** Which part of the system emitted this. Always present. */
  component: string;
  runId?: string;
  taskId?: string;
  /** Ties a chain of work back to one originating RPC request. */
  correlationId?: string;
}>;

export type LogFields = Readonly<Record<string, unknown>>;

export type LogRecord = Readonly<{
  timestamp: string;
  level: LogLevel;
  message: string;
}> &
  LogContext &
  LogFields;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Narrow the context. Child fields win over parent fields. */
  child(context: Partial<LogContext>): Logger;
}

export type LogSink = (line: string) => void;

export type LoggerOptions = Readonly<{
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
  redactOptions?: RedactOptions;
}>;

const defaultSink: LogSink = (line) => {
  process.stderr.write(line);
};

/**
 * Serialize a record, falling back to a minimal envelope if serialization
 * itself fails.
 *
 * A logger that throws takes the process down at exactly the moment something
 * was worth recording, so this cannot be allowed to propagate.
 */
function serialize(record: Record<string, unknown>): string {
  try {
    return `${JSON.stringify(record)}\n`;
  } catch {
    return `${JSON.stringify({
      timestamp: record["timestamp"],
      level: "error",
      component: record["component"],
      message: "log record could not be serialized",
    })}\n`;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): Date => new Date());
  const redactOptions = options.redactOptions ?? {};

  function build(context: LogContext): Logger {
    function emit(
      level: LogLevel,
      message: string,
      fields: LogFields = {},
    ): void {
      if (LEVEL_ORDER[level] < minimum) return;

      // Redacted as one value so a secret cannot hide in a nested field.
      const safeFields = redact(fields, redactOptions);
      const safeMessage = redact(message, redactOptions);

      const record: Record<string, unknown> = {
        timestamp: now().toISOString(),
        level,
        ...context,
        message: safeMessage,
      };

      if (
        typeof safeFields === "object" &&
        safeFields !== null &&
        !Array.isArray(safeFields)
      ) {
        for (const [key, value] of Object.entries(safeFields)) {
          // Context and envelope keys are structural and must not be
          // overwritten by caller-supplied fields, or a log line could be made
          // to misattribute itself to another run.
          if (key in record) continue;
          record[key] = value;
        }
      }

      sink(serialize(record));
    }

    return {
      debug: (message, fields) => {
        emit("debug", message, fields);
      },
      info: (message, fields) => {
        emit("info", message, fields);
      },
      warn: (message, fields) => {
        emit("warn", message, fields);
      },
      error: (message, fields) => {
        emit("error", message, fields);
      },
      child: (extra) => build({ ...context, ...extra }),
    };
  }

  return build({ component: "agentd" });
}

/** Discards everything. For tests that assert on behaviour, not output. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
