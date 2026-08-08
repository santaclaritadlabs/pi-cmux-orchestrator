/**
 * Translate `codex exec --json` records into the public `AgentEvent` contract.
 *
 * Provider records are untrusted and intentionally do not cross this module.
 * Unknown provider fields and event/item types are ignored for forward
 * compatibility; malformed records of a known shape are counted as rejected.
 */

import {
  boundedText,
  LIMITS,
  NdjsonStream,
  parseAgentEvent,
  PROTOCOL_VERSION,
  type AgentEvent,
  type NdjsonReadResult,
} from "@pi-cmux/protocol";
import { redactString } from "@pi-cmux/observability";
import { z } from "zod";

const providerEnvelopeSchema = z.looseObject({
  type: boundedText(LIMITS.identifierMaxChars),
});

const providerItemSchema = z.looseObject({
  id: boundedText(LIMITS.identifierMaxChars),
  type: boundedText(LIMITS.identifierMaxChars),
  text: z.string().max(LIMITS.freeTextMaxChars).optional(),
  exit_code: z.int().optional(),
});

const providerItemEventSchema = z.looseObject({
  type: z.enum(["item.started", "item.completed"]),
  item: providerItemSchema,
});

const providerErrorValueSchema = z.union([
  z.string().max(LIMITS.freeTextMaxChars),
  z.looseObject({
    message: z.string().max(LIMITS.freeTextMaxChars).optional(),
  }),
]);

const providerFailureEventSchema = z.looseObject({
  type: z.enum(["error", "turn.failed"]),
  message: z.string().max(LIMITS.freeTextMaxChars).optional(),
  error: providerErrorValueSchema.optional(),
});

const TOOL_ITEM_NAMES = {
  command_execution: "shell",
  file_change: "file_change",
  mcp_tool_call: "mcp",
  web_search: "web_search",
} as const;

type ToolItemType = keyof typeof TOOL_ITEM_NAMES;

type Translation =
  | Readonly<{ kind: "event"; event: AgentEvent }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "rejected" }>;

export type CodexNormalizerOptions = Readonly<{
  taskId: string;
  runId: string;
  startSequence?: number;
  now?: () => Date;
}>;

export type CodexNormalizedBatch = Readonly<{
  events: readonly AgentEvent[];
  /** Invalid JSON or a malformed record of a recognized provider type. */
  rejected: number;
  /** Well-formed transport bookkeeping or a forward-compatible unknown type. */
  ignored: number;
  /** Byte offset from which a durable reader can resume. */
  offset: number;
  pendingBytes: number;
  overflowed: boolean;
}>;

/** Stateful because NDJSON records and sequence allocation span read chunks. */
export class CodexEventNormalizer {
  readonly #taskId: string;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #stream = new NdjsonStream();
  #nextSequence: number;

  public constructor(options: CodexNormalizerOptions) {
    this.#taskId = options.taskId;
    this.#runId = options.runId;
    this.#nextSequence = options.startSequence ?? 0;
    this.#now = options.now ?? (() => new Date());
  }

  public push(chunk: string): CodexNormalizedBatch {
    return this.#consume(this.#stream.push(chunk));
  }

  /** Call only after the Codex process has exited. */
  public finish(): CodexNormalizedBatch {
    return this.#consume(this.#stream.finish());
  }

  #consume(read: NdjsonReadResult): CodexNormalizedBatch {
    const events: AgentEvent[] = [];
    let rejected = read.rejected;
    let ignored = 0;

    for (const record of read.records) {
      const translated = this.#translate(record.value);
      if (translated.kind === "event") events.push(translated.event);
      if (translated.kind === "rejected") rejected += 1;
      if (translated.kind === "ignored") ignored += 1;
    }

    return {
      events,
      rejected,
      ignored,
      offset: read.consumedBytes,
      pendingBytes: read.pendingBytes,
      overflowed: read.overflowed,
    };
  }

  #translate(value: unknown): Translation {
    const envelope = providerEnvelopeSchema.safeParse(value);
    if (!envelope.success) return { kind: "rejected" };

    switch (envelope.data.type) {
      case "thread.started":
      case "turn.started":
      case "turn.completed":
        // agentd owns lifecycle state; provider transport state cannot mutate it.
        return { kind: "ignored" };

      case "item.started":
      case "item.completed":
        return this.#translateItem(value);

      case "error":
      case "turn.failed":
        return this.#translateFailure(value);

      default:
        return { kind: "ignored" };
    }
  }

  #translateItem(value: unknown): Translation {
    const parsed = providerItemEventSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    const { item, type } = parsed.data;
    if (item.type === "reasoning" || item.type === "plan_update") {
      // Do not persist private reasoning or provider orchestration internals.
      return { kind: "ignored" };
    }

    if (item.type === "agent_message") {
      if (type === "item.started") return { kind: "ignored" };
      if (item.text === undefined) return { kind: "rejected" };
      return this.#event("log", {
        level: "info",
        message: redactProviderText(item.text),
      });
    }

    if (!isToolItemType(item.type)) return { kind: "ignored" };

    const exitCode = type === "item.completed" ? item.exit_code : undefined;
    return this.#event("tool", {
      phase: type === "item.started" ? "started" : "completed",
      callId: item.id,
      tool: TOOL_ITEM_NAMES[item.type],
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }

  #translateFailure(value: unknown): Translation {
    const parsed = providerFailureEventSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    const nested = parsed.data.error;
    const message =
      parsed.data.message ??
      (typeof nested === "string" ? nested : nested?.message) ??
      "Codex reported an error";

    return this.#event("log", {
      level: "error",
      message: redactProviderText(message),
    });
  }

  #event(
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
  ): Translation {
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      taskId: this.#taskId,
      runId: this.#runId,
      sequence: this.#nextSequence,
      timestamp: this.#now().toISOString(),
      type,
      payload,
    };
    const parsed = parseAgentEvent(candidate);
    if (!parsed.ok) {
      // Invalid adapter configuration or an invalid mapping is a programmer
      // defect. Provider-caused failures are returned above as `rejected`.
      throw new Error(`Codex normalizer produced an invalid ${type} event`);
    }

    this.#nextSequence += 1;
    return { kind: "event", event: parsed.value };
  }
}

function isToolItemType(value: string): value is ToolItemType {
  return Object.hasOwn(TOOL_ITEM_NAMES, value);
}

function redactProviderText(value: string): string {
  // A replacement marker can be longer than the credential it replaces. Keep
  // the normalized payload within its protocol ceiling after redaction too.
  return redactString(value, LIMITS.freeTextMaxChars).slice(
    0,
    LIMITS.freeTextMaxChars,
  );
}

/** Normalize a complete captured stream, including its final fragment. */
export function normalizeCodexStream(
  raw: string,
  options: CodexNormalizerOptions,
): CodexNormalizedBatch {
  const normalizer = new CodexEventNormalizer(options);
  const pushed = normalizer.push(raw);
  const finished = normalizer.finish();

  return {
    events: [...pushed.events, ...finished.events],
    rejected: pushed.rejected + finished.rejected,
    ignored: pushed.ignored + finished.ignored,
    offset: finished.offset,
    pendingBytes: finished.pendingBytes,
    overflowed: pushed.overflowed || finished.overflowed,
  };
}
