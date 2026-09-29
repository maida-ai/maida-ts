# Contributing to `@maida-ai/core`

Thanks for contributing.

## Versioning

`@maida-ai/core` uses the Python engine's `MAJOR.MINOR` compatibility line and its own `PATCH` number, with immutable full release tags. Release on a new engine line only after the Python-owned trace contract, conformance fixtures, and supported reader versions pass. Advance this package's patch for its own compatible fixes. During `0.x`, document incompatible changes when adopting a new minor line. Do not publish an empty release solely because `maida-ai` released. See the [cross-repository policy](https://github.com/maida-ai/maida/blob/main/CONTRIBUTING.md#versioning-and-compatibility).

Before tagging a release, update `package.json`, `package-lock.json`, and the matching `CHANGELOG.md` section, then merge the release workflow and these changes. Pushing a full `vMAJOR.MINOR.PATCH` tag runs tests against that commit and prepares a draft GitHub release with a verified source archive, checksums, and provenance for review. This workflow does not publish to npm; npm publication is a separate release step. Tags created before the workflow and package-version changes cannot use this automation without moving the tag.

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
- write-side current trace storage compatibility
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

1. Create a trace from TS (`createRun` + `appendEvent` or `appendSpan` + `finalizeRun`)
2. Read it using Python storage helpers (`load_validated_run`, `load_events`)
3. Confirm the Python `maida` tooling can read it correctly

## Style notes

- Keep APIs explicit and small.
- Prefer pure functions for data transforms.
- Avoid adding runtime dependencies unless necessary.
- Keep naming and output fields aligned with Python.
