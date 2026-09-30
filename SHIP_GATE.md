# Ship Gate

> No repo is "done" until every applicable line is checked.
> Checked per release. This file records the gate for **v1.2.0**.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

This repository is `[all]` `[cli]` `[mcp]`. It is not published to a package
registry, so the `[npm]` publishing lines are skipped with that reason.

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline) — executed by `npx @mcptoolshop/shipcheck security-docs` (2026-09-30)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) — executed by `npx @mcptoolshop/shipcheck security-docs`; see "Security" and "Keep the data private" (2026-09-30)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output — the tool never reads a credential: `gh` holds it. The export that builds this repository runs an identity scan and refuses a tree that fails it (2026-09-30)
- [x] `[all]` No telemetry by default — stated in the README and SECURITY.md. The only hosts contacted are the GitHub API and the npm registry (2026-09-30)

### Default safety posture

- [ ] `[cli|mcp|desktop]` SKIP: no dangerous action exists. The tool is read-only against GitHub and has no kill, delete or restart. `hk refresh --force` only accepts a partial snapshot.
- [x] `[cli|mcp|desktop]` File operations constrained to known directories — writes only under `data/` and `reports/` (2026-09-30)
- [x] `[mcp]` Network egress off by default — the MCP server makes no network call; it reads the local database read-only (2026-09-30)
- [x] `[mcp]` Stack traces never exposed — every tool failure returns `{ code, message, hint, retryable }` (2026-09-30)

## B. Error Handling

- [x] `[all]` Errors follow the Structured Error Shape: `code`, `message`, `hint`, `cause?`, `retryable?` — `src/errors.mjs`, tested in `test/errors.test.mjs` (2026-09-30)
- [x] `[cli]` Exit codes: 0 ok · 1 user error · 2 runtime error · 3 partial success — tested end to end in `test/cli.test.mjs` (2026-09-30)
- [x] `[cli]` No raw stack traces without `--debug` — tested (2026-09-30)
- [x] `[mcp]` Tool errors return structured results — server never crashes on bad input (2026-09-30)
- [x] `[mcp]` State/config corruption degrades gracefully — the server holds no state of its own; it opens a derived database read-only, and a missing database is a startup error that names the fix (2026-09-30)
- [ ] `[desktop]` SKIP: not a desktop app
- [ ] `[vscode]` SKIP: not a VS Code extension

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions (2026-09-30)
- [x] `[all]` CHANGELOG.md (Keep a Changelog format) (2026-09-30)
- [x] `[all]` LICENSE file present and repo states support status — MIT; supported versions in SECURITY.md (2026-09-30)
- [x] `[cli]` `--help` output accurate for all commands and flags — the help text is generated from the table that dispatches the commands, and a test runs every command it lists (2026-09-30)
- [x] `[cli|mcp|desktop]` Logging levels defined: silent / normal / verbose / debug — secrets redacted at all levels. `--quiet`, `--verbose`, `--debug` or `HK_LOG`; no level can print a credential because the tool never holds one (2026-09-30)
- [x] `[mcp]` All tools documented with description + parameters — in the server's tool list and in the handbook reference (2026-09-30)
- [ ] `[complex]` SKIP: the handbook is the documentation site, not a HANDBOOK.md file

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) — `npm run verify`: the suite, then a smoke run of the CLI. There is no build step (2026-09-30)
- [x] `[all]` Version in manifest matches git tag — executed by `npx @mcptoolshop/shipcheck manifest` (2026-09-30)
- [x] `[all]` Dependency scanning runs in CI (ecosystem-appropriate) — executed by `npx @mcptoolshop/shipcheck ci`; `npm audit --audit-level=high` is a blocking CI step (2026-09-30)
- [x] `[all]` No known high/critical vulnerabilities in any dependency tree, and Dependabot alerts are enabled — executed by `npx @mcptoolshop/shipcheck deps` (2026-09-30)
- [ ] `[all]` SKIP: dependency updates are applied in the source this repository is built from, and arrive here with the next build. An update bot opening pull requests here would be overwritten.
- [ ] `[npm]` SKIP: not published to npm (`"private": true`)
- [ ] `[npm]` SKIP: not published to npm, so there is no publishable package to pack
- [x] `[npm]` `engines.node` set — `>=22.5.0` (2026-09-30)
- [x] `[npm]` Lockfile committed — executed by `npx @mcptoolshop/shipcheck manifest`; both lockfiles are also checked for every platform's native packages on each build of this repository (2026-09-30)
- [ ] `[vsix]` SKIP: not a VS Code extension
- [ ] `[desktop]` SKIP: not a desktop app

## E. Identity (soft gate — does not block ship)

- [ ] `[all]` Logo in README header
- [ ] `[all]` Translations (8 languages)
- [ ] `[org]` Landing page (@mcptoolshop/site-theme)
- [ ] `[all]` GitHub repo metadata: description, homepage, topics

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."

**Executed vs attested.** `npx @mcptoolshop/shipcheck audit` only counts these
checkboxes. The lines that say **"executed by"** are backed by a command that
reads the real artifact and exits 1 on the real defect. Every other line is an
attestation, and says where its evidence is.
