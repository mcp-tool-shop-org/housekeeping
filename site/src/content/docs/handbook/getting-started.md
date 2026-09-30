---
title: Getting started
description: Install housekeeping, point it at an organization, and run a first sweep.
sidebar:
  order: 1
---

## Requirements

- **Node.js 22.5 or later.** The warehouse uses the built-in `node:sqlite`, so
  there is no native module to compile.
- **The [GitHub CLI](https://cli.github.com/)**, signed in as an account that
  can read the organization. Check with `gh auth status`.

housekeeping never asks for a token. It runs `gh`, and `gh` holds the
credential.

It is developed on Windows and its tests also run on Linux in CI.

## Install

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
```

To get the `hk` command on your path:

```bash
npm link
```

Without it, every `hk <command>` on these pages is `node src/cli.mjs <command>`.

## Name your organization

```bash
cp housekeeping.config.example.json housekeeping.config.json
```

Then edit the file:

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

`org` is the organization to sweep. See [Configuration](../configuration/)
for `metaRepos`.

## Run the first sweep

```bash
hk refresh
```

A sweep does four things in order:

1. **Collect.** Read the organization through `gh` and write one snapshot to
   `data/snapshots/`.
2. **Load.** Put that snapshot into `data/housekeeping.db`.
3. **Analyze.** Run the audit rules and store the findings.
4. **Report.** Write `reports/AUDIT-<date>.md`.

The first sweep is the slow one, because its caches are cold: allow several
minutes for an organization of a hundred repositories. Later sweeps reuse what
cannot have changed, such as a completed run's job durations.

Before it starts, the sweep checks that your API quota can finish it. If not,
it refuses instead of writing a half-collected snapshot.

## Look at the result

```bash
hk summary     # totals
hk ci          # red default branches
hk findings    # findings by severity and code
hk health      # repositories, worst first
```

Open `reports/AUDIT-<date>.md` for the full written audit.

## If a pass cannot read something

Some data needs access your token may not have: Actions billing and security
alerts are the usual two. A pass that is refused records **not measured** and
the sweep carries on. It never records a refusal as a clean result, so a
repository with no alert data shows as unknown, not as safe.

## Do not loop it

A full sweep makes a few hundred API calls. Run it when you want a fresh
answer, not on a timer of minutes.
