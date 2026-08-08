# ADR 0003 — Capture real provider output once, test offline forever

**Status:** accepted · 2026-08-08

## Context

Spec P0 requires "fixtures reales de output de los cuatro CLIs". `CLAUDE.md` P0
says "No real CLI execution."

All four CLIs are installed on the development machine, so both readings are
achievable. The question is what the adapter parsers in P3+ get validated
against: recorded reality, or our reading of the documentation.

## Decision

Capture real output **once, by hand, by an operator**, redact it, commit it, and
never run a provider CLI again from code or CI.

`packages/testkit/src/capture-fixtures.ts` is the only code in the repository
that invokes a provider CLI. It:

- refuses to run without `--confirm`;
- creates a disposable git repo in a tmpdir and gives every provider the same
  trivial objective;
- spawns with argv arrays, never a shell;
- redacts stdout line by line before writing;
- records the **resolved binary path** and its `--version` in `metadata.json`.

That last point is not bookkeeping. On this machine `codex` and `claude` resolve
to cmux shims under a temp directory, so "which binary produced this fixture?"
is not answerable from the command name. Without it, a future format mismatch is
undiagnosable.

## Alternatives rejected

**Hand-written fixtures from documentation.** Free, and satisfies `CLAUDE.md` P0
literally. But it validates the parsers against a format we assumed, which is
the failure mode fixtures exist to prevent — and the spec warns specifically
that Cursor's headless stream drops events in ways its documentation does not
describe.

**Capture Codex only.** A reasonable middle, but the other three fixtures would
still be assumptions, and the capture is a single cheap operation.

## Consequences

- The repository contains recorded third-party output. It is redacted
  automatically and must be reviewed by hand before committing; the script says
  so and `metadata.json` repeats it.
- `fixtures/**/raw/` is gitignored so un-redacted output cannot be committed by
  accident.
- Every test remains offline and deterministic. CI needs no credentials and no
  network.
- Fixtures go stale as providers change. `metadata.json` records what produced
  them, so staleness is diagnosable rather than mysterious.
- `CLAUDE.md`'s "no real CLI execution" is honoured where it matters — in the
  shipped code and in CI. The exception is an operator tool, run deliberately,
  and it is written down here.

## Status of the capture

The adversarial fixtures are written and tested. **The real provider capture has
not been run** — it needs the operator's credentials and network access, and
costs money. Run it with:

```bash
pnpm fixtures:capture --provider all --confirm
git diff fixtures/          # review the redaction by hand before committing
```
