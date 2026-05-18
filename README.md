# `@maida-ai/core`

TypeScript mirror for Maida.

`@maida-ai/core` is a limited, write-side mirror of the main Maida project at `github.com/maida-ai/maida.git`. It helps TS/JS integrations write local run data in the same on-disk format that the Python Maida tooling reads.

Python remains the source of truth for behavior and schema.

## What this package is

- A small TS library that mirrors core Maida schema and helpers.
- A local-first storage layer that writes `run.json` and `events.jsonl` under `~/.maida/runs/<run_id>/`.
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
  run.run_id,
  newEvent(EventType.RUN_START, run.run_id, "my-plugin-run", {}),
  { data_dir: config.data_dir },
);

appendEvent(
  run.run_id,
  newEvent(EventType.LLM_CALL, run.run_id, "gpt-4", {
    model: "gpt-4",
    prompt: "hello",
    response: "world",
  }),
  { data_dir: config.data_dir },
);

appendEvent(
  run.run_id,
  newEvent(EventType.RUN_END, run.run_id, "my-plugin-run", { status: "ok" }),
  { data_dir: config.data_dir },
);

finalizeRun(
  run.run_id,
  "ok",
  { llm_calls: 1, tool_calls: 0, errors: 0, loop_warnings: 0 },
  { data_dir: config.data_dir },
);
```

The resulting run lives under `~/.maida/runs/<run_id>/` by default and can be consumed by the Python Maida tooling.

## Exposed API

- Types and schema: `EventType`, `MaidaEvent`, `RunMeta`, `RunCounts`, `MaidaConfig`, `GuardrailParams`
- Constants: `SPEC_VERSION`, `REDACTED_MARKER`, `TRUNCATED_MARKER`, `DEPTH_LIMIT`, `defaultCounts`
- Events: `newEvent`, `utcNowIsoMsZ`, `ensureJsonSafe`
- Storage: `createRun`, `appendEvent`, `finalizeRun`, `validateRunId`
- Config: `loadConfig`
- Redaction: `redactAndTruncate`, `truncateString`, `keyMatchesRedact`, `normalizeUsage`, `buildErrorPayload`
- Loop detection: `computeSignature`, `detectLoop`, `patternKey`

## Limitations

- This package intentionally stays small and write-side focused.
- Read-side helpers remain in the Python Maida implementation.
- Compatibility target is Linux and macOS plugin environments.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0
