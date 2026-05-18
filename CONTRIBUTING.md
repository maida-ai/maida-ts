# Contributing to `@maida-ai/core`

Thanks for contributing.

## Source of truth policy

The Python `maida` package is the source of truth.

This TS package is a compatibility mirror for plugin development, so behavior and schema should track Python, not diverge from it.

Canonical reference modules:

- `maida/maida/events.py`
- `maida/maida/constants.py`
- `maida/maida/storage.py`
- `maida/maida/config.py`
- `maida/maida/_tracing/_redact.py`
- `maida/maida/loopdetect.py`

When updating TS logic, verify it still matches Python outputs and field names.

## Scope

Please keep this package focused on a limited interface:

- schema/types
- pure helpers (events/redaction/loop detection)
- write-side storage compatibility
- config loading compatibility

Do not add viewer/CLI features here; those belong to Python `maida`.

## Development workflow

```bash
npm install
npm run build
npm test
```

## Compatibility checks

Before merging changes that affect storage or event schema:

1. Create a run from TS (`createRun` + `appendEvent` + `finalizeRun`)
2. Read it using Python storage helpers (`load_run_meta`, `load_events`)
3. Confirm the Python `maida` tooling can read it correctly

## Style notes

- Keep APIs explicit and small.
- Prefer pure functions for data transforms.
- Avoid adding runtime dependencies unless necessary.
- Keep naming and output fields aligned with Python.
