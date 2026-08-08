import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NdjsonStream } from "./ndjson-stream.ts";

const line = (n: number): string => `{"n":${String(n)}}\n`;

describe("records survive chunk boundaries", () => {
  it("reassembles a record split across two pushes", () => {
    // The naive `chunk.split("\n")` loses exactly this record, silently.
    const stream = new NdjsonStream();

    const first = stream.push('{"n":1}\n{"n":');
    assert.equal(first.records.length, 1);
    // The 5 bytes of `{"n":` are held, not parsed and not dropped.
    assert.equal(first.pendingBytes, 5);

    const second = stream.push("2}\n");
    assert.equal(second.records.length, 1);
    assert.deepEqual(second.records[0]?.value, { n: 2 });
    assert.equal(second.pendingBytes, 0);
  });

  it("survives a record split one byte at a time", () => {
    const stream = new NdjsonStream();
    const payload = '{"a":"bcdef","g":[1,2,3]}\n';

    const collected: unknown[] = [];
    for (const char of payload) {
      collected.push(...stream.push(char).records.map((r) => r.value));
    }

    assert.deepEqual(collected, [{ a: "bcdef", g: [1, 2, 3] }]);
  });

  it("holds back a trailing fragment instead of parsing it", () => {
    // A half-written line is not a short one. Treating it as a record is how a
    // torn final write becomes a parse error in production.
    const stream = new NdjsonStream();
    const result = stream.push('{"n":1}\n{"n":2');

    assert.equal(result.records.length, 1);
    assert.equal(result.rejected, 0);
    assert.ok(result.pendingBytes > 0);
  });

  it("emits nothing for a chunk with no newline at all", () => {
    const stream = new NdjsonStream();
    const result = stream.push('{"n":1}');
    assert.deepEqual(result.records, []);
    assert.equal(result.rejected, 0);
  });
});

describe("a bad line costs one record", () => {
  it("skips malformed JSON and keeps going", () => {
    const stream = new NdjsonStream();
    const result = stream.push(
      `${line(1)}{ not json\n${line(2)}Traceback (most recent call last):\n${line(3)}`,
    );

    assert.deepEqual(
      result.records.map((r) => r.value),
      [{ n: 1 }, { n: 2 }, { n: 3 }],
    );
    assert.equal(result.rejected, 2);
  });

  it("ignores blank lines without counting them as failures", () => {
    const stream = new NdjsonStream();
    const result = stream.push(`${line(1)}\n   \n${line(2)}`);

    assert.equal(result.records.length, 2);
    assert.equal(result.rejected, 0);
  });

  it("handles CRLF without corrupting the record", () => {
    const stream = new NdjsonStream();
    const result = stream.push('{"n":1}\r\n');
    // The \r is inside the segment; JSON.parse tolerates trailing whitespace.
    assert.deepEqual(result.records[0]?.value, { n: 1 });
  });
});

describe("the buffer is bounded", () => {
  it("drops a pending fragment past the ceiling", () => {
    // Otherwise a worker streaming without newlines is an unbounded allocation
    // it controls.
    const stream = new NdjsonStream({ maxLineBytes: 64 });
    const result = stream.push("x".repeat(500));

    assert.equal(result.overflowed, true);
    assert.equal(result.pendingBytes, 0);
    assert.equal(result.rejected, 1);
  });

  it("rejects an oversized complete line", () => {
    const stream = new NdjsonStream({ maxLineBytes: 64 });
    const result = stream.push(`{"pad":"${"x".repeat(500)}"}\n`);

    assert.equal(result.records.length, 0);
    assert.equal(result.rejected, 1);
  });

  it("recovers and parses the next record after an overflow", () => {
    const stream = new NdjsonStream({ maxLineBytes: 64 });
    stream.push("x".repeat(500));
    const result = stream.push(`\n${line(7)}`);

    assert.deepEqual(
      result.records.map((r) => r.value),
      [{ n: 7 }],
    );
  });
});

describe("offsets are exact", () => {
  it("counts only bytes consumed as complete records", () => {
    const stream = new NdjsonStream();
    stream.push('{"n":1}\n{"n":2');

    // 8 bytes for the first record including its newline. The 5 pending bytes
    // are not consumed, so a restart re-reads them.
    assert.equal(stream.offset, 8);
  });

  it("advances across pushes so a restart resumes exactly", () => {
    const stream = new NdjsonStream();
    stream.push(line(1));
    const afterFirst = stream.offset;
    stream.push(line(2));

    assert.equal(afterFirst, Buffer.byteLength(line(1), "utf8"));
    assert.equal(stream.offset, Buffer.byteLength(line(1) + line(2), "utf8"));
  });

  it("measures bytes, not characters", () => {
    const stream = new NdjsonStream();
    const record = '{"s":"éé"}\n';
    stream.push(record);

    assert.equal(stream.offset, Buffer.byteLength(record, "utf8"));
    assert.notEqual(stream.offset, record.length);
  });

  it("reports each record's own end offset", () => {
    const stream = new NdjsonStream();
    const result = stream.push(line(1) + line(2));

    assert.equal(result.records[0]?.endOffset, 8);
    assert.equal(result.records[1]?.endOffset, 16);
  });
});

describe("finish", () => {
  it("takes a trailing record once the producer has exited", () => {
    // A process can exit having written a complete record with no newline.
    const stream = new NdjsonStream();
    stream.push('{"n":1}\n{"n":2}');

    const finished = stream.finish();
    assert.deepEqual(
      finished.records.map((r) => r.value),
      [{ n: 2 }],
    );
  });

  it("counts a trailing fragment that does not parse", () => {
    const stream = new NdjsonStream();
    stream.push('{"n":1}\n{"n":');

    const finished = stream.finish();
    assert.equal(finished.records.length, 0);
    assert.equal(finished.rejected, 1);
  });

  it("is a no-op when the stream ended cleanly", () => {
    const stream = new NdjsonStream();
    stream.push(line(1));

    const finished = stream.finish();
    assert.equal(finished.records.length, 0);
    assert.equal(finished.rejected, 0);
  });

  it("leaves the offset at the full byte count", () => {
    const stream = new NdjsonStream();
    const raw = '{"n":1}\n{"n":2}';
    stream.push(raw);
    stream.finish();

    assert.equal(stream.offset, Buffer.byteLength(raw, "utf8"));
  });
});
