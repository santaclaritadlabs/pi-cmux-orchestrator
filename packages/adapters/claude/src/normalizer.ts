/**
 * Translate `claude -p --output-format stream-json` records into the public
 * `AgentEvent` contract.
 *
 * Protocol reference: docs.claude.com "Run Claude Code programmatically"
 * (headless mode) and the Agent SDK TypeScript reference for `SDKMessage`,
 * fetched during implementation. Confirmed from the official docs: `-p
 * --output-format stream-json --verbose` emits one JSON object per line; the
 * first is `{"type":"system","subtype":"init",...}`; the last is
 * `{"type":"result",...}` carrying `subtype`, `is_error`, `duration_ms`,
 * `total_cost_usd`, `num_turns`, `result`, `session_id`, `usage`; a
 * `system/api_retry` event can appear mid-stream with `attempt`,
 * `max_retries`, `retry_delay_ms`, `error_status`, `error`; subagent messages
 * carry a `parent_tool_use_id`. SIGTERM makes the CLI abort the turn and exit
 * 143 (a normal supervised cancellation, not a crash).
 *
 * ASSUMPTION (not verified against a literal wire capture, only paraphrased
 * secondary documentation): `assistant`/`user` records wrap the Anthropic
 * Messages API shape as `{"type":"assistant","message":{"id","role","content":[...]},
 * "session_id","parent_tool_use_id"}`, where `content` blocks are the
 * standard `{"type":"text","text"}`, `{"type":"tool_use","id","name","input"}`
 * and `{"type":"tool_result","tool_use_id","content","is_error"}` shapes from
 * the Messages API. This mirrors both the SDK reference fetched here and
 * every other public `stream-json` example. If a captured production stream
 * disagrees, only this file and its fixture need to change.
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

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string().max(LIMITS.freeTextMaxChars),
});

const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: boundedText(LIMITS.identifierMaxChars),
  name: boundedText(LIMITS.identifierMaxChars),
});

const toolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: boundedText(LIMITS.identifierMaxChars),
});

const contentBlockSchema = z.looseObject({
  type: boundedText(LIMITS.identifierMaxChars),
});

const messageSchema = z.looseObject({
  content: z.union([z.string(), z.array(z.unknown())]),
});

const providerAssistantOrUserEventSchema = z.looseObject({
  type: z.enum(["assistant", "user"]),
  message: messageSchema,
});

type Translation = Readonly<{
  events: readonly AgentEvent[];
  rejected: number;
  ignored: number;
}>;

const NO_OP: Translation = { events: [], rejected: 0, ignored: 0 };
const IGNORED: Translation = { events: [], rejected: 0, ignored: 1 };
const REJECTED: Translation = { events: [], rejected: 1, ignored: 0 };

export type ClaudeNormalizerOptions = Readonly<{
  taskId: string;
  runId: string;
  startSequence?: number;
  now?: () => Date;
}>;

export type ClaudeNormalizedBatch = Readonly<{
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

/**
 * Stateful because NDJSON records and sequence allocation span read chunks,
 * and because a `tool_result` names its call only by `tool_use_id`: the tool
 * *name* has to be remembered from the `tool_use` block that started it.
 */
export class ClaudeEventNormalizer {
  readonly #taskId: string;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #stream = new NdjsonStream();
  readonly #pendingTools = new Map<string, string>();
  #nextSequence: number;

  public constructor(options: ClaudeNormalizerOptions) {
    this.#taskId = options.taskId;
    this.#runId = options.runId;
    this.#nextSequence = options.startSequence ?? 0;
    this.#now = options.now ?? (() => new Date());
  }

  public push(chunk: string): ClaudeNormalizedBatch {
    return this.#consume(this.#stream.push(chunk));
  }

  /** Call only after the Claude Code process has exited. */
  public finish(): ClaudeNormalizedBatch {
    return this.#consume(this.#stream.finish());
  }

  #consume(read: NdjsonReadResult): ClaudeNormalizedBatch {
    const events: AgentEvent[] = [];
    let rejected = read.rejected;
    let ignored = 0;

    for (const record of read.records) {
      const translated = this.#translate(record.value);
      events.push(...translated.events);
      rejected += translated.rejected;
      ignored += translated.ignored;
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
    if (!envelope.success) return REJECTED;

    switch (envelope.data.type) {
      // Session/turn bookkeeping: init metadata, API-retry notices, plugin
      // and hook lifecycle, and token-level stream deltas. agentd owns
      // lifecycle state; provider transport state cannot mutate it, and
      // hook/plugin internals are not part of the public contract.
      case "system":
      case "stream_event":
        return IGNORED;

      // The terminal `result` record is not translated into an `AgentEvent`:
      // the runner appends a validated `AgentResult` after the process
      // exits, exactly like the Codex adapter.
      case "result":
        return IGNORED;

      case "assistant":
      case "user":
        return this.#translateMessage(value);

      default:
        return IGNORED;
    }
  }

  #translateMessage(value: unknown): Translation {
    const parsed = providerAssistantOrUserEventSchema.safeParse(value);
    if (!parsed.success) return REJECTED;

    const { content } = parsed.data.message;
    if (typeof content === "string") {
      if (content.length === 0) return NO_OP;
      return this.#combine([
        this.#event("log", {
          level: "info",
          message: redactProviderText(content),
        }),
      ]);
    }

    const translations = content.map((block) => this.#translateBlock(block));
    return this.#combine(translations);
  }

  #translateBlock(value: unknown): Translation {
    const block = contentBlockSchema.safeParse(value);
    if (!block.success) return REJECTED;

    switch (block.data.type) {
      case "text": {
        const parsed = textBlockSchema.safeParse(value);
        if (!parsed.success) return REJECTED;
        if (parsed.data.text.length === 0) return NO_OP;
        return this.#combine([
          this.#event("log", {
            level: "info",
            message: redactProviderText(parsed.data.text),
          }),
        ]);
      }

      case "tool_use": {
        const parsed = toolUseBlockSchema.safeParse(value);
        if (!parsed.success) return REJECTED;
        this.#pendingTools.set(parsed.data.id, parsed.data.name);
        return this.#combine([
          this.#event("tool", {
            phase: "started",
            callId: parsed.data.id,
            tool: parsed.data.name,
          }),
        ]);
      }

      case "tool_result": {
        const parsed = toolResultBlockSchema.safeParse(value);
        if (!parsed.success) return REJECTED;
        const tool =
          this.#pendingTools.get(parsed.data.tool_use_id) ?? "unknown";
        this.#pendingTools.delete(parsed.data.tool_use_id);
        return this.#combine([
          this.#event("tool", {
            phase: "completed",
            callId: parsed.data.tool_use_id,
            tool,
          }),
        ]);
      }

      // `thinking`, `redacted_thinking`, `image`, and future block types are
      // forward-compatible: not everything Claude emits is worker progress.
      default:
        return IGNORED;
    }
  }

  #combine(translations: readonly Translation[]): Translation {
    if (translations.length === 0) return NO_OP;
    return translations.reduce((acc, next) => ({
      events: [...acc.events, ...next.events],
      rejected: acc.rejected + next.rejected,
      ignored: acc.ignored + next.ignored,
    }));
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
      throw new Error(`Claude normalizer produced an invalid ${type} event`);
    }

    this.#nextSequence += 1;
    return { events: [parsed.value], rejected: 0, ignored: 0 };
  }
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
export function normalizeClaudeStream(
  raw: string,
  options: ClaudeNormalizerOptions,
): ClaudeNormalizedBatch {
  const normalizer = new ClaudeEventNormalizer(options);
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
