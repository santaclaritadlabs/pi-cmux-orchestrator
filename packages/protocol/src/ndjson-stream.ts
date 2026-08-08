/**
 * Incremental, bounded NDJSON framing shared by every provider adapter.
 *
 * The protocol package already owns single-line JSON decoding. Keeping the
 * incremental form beside it gives adapters one canonical implementation for
 * chunk boundaries, malformed records, output ceilings and durable offsets.
 */

import { decodeJsonLine, MAX_LINE_BYTES } from "./codec.ts";

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

/** A stateful reader that can be fed successive chunks. */
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

  /** Feed a chunk and take every complete record it contains. */
  public push(chunk: string): NdjsonReadResult {
    const combined = this.#pending + chunk;
    const segments = combined.split("\n");
    const trailing = segments.pop() ?? "";

    const records: NdjsonRecord[] = [];
    let rejected = 0;
    let consumedInThisPush = 0;

    for (const segment of segments) {
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

  /** Take a final unterminated fragment after the producer has exited. */
  public finish(): NdjsonReadResult {
    if (this.#pending === "") return this.#emptyResult();

    const segment = this.#pending;
    const bytes = Buffer.byteLength(segment, "utf8");
    this.#pending = "";
    this.#consumedBytes += bytes;

    if (segment.trim() === "") return this.#emptyResult();

    const decoded = decodeJsonLine(segment, this.#maxLineBytes);
    if (!decoded.ok) return { ...this.#emptyResult(), rejected: 1 };

    return {
      ...this.#emptyResult(),
      records: [{ value: decoded.value, endOffset: this.#consumedBytes }],
    };
  }

  #emptyResult(): NdjsonReadResult {
    return {
      records: [],
      rejected: 0,
      consumedBytes: this.#consumedBytes,
      pendingBytes: 0,
      overflowed: false,
    };
  }
}
