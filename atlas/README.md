# housekeeping: how it works

Mapped at 2026-09-30 from commit 4c003f5 by Atlas 1.24.0.

## What this is

An operational-health warehouse for a GitHub organization: one sweep into SQLite, audited against written rules. (written by a person)

6 parts, mostly JavaScript (35 files), CSS (2), TypeScript (2) and Astro (1). Work enters through 3 doors; the busiest is CI, which reaches 2 parts. It deploys a site to GitHub Pages. hk is a command of a private package (nothing ships it).

## What changed since the last map

This is the first map.

## What comes in

1. **CI.** On a pull request to main touching 6 paths; on a push to main touching 6 paths; or by hand. Runs test/.
2. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
3. **hk** (a command of a private package, which nothing ships). Runs src/cli.mjs.

## What happens through CI

1. The workflow runs test/ in test.
2. That reaches src (10 files).
3. It writes to data/snapshots/, which is not tracked.

## Who reads the results

CI writes only to data/snapshots/, which is not tracked.

## The other doors

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**hk** (a command of a private package, which nothing ships) runs src/cli.mjs and writes to data/snapshots/ and reports/, which are not tracked.

## What breaks what

- **src** is imported only from tests, by 1 part (test), and sits on the path of 2 doors.

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

People write .github/, the repository root, rules/ and site/. Nothing in this repository writes to them.

## Where to start

src/cli.mjs → src/log.mjs → src/errors.mjs

Read those in order to follow one run of hk end to end. This path follows hk (a command of a private package, which nothing ships) from its entry, since CI runs only tests.

## What this map cannot see

- 3 reads use paths built at run time and are not named here.
- 2 writes go to places this repository does not track, so they are not listed as generated.
- 1 write and 19 reads go to a path their caller passes, not to this repository.
- 2 reads go to the directory the command is run in (package-lock.json and rules/), not to this repository.
- 1 write goes to a temporary directory, not to this repository.
- 5 commands are built at run time and not followed.
- Statistics confidence is low: fewer than 30 qualifying commits in the window, and fewer than 20 source files reach 10 revisions.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
