import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { posixShellJoin, posixShellQuote } from "./shell-quote.ts";

describe("posixShellQuote", () => {
  it("leaves safe argv elements unquoted", () => {
    assert.equal(posixShellQuote("agentd"), "agentd");
    assert.equal(
      posixShellQuote("run_01JQZX3K5T7V9B2N4M6P8R0AWC"),
      "run_01JQZX3K5T7V9B2N4M6P8R0AWC",
    );
  });

  it("quotes metacharacters that would otherwise invoke the shell", () => {
    assert.equal(posixShellQuote("a;b"), "'a;b'");
    assert.equal(posixShellQuote("$(id)"), "'$(id)'");
    assert.equal(posixShellQuote("line\nbreak"), "'line\nbreak'");
    assert.equal(posixShellQuote("it's"), "'it'\"'\"'s'");
  });
});

describe("posixShellJoin", () => {
  it("joins argv without letting one argument break the next", () => {
    assert.equal(
      posixShellJoin(["agentd", "logs", "--follow", "run;rm -rf /"]),
      "agentd logs --follow 'run;rm -rf /'",
    );
  });
});
