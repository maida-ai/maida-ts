# `@maida-ai/core`

TypeScript mirror for Maida.

**Versioning:** This package shares the Python engine's `MAJOR.MINOR` compatibility line and has its own patch releases. Compatibility is checked against the shared trace contract; matching numbers alone do not establish feature parity. See [contributing](https://github.com/maida-ai/maida-ts/blob/main/CONTRIBUTING.md#versioning).

`@maida-ai/core` is a limited, write-side mirror of the main Maida project at `github.com/maida-ai/maida.git`. It helps TS/JS integrations write local trace data in the same on-disk format that the Python Maida tooling reads.

Python remains the source of truth for behavior and schema.

## First time using Maida?

```bash
uv tool install "maida-ai==0.6.1"
maida demo --regression
```

Expect a deliberate FAIL and a PR-comment preview. Continue with the [released coding-agent walkthrough](https://maida.ai/docs/getting-started/): capture one task, review a few checks, prove pass/fail/repair, then add CI. Runnable examples and demos live together in [maida-tutorials](https://github.com/maida-ai/maida-tutorials).

## What this package is

- A small TS library that mirrors core Maida schema and helpers.
- A local-first storage layer that writes `meta.json` and `spans.jsonl` under `~/.maida/runs/<trace_id>/`.
- A package for plugin authors and integration code that wants to produce Maida-compatible run traces.

## What this package is not

- Not a full port of Python `maida`.
- Not the main CLI. Use `github.com/maida-ai/maida.git` for the canonical CLI and read-side tooling.
- Not a viewer, dashboard, or hosted service.
- Not the full runtime tracing decorator/context-manager layer from Python.

## Product framing

Maida is a local-first, pre-merge behavioral regression gate for AI agents. This package supports that workflow by writing structural run data that the main Maida tooling can compare against checked-in baselines and policy.

## Source of truth

The Python package is canonical:

- `maida/maida/events.py`
- `maida/maida/constants.py`
- `maida/maida/storage.py`
- `maida/maida/config.py`
- `maida/maida/_tracing/_redact.py`
- `maida/maida/loopdetect.py`

When Python behavior changes, this TS package should be updated to mirror it.

## Installation

```bash
npm install @maida-ai/core
```

## Quick usage

```ts
import {
  appendEvent,
  createRun,
  EventType,
  finalizeRun,
  loadConfig,
  newEvent,
} from "@maida-ai/core";

const config = loadConfig();

const run = createRun("my-plugin-run", { data_dir: config.data_dir });

appendEvent(
  run.trace_id,
  newEvent(EventType.RUN_START, run.trace_id, "my-plugin-run", {}),
  { data_dir: config.data_dir },
);

appendEvent(
  run.trace_id,
  newEvent(EventType.LLM_CALL, run.trace_id, "gpt-4", {
    model: "gpt-4",
    prompt: "hello",
    response: "world",
  }),
  { data_dir: config.data_dir },
);

appendEvent(
  run.trace_id,
  newEvent(EventType.RUN_END, run.trace_id, "my-plugin-run", { status: "ok" }),
  { data_dir: config.data_dir },
);

finalizeRun(
  run.trace_id,
  "ok",
  { llm_calls: 1, tool_calls: 0, errors: 0, loop_warnings: 0 },
  { data_dir: config.data_dir },
);
```

The resulting trace lives under `~/.maida/runs/<trace_id>/` by default and can be consumed by the Python Maida tooling.

## Trace compatibility

Current TS-produced traces target Maida `spec_version: "0.2.0"` and use the same
local storage layout as Python:

```text
~/.maida/runs/<trace_id>/
  meta.json
  spans.jsonl
```

`meta.json` contains the run-level `spec_version`, `trace_id`, status, timing,
and counts. `spans.jsonl` contains one span JSON object per line; span rows do
not include their own `spec_version`. `loadValidatedRun()` validates this
current storage shape, accepts the legacy `"0.2"` spelling and compatible
`0.2.x` patch versions, and tolerates older TS-produced span rows that include
an extra span-level `spec_version` field by ignoring that additive field.

`installValidatedRun()` installs a complete, already-normalized current-format
run through the same strict metadata and span checks before making it visible.
Both validated read paths enforce Python's RFC 3339 timestamp, span/event type,
single-root, parent-reference, duplicate-ID, and parent-cycle rules. Running
traces may temporarily reference a parent that has not been written yet, just
as they may in Python; completed traces may not.
It does not normalize or redact provider payloads. Callers must apply
`redactAndTruncate()` while translating external data, then pass the resulting
metadata and spans; existing run directories are never intentionally replaced.

Loop detection mirrors Python's argument identity: tool name plus a fixed-size SHA-256 fingerprint of canonicalized arguments. Apply `redactAndTruncate()` with your capture configuration before calling `computeSignature()` or `detectLoop()`. Object key order is ignored; scalar values, array order, and all available items determine equality. Identical calls repeat; different commands or file paths do not; alternating arguments can form a cycle. Raw argument values and keys never appear in signatures or warning patterns. Differences removed by redaction or truncation cannot distinguish actions; missing or null args retain name-only matching. `LoopWarningPayload` includes `pattern_type` (`repeated_call` or `cycle`) and `pattern_length`. Older stored warnings remain readable with their original patterns.

The compatibility fixtures in `tests/fixtures/traces/` cover normal,
tool-loop, running/missing-terminal-state, and malformed trace cases for other
Maida repos to copy or read during cross-repo conformance work.
Python-owned contracts under `tests/contracts/` cover shared versions,
validation decisions, and loop behavior. Python remains authoritative when a
contract changes.

## Exposed API

- Types and schema: `EventType`, `MaidaEvent`, `RunMeta`, `RunCounts`, `MaidaConfig`, `GuardrailParams`
- Constants: `SPEC_VERSION`, `REDACTED_MARKER`, `TRUNCATED_MARKER`, `DEPTH_LIMIT`, `defaultCounts`
- Events: `newEvent`, `utcNowIsoMsZ`, `ensureJsonSafe`
- Storage: `createRun`, `appendEvent`, `appendSpan`, `appendLegacyEvent`, `finalizeRun`, `installValidatedRun`, `loadValidatedRun`, `validateTraceId`, `validateRunId`
- Config: `loadConfig`
- Redaction: `redactAndTruncate`, `truncateString`, `keyMatchesRedact`, `normalizeUsage`, `buildErrorPayload`
- Loop detection: `computeSignature`, `detectLoop`, `patternKey`

## Limitations

- This package intentionally stays small and write-side focused.
- `loadValidatedRun()` is a storage validator, not the Python projection,
  baseline, diff, assertion, or viewer engine.
- Read-side product workflows remain in the Python Maida implementation.
- Framework adapters (including Langfuse import), tracing decorators/context
  managers, guardrail enforcement, the CLI, and the local viewer are
  Python-only surfaces.
- The package does not promise full Python feature parity.
- Compatibility target is Linux and macOS plugin environments.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0
