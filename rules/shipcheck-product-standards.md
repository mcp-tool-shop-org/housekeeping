# Product standards

What "done" means for a shipped repository. The `ci`, `hygiene`, `metadata`
and `version` findings enforce the parts of it a sweep can measure.

## CI verification (Non-Negotiable)

After pushing, verify CI passes on the repository (`gh run list --limit 1`).
If CI fails, fix it before moving on. Never leave a repo with failing CI.

A gate whose verdict can never be obtained breaks this rule as surely as a red
run does: a required status check that nothing reports, or a deploy that the
repository's own settings refuse.

## Hard gates

- **A. Security.** `SECURITY.md`, a threat model in the README, no secrets and
  no telemetry.
- **B. Errors.** A structured error shape (code, message, hint), exit codes for
  a CLI, no raw stack traces.
- **C. Docs.** A current README, a CHANGELOG, a LICENSE, accurate `--help`.
- **D. Hygiene.** A verify script, a version that matches its tag, dependency
  scanning, clean packaging.

## Soft gate

- **E. Identity.** A logo, translations, a landing page, a handbook site that
  builds, and GitHub metadata: a description and topics.

Gates A, C, D and E are obligations of a **public** repository. A README is
owed by every repository; the rest serve people outside the organization.

## Versions

A released version is a semver git tag. The version in the package manifest,
the newest semver tag and the version on the registry agree. A workspace
root's version is not a shipped version.
