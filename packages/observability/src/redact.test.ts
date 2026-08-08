import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REDACTED, redact, redactString } from "./redact.ts";

/** Serializes the redacted value so a leak anywhere in it is detectable. */
function rendered(value: unknown): string {
  return JSON.stringify(redact(value));
}

describe("redaction by key name", () => {
  it("redacts credential-bearing keys whatever their spelling", () => {
    const out = rendered({
      Authorization: "Basic dXNlcjpwYXNz",
      API_KEY: "plain-value",
      "api-key": "plain-value",
      apiKey: "plain-value",
      refresh_token: "plain-value",
      clientSecret: "plain-value",
      password: "hunter2",
      Cookie: "session=abc",
    });

    assert.equal(out.includes("dXNlcjpwYXNz"), false);
    assert.equal(out.includes("plain-value"), false);
    assert.equal(out.includes("hunter2"), false);
    assert.equal(out.includes("session=abc"), false);
  });

  it("redacts an entire environment block, reporting only its size", () => {
    // CLAUDE.md names raw environment variables specifically.
    const out = redact({
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-live-abc", HOME: "/root" },
    }) as Record<string, unknown>;

    assert.equal(out["env"], "[REDACTED:3 entries]");
    assert.equal(JSON.stringify(out).includes("/usr/bin"), false);
  });

  it("leaves ordinary keys alone", () => {
    const out = redact({ runId: "run_01J", exitCode: 0, dirty: false });
    assert.deepEqual(out, { runId: "run_01J", exitCode: 0, dirty: false });
  });
});

describe("redaction by value shape", () => {
  const cases: readonly [string, string][] = [
    ["openai", "sk-proj-abcdefghijklmnop1234567890"],
    ["anthropic", "sk-ant-api03-abcdefghijklmnopqrstuv"],
    ["github", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["google", "AIzaSyA1234567890abcdefghijklmnopqrs"],
    ["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
    ["slack", "xoxb-123456789012-abcdefghijkl"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ],
  ];

  for (const [name, secret] of cases) {
    it(`redacts a ${name} credential found in free text`, () => {
      const out = redactString(`worker failed using ${secret} for auth`);
      assert.equal(out.includes(secret), false, `leaked: ${out}`);
      assert.match(out, /\[REDACTED:/);
      // The surrounding context survives, which is what makes the log useful.
      assert.match(out, /worker failed using/);
    });
  }

  it("redacts a Bearer header value", () => {
    const out = redactString("Authorization: Bearer abcdef0123456789ABCDEF");
    assert.equal(out.includes("abcdef0123456789ABCDEF"), false);
  });

  it("redacts credentials embedded in a URL", () => {
    const out = redactString(
      "cloning https://oauth2:ghp_secret@github.com/a/b",
    );
    assert.equal(out.includes("ghp_secret"), false);
    // The host survives, so the log still says which remote was involved.
    assert.match(out, /github\.com/);
  });

  it("redacts a PEM private key block", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactString(`key material: ${pem}`);
    assert.equal(out.includes("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU"), false);
  });

  it("redacts a credential-named environment assignment in a command line", () => {
    const out = redactString("env GITHUB_TOKEN=ghs_abc123 npm publish");
    assert.equal(out.includes("ghs_abc123"), false);
    assert.match(out, /npm publish/);
  });

  it("does not mangle the identifiers we log on purpose", () => {
    // Entropy-based detection would eat these; the patterns are prefix-anchored
    // specifically so git SHAs and digests stay readable.
    const sha = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    const out = redactString(`head ${sha} artifact ${digest}`);
    assert.match(out, new RegExp(sha));
    assert.match(out, new RegExp(digest));
  });
});

describe("redaction reaches everywhere in a structure", () => {
  it("finds a secret nested inside arrays and objects", () => {
    const out = rendered({
      runs: [
        { steps: [{ detail: { note: "token sk-abcdefghijklmnop123456" } }] },
      ],
    });
    assert.equal(out.includes("sk-abcdefghijklmnop123456"), false);
  });

  it("redacts a sensitive key at any depth", () => {
    const out = rendered({ a: { b: { c: { authorization: "Basic zzz" } } } });
    assert.equal(out.includes("Basic zzz"), false);
  });

  it("never spreads an Error's cause chain", () => {
    // An fs or provider Error routinely carries paths and argv in its message.
    const inner = new Error("ENOENT: open '/Users/x/.ssh/id_ed25519'");
    const outer = new Error("spawn failed", { cause: inner });
    const out = rendered({ error: outer });

    assert.equal(out.includes("id_ed25519"), false);
    assert.match(out, /spawn failed/);
  });
});

describe("redaction is safe on hostile input", () => {
  it("survives a cycle instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "run" };
    cyclic["self"] = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    assert.equal(out["self"], "[Circular]");
  });

  it("stops at the depth ceiling rather than overflowing the stack", () => {
    let nested: Record<string, unknown> = { end: "value" };
    for (let i = 0; i < 5_000; i += 1) nested = { next: nested };

    // The point is that this returns at all.
    const out = redact(nested);
    assert.match(JSON.stringify(out), /TRUNCATED:too-deep/);
  });

  it("stops at the node ceiling", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i += 1) wide[`k${String(i)}`] = i;
    assert.match(JSON.stringify(redact(wide)), /TRUNCATED:too-many-values/);
  });

  it("truncates a long string even when nothing matches", () => {
    // Bounds an untrusted prompt or a flood of provider output.
    const out = redactString("x".repeat(10_000));
    assert.ok(out.length < 600);
    assert.match(out, /truncated/);
  });

  it("redacts every occurrence, not just the first", () => {
    // Guards the shared `lastIndex` on the global regexes.
    const out = redactString(
      "a sk-aaaaaaaaaaaaaaaaaa b sk-bbbbbbbbbbbbbbbbbb c sk-cccccccccccccccccc",
    );
    assert.equal(out.includes("sk-aaaa"), false);
    assert.equal(out.includes("sk-bbbb"), false);
    assert.equal(out.includes("sk-cccc"), false);
  });

  it("is stable across repeated calls", () => {
    const input = "token sk-abcdefghijklmnop123456";
    assert.equal(redactString(input), redactString(input));
  });

  it("handles the primitives JSON can carry", () => {
    assert.equal(redact(null), null);
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
    assert.deepEqual(redact([1, "a"]), [1, "a"]);
  });
});

describe("known limits", () => {
  it("cannot catch a secret split across two fields", () => {
    // Documented rather than silently assumed: the real control is not giving
    // a worker credentials it does not need (spec §18). This test exists so
    // the limitation is visible instead of discovered during an incident.
    const out = rendered({ half1: "sk-abcdefgh", half2: "ijklmnop123456" });
    assert.match(out, /ijklmnop123456/);
  });

  it("redacts by key name even when the value looks harmless", () => {
    assert.equal(
      (redact({ token: "1" }) as Record<string, unknown>)["token"],
      REDACTED,
    );
  });
});
