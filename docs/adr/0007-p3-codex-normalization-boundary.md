# ADR 0007 — Stabilize Codex normalization before process integration

**Status:** accepted · 2026-08-08

## Context

P3 introduces the first real provider adapter. Process supervision,
cancellation, timeouts and resumable stdout files already exist behind the fake
adapter, but Codex emits its own evolving JSONL vocabulary. Feeding those
records directly to core would leak provider details and let provider transport
state compete with agentd's durable lifecycle.

The official OpenAI non-interactive-mode documentation currently lists
`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and
`error`. Item kinds include agent messages, reasoning, command executions, file
changes, MCP calls, web searches and plan updates.

## Decision

Add `@pi-cmux/adapter-codex` first as a pure, fixture-tested normalization
boundary:

- agent messages become bounded `log` events;
- command, file-change, MCP and web-search items become `tool` events;
- thread/turn bookkeeping is ignored because agentd owns lifecycle state;
- reasoning and plan updates are not persisted;
- unknown provider fields and types are ignored for forward compatibility;
- malformed known records are rejected and counted without ending the stream;
- normalized provider text is redacted before durable persistence;
- provider commands, output and native error codes never cross the boundary.

Incremental NDJSON framing moves from the fake adapter to `packages/protocol`,
next to the existing line codec. This is a behavior-preserving extraction of
the canonical framing implementation, not a second parser.

## Fixture provenance

`fixtures/codex/official-doc-example.ndjson` is copied from OpenAI's documented
example and is only a bootstrap contract test. It is deliberately named so it
cannot be mistaken for a captured provider fixture. The operator capture in ADR
0003 remains required before the parser is connected to the real CLI:

```bash
pnpm fixtures:capture --provider codex --confirm
```

## Consequences

The next P3 slice can add argument construction, bounded process launch and
result collection against a stable normalizer. This slice does not execute
Codex, load credentials, or enable a new daemon route.
