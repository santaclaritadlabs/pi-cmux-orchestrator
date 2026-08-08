import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NdjsonStream } from "./ndjson-stream.ts";

const line = (n: number): string => `{"n":${String(n)}}\n`;

describe("NdjsonStream", () => {
  it("reassembles records across arbitrary chunk boundaries", () => {
    const stream = new NdjsonStream();
    const raw = '{"a":"é"}\n{"n":2}\n';
    const values: unknown[] = [];

    for (const character of raw) {
      values.push(
        ...stream.push(character).records.map((record) => record.value),
      );
    }

    assert.deepEqual(values, [{ a: "é" }, { n: 2 }]);
    assert.equal(stream.offset, Buffer.byteLength(raw, "utf8"));
  });

  it("holds an unterminated record until finish", () => {
    const stream = new NdjsonStream();
    const live = stream.push(`${line(1)}{"n":2}`);

    assert.deepEqual(
      live.records.map((record) => record.value),
      [{ n: 1 }],
    );
    assert.equal(live.rejected, 0);
    assert.ok(live.pendingBytes > 0);

    const finished = stream.finish();
    assert.deepEqual(
      finished.records.map((record) => record.value),
      [{ n: 2 }],
    );
    assert.equal(finished.pendingBytes, 0);
  });

  it("counts one malformed line and continues", () => {
    const stream = new NdjsonStream();
    const result = stream.push(`${line(1)}not json\n${line(2)}`);

    assert.deepEqual(
      result.records.map((record) => record.value),
      [{ n: 1 }, { n: 2 }],
    );
    assert.equal(result.rejected, 1);
  });

  it("ignores blank lines and accepts CRLF framing", () => {
    const stream = new NdjsonStream();
    const result = stream.push('\n  \n{"n":1}\r\n');

    assert.deepEqual(
      result.records.map((record) => record.value),
      [{ n: 1 }],
    );
    assert.equal(result.rejected, 0);
  });

  it("bounds a producer that never writes a newline", () => {
    const stream = new NdjsonStream({ maxLineBytes: 64 });
    const overflow = stream.push("x".repeat(500));

    assert.equal(overflow.overflowed, true);
    assert.equal(overflow.pendingBytes, 0);
    assert.equal(overflow.rejected, 1);

    const recovered = stream.push(`\n${line(7)}`);
    assert.deepEqual(
      recovered.records.map((record) => record.value),
      [{ n: 7 }],
    );
  });

  it("rejects an oversized complete record", () => {
    const stream = new NdjsonStream({ maxLineBytes: 64 });
    const result = stream.push(`{"pad":"${"x".repeat(500)}"}\n`);

    assert.equal(result.records.length, 0);
    assert.equal(result.rejected, 1);
  });

  it("reports exact UTF-8 offsets per record", () => {
    const stream = new NdjsonStream();
    const first = '{"s":"é"}\n';
    const second = line(2);
    const result = stream.push(first + second);

    assert.equal(
      result.records[0]?.endOffset,
      Buffer.byteLength(first, "utf8"),
    );
    assert.equal(
      result.records[1]?.endOffset,
      Buffer.byteLength(first + second, "utf8"),
    );
    assert.equal(stream.offset, Buffer.byteLength(first + second, "utf8"));
  });

  it("does not advance its resumable offset past pending bytes", () => {
    const stream = new NdjsonStream();
    stream.push(`${line(1)}{"n":2`);

    assert.equal(stream.offset, Buffer.byteLength(line(1), "utf8"));
  });

  it("counts a malformed final fragment exactly once", () => {
    const stream = new NdjsonStream();
    stream.push(`${line(1)}{"n":`);

    const finished = stream.finish();
    assert.equal(finished.records.length, 0);
    assert.equal(finished.rejected, 1);
  });
});
