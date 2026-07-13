# Trace Compatibility Audit

This audit documents the current `@maida-ai/core` trace boundary. Python
`maida` remains the source of truth; this package is a limited TypeScript mirror
for plugin and integration code that needs to write local Maida traces.

## Current Read and Write Paths

- `loadConfig()` resolves local configuration from defaults, user
  `~/.maida/config.yaml`, project `.maida/config.yaml`, then environment
  variables. By default, traces are stored under `~/.maida`.
- `createRun(runName, { data_dir })` creates
  `runs/<trace_id>/meta.json` and an empty `spans.jsonl`. The `trace_id` is a
  32-character lowercase hex value and is also returned as `run_id` for
  compatibility with older TS callers. Current `meta.json` does not write a
  `run_id` field.
- `appendEvent(traceId, event, config)` accepts Maida event-shaped input and
  writes one normalized current-format span line to
  `runs/<trace_id>/spans.jsonl`.
- `appendSpan(traceId, span, config)` writes caller-provided span-shaped input
  after normalizing span fields and applying storage-boundary redaction.
- `finalizeRun(traceId, status, counts, config)` updates `meta.json` with
  `ended_at`, `duration_ms`, `status`, and `counts`, then appends a synthetic
  root span to `spans.jsonl`.
- `loadValidatedRun(traceId, config)` reads current-format `meta.json` and
  `spans.jsonl` and returns `{ meta, spans }`. It is a storage validator, not
  the Python read-side projection or assertion engine.
- `appendLegacyEvent(runId, event, config)` remains as a narrow compatibility
  helper that writes `runs/<run_id>/events.jsonl`; current `createRun()` and
  `finalizeRun()` do not write legacy `run.json` or `events.jsonl`.

## Known Mismatches With Python Core

- Python's primary write path is the OTel tracing lifecycle
  (`trace`, `traced_run`, `record_llm_call`, `record_tool_call`,
  `record_state`) plus the local span exporter. TypeScript exposes manual
  helpers and does not provide an OTel provider, span processor, lifecycle
  context, or framework callback layer.
- Python projects spans back into Maida event-like records with
  `spans_to_events()` for baseline, diff, assert, viewer, and loop-detection
  consumers. TypeScript currently returns raw validated spans and does not
  implement that projection.
- TypeScript's `appendEvent()` maps event-shaped records to child spans and
  `finalizeRun()` appends a synthetic root span. Python's current run root span
  is produced by the OTel lifecycle and exported when the run ends, then Python
  derives compatibility events from stored spans.
- Python retains legacy `create_run()`, `append_event()`, and `finalize_run()`
  wrappers that write `run.json` and `events.jsonl`. TypeScript's main
  `createRun()` path writes the current OTel-style layout, while
  `appendLegacyEvent()` only appends legacy events for old callers.
- Python's current-format validator checks required `meta.json` fields, field
  types, span event structure, and root-span requirements. TypeScript validates
  the important storage shape, trace IDs, counts, status, span IDs, and root
  presence for finalized runs, but its normalization path is intentionally more
  forgiving for caller-provided spans.

## Unsupported Capabilities

- No Maida CLI commands (`demo`, `list`, `export`, `view`, `baseline`,
  `accept`, `assert`, `diff`, or `init`).
- No baseline, policy, diff, assertion, PR-comment, or acceptance workflow.
- No local viewer/server.
- No framework adapters for LangChain/LangGraph, OpenAI Agents SDK, or CrewAI.
- No tracing decorator/context manager, active-run context, guardrail
  enforcement, or automatic recorders.
- No promise of full Python feature parity.

## Conformance Coverage

- `tests/fixtures/traces/` contains documented current-format fixtures for a
  normal run, a tool loop, and a running trace with no terminal state, plus an
  intentionally malformed trace.
- `tests/fixtures.test.ts` validates the shared metadata and span shape, the
  expected structural signal in each valid fixture, and rejection of the
  malformed fixture.
- These fixtures are the TypeScript-owned inputs for cross-repo consumers. This
  package does not embed or invoke the Python CLI in its test suite; Python-side
  projection and CLI conformance remain in the canonical Python repository.

The writer/reader compatibility work was completed by
[maida-ts#4](https://github.com/maida-ai/maida-ts/issues/4), and the conformance
fixtures were completed by
[maida-ts#5](https://github.com/maida-ai/maida-ts/issues/5).
