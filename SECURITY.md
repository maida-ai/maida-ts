# Security Policy

## Supported versions

Security fixes target the latest released `@maida-ai/core` package. Upgrade older versions. Reports about older versions are welcome; reproduce on the latest release when possible. Include the installed package version and, for an unreleased checkout, the commit SHA.

This package is a limited, write-side TypeScript mirror. The Python engine is maintained separately; include its version if a report involves reading or comparing the generated traces.

## Reporting a vulnerability

Email [security@maida.ai](mailto:security@maida.ai) privately. Do not post vulnerability details publicly before coordinated disclosure.

Include the package version, Node.js version, operating system, impact, reproduction steps and a contact address. Remove secrets, customer data and sensitive traces from the reproduction. Use simulated data where possible; do not send credentials or unredacted trace files.

## Response and disclosure

We aim to acknowledge reports within five business days. This is an acknowledgement target, not a guaranteed fix deadline. Resolution depends on severity and complexity. We coordinate investigation, fixes and disclosure with the reporter, and communicate the next steps after initial triage.

## Repository security controls

- [Dependabot](.github/dependabot.yml) checks npm dependencies and GitHub Actions weekly. Enable and review repository alerts and security updates separately.
- [CodeQL](.github/workflows/codeql.yml) scans JavaScript/TypeScript and Actions on PRs/pushes to `main` and `release/**`, weekly and on dispatch. Use advanced setup without also enabling default setup.
- Verify successful scans and triage alerts; configuration alone is not evidence of a clean scan. Branch review requirements, secret scanning and push protection are repository or organization settings that must be verified separately.

## Local data

Trace files and metadata can contain sensitive data even when payload redaction is enabled. Keep secrets out of checked-in artifacts, restrict access to local storage and CI runners, and review artifact uploads before sharing them. Report redaction or data-exposure problems with a simulated or redacted example.

For issues involving the Python engine, see its [security policy](https://github.com/maida-ai/maida/blob/main/SECURITY.md) and include both package versions.
