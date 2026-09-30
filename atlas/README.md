# housekeeping: how it works

Mapped at 2026-09-30 from commit 5b1ebf8 by Atlas 1.24.0.

## What this is

An operational-health warehouse for a GitHub organization: one sweep into SQLite, audited against written rules. (written by a person)

6 parts, mostly JavaScript (40 files), CSS (2), TypeScript (2) and Astro (1). Work enters through 5 doors; CI and Release each reach 2 parts, and CI is followed because a pull request goes through it. It publishes to npm. It deploys a site to GitHub Pages. People run hk and hk-mcp.

## What changed since 2026-09-30 (b003f43)

- src/schema.sql is now also read by test/ci-failing.test.mjs.
- 1 file added and 6 changed content, across 4 parts.

## What comes in

1. **CI.** On a pull request to main touching 6 paths; on a push to main touching 6 paths; or by hand. Runs test/.
2. **Release.** When a release is published; or by hand. Runs test/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **hk** (a command people run). Runs src/cli.mjs.
5. **hk-mcp** (a command people run). Runs src/mcp.mjs.

## What happens through CI

1. The workflow runs test/ in test.
2. That reaches src (12 files).

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs test/, reaches src, and publishes to npm on a release event.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**hk** (a command people run) runs src/cli.mjs.

**hk-mcp** (a command people run) runs src/mcp.mjs.

## What breaks what

- **src** is imported only from tests, by 1 part (test), and sits on the path of 4 doors.
- **test** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

No two source files changed together often enough to name.

Window: 180 days; a pair counts from 3 shared commits, since the window holds fewer than 30 qualifying commits.

## What no test touches

Every code part is imported by at least one test.

## Written but never read

No place this map can see is written, so none goes unread.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

Nothing in this repository writes to a tracked place this map can see.

## Hand-authored

People write .github/, the repository root, rules/ and site/; 3 writes with paths built at run time may land here.

## Where to start

src/cli.mjs → src/log.mjs → src/errors.mjs

Read those in order to follow one run of hk end to end. This path follows hk (a command people run) from its entry, since CI runs only tests.

## What this map cannot see

- 3 writes and 2 reads use paths built at run time and are not named here.
- 1 write and 21 reads go to a path their caller passes, not to this repository.
- 2 reads go to the directory the command is run in (package-lock.json and rules/), not to this repository.
- 1 write goes to a temporary directory, not to this repository.
- 6 commands are built at run time and not followed, 1 of them in tests.
- Statistics confidence is low: fewer than 30 qualifying commits in the window, and fewer than 25 source files reach 10 revisions.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
