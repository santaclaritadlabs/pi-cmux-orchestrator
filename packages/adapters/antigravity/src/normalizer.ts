/**
 * Translate `agy --output-format stream-json` records into the public
 * `AgentEvent` contract.
 *
 * Verified against two real transcripts captured 2026-08-08 by running the
 * installed `agy` (v1.1.11) binary with stdout redirected to a plain file
 * (agentd's actual spawn model — never a pty), not merely against
 * https://antigravity.google/docs/cli/headless. The docs and reality mostly
 * agree, with one load-bearing gap the docs did not mention: a failed tool
 * step reports `step_update.state: "ERROR"`, a third value beyond the
 * documented `"ACTIVE"`/`"DONE"`. `state` is therefore treated as an open
 * bounded string rather than a closed enum — `"ACTIVE"` is the only
 * "started" signal, and anything else (`"DONE"`, `"ERROR"`, and any future
 * terminal value) is "completed" — so a provider-side state this adapter has
 * not seen yet is normalized, not silently dropped.
 *
 * Provider records are untrusted and intentionally do not cross this module.
 * Unknown provider fields and event/step types are ignored for forward
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
  event: boundedText(LIMITS.identifierMaxChars),
});

const providerToolErrorSchema = z.looseObject({
  type: z.string().max(LIMITS.freeTextMaxChars).optional(),
  message: z.string().max(LIMITS.freeTextMaxChars).optional(),
});

const providerToolInfoSchema = z.looseObject({
  name: boundedText(LIMITS.identifierMaxChars).optional(),
  error: providerToolErrorSchema.optional(),
});

const STEP_TYPES = [
  "user_input",
  "agent_response",
  "tool",
  "checkpoint",
] as const;

const providerStepUpdateSchema = z.looseObject({
  step_index: z.int(),
  /**
   * An open set: `"ACTIVE"` and `"DONE"` are documented, `"ERROR"` is
   * confirmed from a real transcript, and other terminal values are
   * plausible but not yet observed. See the module docstring.
   */
  state: boundedText(LIMITS.identifierMaxChars),
  step_type: z.string().max(LIMITS.identifierMaxChars),
  tool_name: boundedText(LIMITS.identifierMaxChars).optional(),
  text_delta: z.string().max(LIMITS.freeTextMaxChars).optional(),
  duration_seconds: z.number().min(0).optional(),
  tool_info: providerToolInfoSchema.optional(),
});

const providerStepUpdateEnvelopeSchema = z.looseObject({
  event: z.literal("step_update"),
  step_update: providerStepUpdateSchema,
});

type Translation =
  | Readonly<{ kind: "event"; event: AgentEvent }>
  | Readonly<{ kind: "events"; events: readonly AgentEvent[] }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "rejected" }>;

export type AntigravityNormalizerOptions = Readonly<{
  taskId: string;
  runId: string;
  startSequence?: number;
  now?: () => Date;
}>;

export type AntigravityNormalizedBatch = Readonly<{
  events: readonly AgentEvent[];
  /** Invalid JSON or a malformed record of a recognized provider type. */
  rejected: number;
  /** Well-formed transport bookkeeping or a forward-compatible unknown type. */
  ignored: number;
  /** Byte offset from which a durable reader can resume. */
  offset: number;
  pendingBytes: number;
  overflowed: boolean;
  /**
   * True once any `step_update` for a `step_type: "tool"` step has carried a
   * `tool_info.error` — cumulative since the normalizer was constructed,
   * unlike `rejected`/`ignored`, which are per-call deltas. A caller deciding
   * the terminal run status needs "did this ever happen across the whole
   * run", not "did it happen in this chunk": `agy`'s exit code and its own
   * `result` envelope can both claim success after a denied tool call, so
   * this is the one signal a caller can trust instead.
   */
  sawToolError: boolean;
}>;

/** Stateful because NDJSON records and sequence allocation span read chunks. */
export class AntigravityEventNormalizer {
  readonly #taskId: string;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #stream = new NdjsonStream();
  #nextSequence: number;
  #sawToolError = false;

  public constructor(options: AntigravityNormalizerOptions) {
    this.#taskId = options.taskId;
    this.#runId = options.runId;
    this.#nextSequence = options.startSequence ?? 0;
    this.#now = options.now ?? (() => new Date());
  }

  public push(chunk: string): AntigravityNormalizedBatch {
    return this.#consume(this.#stream.push(chunk));
  }

  /** Call only after the Antigravity CLI process has exited. */
  public finish(): AntigravityNormalizedBatch {
    return this.#consume(this.#stream.finish());
  }

  #consume(read: NdjsonReadResult): AntigravityNormalizedBatch {
    const events: AgentEvent[] = [];
    let rejected = read.rejected;
    let ignored = 0;

    for (const record of read.records) {
      const translated = this.#translate(record.value);
      if (translated.kind === "event") events.push(translated.event);
      if (translated.kind === "events") events.push(...translated.events);
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
      sawToolError: this.#sawToolError,
    };
  }

  #translate(value: unknown): Translation {
    const envelope = providerEnvelopeSchema.safeParse(value);
    if (!envelope.success) return { kind: "rejected" };

    switch (envelope.data.event) {
      case "init":
      case "result":
        // agentd owns lifecycle state, so this envelope's own `result.status`
        // is never trusted for the terminal AgentResult — including because
        // it can itself claim success after a denied tool call (see
        // `#sawToolError`). The runner still ignores it here; `step_update`
        // is where a trustworthy signal actually lives.
        return { kind: "ignored" };

      case "step_update":
        return this.#translateStepUpdate(value);

      default:
        return { kind: "ignored" };
    }
  }

  #translateStepUpdate(value: unknown): Translation {
    const parsed = providerStepUpdateEnvelopeSchema.safeParse(value);
    if (!parsed.success) return { kind: "rejected" };

    const step = parsed.data.step_update;
    if (!isStepType(step.step_type)) return { kind: "ignored" };

    if (step.step_type === "user_input" || step.step_type === "checkpoint") {
      return { kind: "ignored" };
    }

    if (step.step_type === "agent_response") {
      if (step.text_delta === undefined || step.text_delta.length === 0) {
        return { kind: "ignored" };
      }
      return this.#event("log", {
        level: "info",
        message: redactProviderText(step.text_delta),
      });
    }

    // step.step_type === "tool"
    const tool = step.tool_info?.name ?? step.tool_name;
    if (tool === undefined) return { kind: "rejected" };

    const started = step.state === "ACTIVE";
    const durationMs =
      !started && step.duration_seconds !== undefined
        ? Math.round(step.duration_seconds * 1000)
        : undefined;

    const toolEvent = this.#event("tool", {
      phase: started ? "started" : "completed",
      callId: String(step.step_index),
      tool,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    if (toolEvent.kind !== "event") return toolEvent;

    const providerError = step.tool_info?.error;
    if (started || providerError === undefined) return toolEvent;

    this.#sawToolError = true;

    const errorEvent = this.#event("log", {
      level: "error",
      message: redactProviderText(
        providerError.message ??
          providerError.type ??
          "Antigravity tool call failed",
      ),
    });
    if (errorEvent.kind !== "event") return toolEvent;
    return { kind: "events", events: [toolEvent.event, errorEvent.event] };
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
      throw new Error(
        `Antigravity normalizer produced an invalid ${type} event`,
      );
    }

    this.#nextSequence += 1;
    return { kind: "event", event: parsed.value };
  }
}

function isStepType(value: string): value is (typeof STEP_TYPES)[number] {
  return (STEP_TYPES as readonly string[]).includes(value);
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
export function normalizeAntigravityStream(
  raw: string,
  options: AntigravityNormalizerOptions,
): AntigravityNormalizedBatch {
  const normalizer = new AntigravityEventNormalizer(options);
  const pushed = normalizer.push(raw);
  const finished = normalizer.finish();

  return {
    events: [...pushed.events, ...finished.events],
    rejected: pushed.rejected + finished.rejected,
    ignored: pushed.ignored + finished.ignored,
    offset: finished.offset,
    pendingBytes: finished.pendingBytes,
    overflowed: pushed.overflowed || finished.overflowed,
    sawToolError: finished.sawToolError,
  };
}
