/**
 * Translate `cursor-agent -p --output-format stream-json` records into the
 * public `AgentEvent` contract.
 *
 * Confirmed against Cursor's official CLI docs (cursor.com/docs/cli/reference
 * /output-format, cursor.com/docs/cli/headless): the stream is NDJSON with
 * `system`/`init`, `user`, `assistant`, `tool_call` (`started`/`completed`)
 * and a terminal `result` record. The exact set of `tool_call.tool_call`
 * variant keys beyond `readToolCall` / `writeToolCall` / `function` is not
 * exhaustively documented, so the tool name is read generically as "whichever
 * key of `tool_call` is not `result`/`error`" rather than a closed enum — this
 * keeps unknown-but-real tool kinds as valid `tool` events instead of
 * rejecting them.
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

const providerContentItemSchema = z.looseObject({
  type: boundedText(LIMITS.identifierMaxChars),
  text: z.string().max(LIMITS.freeTextMaxChars).optional(),
});

const providerMessageSchema = z.looseObject({
  role: boundedText(LIMITS.identifierMaxChars),
  content: z.array(providerContentItemSchema),
});

const providerAssistantEventSchema = z.looseObject({
  type: z.literal("assistant"),
  message: providerMessageSchema,
});

const providerToolCallEventSchema = z.looseObject({
  type: z.literal("tool_call"),
  subtype: z.enum(["started", "completed"]),
  call_id: boundedText(LIMITS.identifierMaxChars),
  tool_call: z.record(z.string(), z.unknown()),
});

const providerResultEventSchema = z.looseObject({
  type: z.literal("result"),
  subtype: boundedText(LIMITS.identifierMaxChars).optional(),
  is_error: z.boolean().optional(),
  result: z.string().max(LIMITS.freeTextMaxChars).optional(),
});

/** Sibling keys `tool_call` carries alongside the tool-variant key. */
const NON_TOOL_KEYS = new Set(["result", "error"]);

type Translation =
  | Readonly<{ kind: "event"; event: AgentEvent }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "rejected" }>;

export type CursorNormalizerOptions = Readonly<{
  taskId: string;
  runId: string;
  startSequence?: number;
  now?: () => Date;
}>;

export type CursorNormalizedBatch = Readonly<{
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
export class CursorEventNormalizer {
  readonly #taskId: string;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #stream = new NdjsonStream();
  #nextSequence: number;

  public constructor(options: CursorNormalizerOptions) {
    this.#taskId = options.taskId;
    this.#runId = options.runId;
    this.#nextSequence = options.startSequence ?? 0;
    this.#now = options.now ?? (() => new Date());
  }

  public push(chunk: string): CursorNormalizedBatch {
    return this.#consume(this.#stream.push(chunk));
  }

  /** Call only after the Cursor process has exited. */
  public finish(): CursorNormalizedBatch {
    return this.#consume(this.#stream.finish());
  }

  #consume(read: NdjsonReadResult): CursorNormalizedBatch {
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
      case "system":
      case "user":
        // agentd owns lifecycle state; provider transport/echo records
        // (session init, the echoed prompt) carry nothing to normalize.
        return { kind: "ignored" };

      case "assistant":
        return this.#translateAssistant(value);

      case "tool_call":
        return this.#translateToolCall(value);

      case "result":
        return this.#translateResult(value);

      default:
        return { kind: "ignored" };
    }
  }

  #translateAssistant(value: unknown): Translation {
    const parsed = providerAssistantEventSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    const text = parsed.data.message.content.find(
      (item) => item.type === "text" && item.text !== undefined,
    )?.text;
    if (text === undefined) return { kind: "rejected" };

    return this.#event("log", {
      level: "info",
      message: redactProviderText(text),
    });
  }

  #translateToolCall(value: unknown): Translation {
    const parsed = providerToolCallEventSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    const { call_id: callId, subtype, tool_call: toolCall } = parsed.data;
    const tool = toolNameFrom(toolCall);
    if (tool === undefined) return { kind: "rejected" };

    return this.#event("tool", {
      phase: subtype,
      callId,
      tool,
    });
  }

  #translateResult(value: unknown): Translation {
    const parsed = providerResultEventSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    // The runner appends its own validated terminal AgentResult once the
    // process exits; a successful `result` record is transport bookkeeping.
    // Only surface the failure as a log line so the reason is not lost.
    if (parsed.data.is_error !== true) return { kind: "ignored" };

    return this.#event("log", {
      level: "error",
      message: redactProviderText(
        parsed.data.result ?? "Cursor reported an error",
      ),
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
      throw new Error(`Cursor normalizer produced an invalid ${type} event`);
    }

    this.#nextSequence += 1;
    return { kind: "event", event: parsed.value };
  }
}

function toolNameFrom(
  toolCall: Readonly<Record<string, unknown>>,
): string | undefined {
  return Object.keys(toolCall).find((key) => !NON_TOOL_KEYS.has(key));
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
export function normalizeCursorStream(
  raw: string,
  options: CursorNormalizerOptions,
): CursorNormalizedBatch {
  const normalizer = new CursorEventNormalizer(options);
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
