# Scorecard

> Scored before remediation, then again after. Scores reflect the executed
> gates and the checked lines in SHIP_GATE.md, not an estimate.

**Repo:** housekeeping
**Date:** 2026-09-30
**Type tags:** `[all]` `[cli]` `[mcp]` (not published to a registry)

## Pre-Remediation Assessment

The public repository as first published, before the front-door pass.

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 8/10 | SECURITY.md, threat model, no secrets, no telemetry, read-only against GitHub. No dependency scan in CI. |
| B. Error Handling | 3/10 | Every failure printed `error: <message>` and exited 1. A refused sweep exited 3. One code path printed a stack trace. `hk sql` was documented as read-only and was not. |
| C. Operator Docs | 6/10 | A complete README and LICENSE. A one-paragraph CHANGELOG. No help command; an unknown command printed the usage text and exited 0. No logging levels. |
| D. Shipping Hygiene | 5/10 | Lockfile committed, `engines.node` set, Dependabot alerts on. No `verify` script, no scanner in CI, no tag yet. |
| E. Identity (soft) | 0/10 | No logo, no translations, no landing page, no homepage. |
| **Overall** | **22/50** | |

## Key Gaps

1. Errors had no code, no hint and one exit code for everything, so a script could not tell a typo from a GitHub outage.
2. `hk sql` ran any statement on a writable connection.
3. No dependency scanner ran in CI; a clean tree was an assumption.
4. No help text, no logging levels, no `verify` script.
5. Nothing that makes a repository findable: logo, landing page, handbook, translations, homepage.

## Remediation Priority

| Priority | Item | Estimated effort |
|----------|------|-----------------|
| 1 | Structured errors, exit codes, a generated help text, log levels, a read-only `hk sql` | half a day |
| 2 | Blocking `npm audit` in CI; `npm run verify` | an hour |
| 3 | Landing page, seven-page handbook, logo, translations, metadata | a day |

## Post-Remediation

Measured on the v1.2.0 tree: `npx @mcptoolshop/shipcheck audit` reports every
A–D line checked or skipped with a reason; the executed gates `security-docs`,
`manifest`, `ci` and `deps` all pass.

| Category | Before | After |
|----------|--------|-------|
| A. Security | 8/10 | 10/10 |
| B. Error Handling | 3/10 | 9/10 |
| C. Operator Docs | 6/10 | 9/10 |
| D. Shipping Hygiene | 5/10 | 9/10 |
| E. Identity (soft) | 0/10 | 10/10 |
| **Overall** | 22/50 | **47/50** |

The points not taken, and why:

- **B, one point.** Exit code 3 (partial) is unit-tested on the function that
  decides it, and has not yet been observed on a real partial sweep.
- **C, one point.** macOS is documented as untested, because it is.
- **D, one point.** The version-to-tag check is executed at release time; the
  tag is cut from the commit this file describes.
- **E.** The landing page, the handbook and the logo were verified live after
  the publication of 2026-09-30, and `npx @mcptoolshop/shipcheck audit` on
  this tree reports every line checked or skipped.
