# Changelog

## v0.6.0

Install the TypeScript trace writer with `npm install @maida-ai/core@0.6.0`. This package follows the Python `maida-ai` 0.6 compatibility line while keeping its limited write-side scope. Python remains the source of truth for behavior and schema.

### What's new

- **Updated engine contract:** the vendored Python-owned contract now targets `maida-ai` and `maida-assert` v0.6.0. Contract tests check the released engine and Action references.
- **Updated development requirements:** the package now requires Node.js 24 or later and uses current TypeScript, `js-yaml`, and Node types. Configuration loading uses the supported `js-yaml` API.
- **Safer maintenance:** Dependabot, CodeQL, and a security policy were added. The README points new users to the shared released onboarding walkthrough.

### Compatibility and scope

Trace storage remains `meta.json` plus `spans.jsonl` with `spec_version: "0.2.0"`; this release does not add a TypeScript CLI, viewer, baseline engine, or policy evaluator. No trace data migration is required for existing integrations. Node.js 22 is no longer supported; use Node.js 24 or later.

Full changes: [v0.5.3...v0.6.0](https://github.com/maida-ai/maida-ts/compare/v0.5.3...v0.6.0).
