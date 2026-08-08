/**
 * Incremental NDJSON reading.
 *
 * Every provider adapter in P3+ inherits this, so its behaviour is the
 * project's answer to "what does a hostile or broken stream do to us?"
 *
 * Four properties:
 *
 *   1. **Records survive chunk boundaries.** A read returns bytes, not lines.
 *      A record split across two reads must be reassembled, not dropped — the
 *      naive `chunk.split("\n")` loses one record per read boundary, silently,
 *      under load.
 *   2. **A bad line costs one record.** Malformed JSON is skipped and counted,
 *      never fatal. A worker that logs a stack trace to stdout must not make
 *      the rest of its run unreadable.
 *   3. **The buffer is bounded.** A stream with no newline is otherwise an
 *      unbounded memory allocation controlled by the worker.
 *   4. **Offsets are exact.** The consumed byte count is reported so a restart
 *      can resume from precisely where it stopped, which is what makes
 *      re-reading `stdout.ndjson` idempotent.
 */

import { decodeJsonLine, MAX_LINE_BYTES } from "@pi-cmux/protocol";

export type NdjsonRecord = Readonly<{
  value: unknown;
  /** Byte offset of the record's terminating newline, plus one. */
  endOffset: number;
}>;

export type NdjsonReadResult = Readonly<{
  records: readonly NdjsonRecord[];
  /** Lines that could not be decoded. */
  rejected: number;
  /** Total bytes consumed, i.e. the offset to resume from. */
  consumedBytes: number;
  /** Bytes held back because the final line is incomplete. */
  pendingBytes: number;
  /** True when the pending buffer exceeded its ceiling. */
  overflowed: boolean;
}>;

export type NdjsonStreamOptions = Readonly<{
  maxLineBytes?: number;
}>;

/**
 * A stateful reader that can be fed successive chunks.
 *
 * Stateful rather than a pure function because the whole point is carrying a
 * partial record across the gap between two reads.
 */
export class NdjsonStream {
  #pending = "";
  #consumedBytes = 0;
  readonly #maxLineBytes: number;

  public constructor(options: NdjsonStreamOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  /** Bytes consumed so far. A restart resumes here. */
  public get offset(): number {
    return this.#consumedBytes;
  }

  /** Bytes buffered awaiting a newline. */
  public get pendingBytes(): number {
    return Buffer.byteLength(this.#pending, "utf8");
  }

  /**
   * Feed a chunk and take whatever complete records it completes.
   *
   * The trailing fragment — everything after the last newline — is retained.
   * It is *not* a record yet, and treating it as one is exactly how a torn
   * final write becomes a parse error in production.
   */
  public push(chunk: string): NdjsonReadResult {
    const combined = this.#pending + chunk;
    const segments = combined.split("\n");

    // The last segment has no terminating newline: either an incomplete record
    // or the empty string when the chunk ended cleanly.
    const trailing = segments.pop() ?? "";

    const records: NdjsonRecord[] = [];
    let rejected = 0;
    let consumedInThisPush = 0;

    for (const segment of segments) {
      // +1 for the newline that terminated it.
      consumedInThisPush += Buffer.byteLength(segment, "utf8") + 1;

      if (segment.trim() === "") continue;

      const decoded = decodeJsonLine(segment, this.#maxLineBytes);
      if (!decoded.ok) {
        rejected += 1;
        continue;
      }

      records.push({
        value: decoded.value,
        endOffset: this.#consumedBytes + consumedInThisPush,
      });
    }

    this.#consumedBytes += consumedInThisPush;

    // A pending buffer past the ceiling means the worker is streaming without
    // newlines. Drop it: retaining it is an unbounded allocation the worker
    // controls, and no valid record can be that long anyway.
    const trailingBytes = Buffer.byteLength(trailing, "utf8");
    const overflowed = trailingBytes > this.#maxLineBytes;
    this.#pending = overflowed ? "" : trailing;
    if (overflowed) {
      this.#consumedBytes += trailingBytes;
      rejected += 1;
    }

    return {
      records,
      rejected,
      consumedBytes: this.#consumedBytes,
      pendingBytes: this.pendingBytes,
      overflowed,
    };
  }

  /**
   * Take the buffered fragment as a final record, if it parses.
   *
   * Called only once the producer has definitely finished: a process that
   * exited without a trailing newline may still have written a complete
   * record. Before exit, the same bytes must stay pending.
   */
  public finish(): NdjsonReadResult {
    if (this.#pending === "") {
      return {
        records: [],
        rejected: 0,
        consumedBytes: this.#consumedBytes,
        pendingBytes: 0,
        overflowed: false,
      };
    }

    const segment = this.#pending;
    const bytes = Buffer.byteLength(segment, "utf8");
    this.#pending = "";
    this.#consumedBytes += bytes;

    if (segment.trim() === "") {
      return {
        records: [],
        rejected: 0,
        consumedBytes: this.#consumedBytes,
        pendingBytes: 0,
        overflowed: false,
      };
    }

    const decoded = decodeJsonLine(segment, this.#maxLineBytes);
    if (!decoded.ok) {
      return {
        records: [],
        rejected: 1,
        consumedBytes: this.#consumedBytes,
        pendingBytes: 0,
        overflowed: false,
      };
    }

    return {
      records: [{ value: decoded.value, endOffset: this.#consumedBytes }],
      rejected: 0,
      consumedBytes: this.#consumedBytes,
      pendingBytes: 0,
      overflowed: false,
    };
  }
}
