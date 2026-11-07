---
title: Usage
description: Querying the warehouse from the command line, from SQL, and from an assistant.
sidebar:
  order: 2
---

Results go to standard output. Progress and errors go to standard error, so a
command's output can be piped or redirected cleanly.

## Everyday questions

```bash
hk summary          # how big is the portfolio, how many findings
hk ci               # which default branches are red right now
hk findings         # what kinds of problems, and how many of each
hk health           # which repositories need attention first
hk repo <name>      # everything about one repository
```

`hk ci` lists only a **broken mainline**: a failing run on the default branch
from a push-like event, in a workflow that can still run on push. A failing
Dependabot branch, a failing nightly job and a workflow that was moved to
release-only are different findings. See [Findings](../findings/).

## Backlog

```bash
hk prs              # every open pull request, oldest first
hk issues           # every open issue, stalest first
```

## Branches

```bash
hk branches         # per repository: merged, moved after merge, closed, stale
hk branches <repo>  # every branch of one repository and its state
```

Each branch is named by its pull requests, first match wins:

| State | Meaning |
|---|---|
| `open_pr` | the head of an open pull request |
| `open_base` | the base of an open pull request, as a stacked one is |
| `merged` | its pull request merged and the tip is the merged commit, so the pull request page can restore it |
| `merged_moved` | its pull request merged, then more commits were pushed; those exist only on this branch |
| `closed` | only closed, unmerged pull requests |
| `no_pr` | never the head of a pull request |

Only `merged` is safe to delete without asking. These are data, not findings.
Each repository's "automatically delete head branches" setting is recorded too.

## A watch list

```bash
hk watch                 # the repositories in "watch" in the config
hk watch repo-a repo-b   # or name them
```

For each repository: open pull requests with the longest idle first, open
Dependabot alerts with their fix versions, and the branches a cleanup would
touch. A repository whose alerts are switched off says so, rather than showing
an empty list.

## Versions

```bash
hk versions
```

One line per package: the version in `package.json`, the newest semver git
tag, the newest GitHub Release and the version on npm. Drift is measured
against the **tag**, because a tag and a Release are different objects.

## Actions cost

```bash
hk cost                     # per repository: gross, net, minutes by OS
hk cost-workflows [repo]    # which workflow spent it
hk cost-jobs [repo]         # which job, with matrix cells counted
```

Two numbers appear side by side and are never added together:

- **Gross** is the compute that was metered.
- **Net** is the money owed.

GitHub meters a public repository at full price and then discounts it to
zero. Gross is worth managing even when net is nothing.

The per-workflow and per-job views cover only repositories whose rebuilt cost
agreed with the invoice. A repository missing from them was **not measured**,
which is not the same as costing nothing.

## SQL

```bash
hk sql "SELECT repo, code FROM finding WHERE severity = 'high' LIMIT 20"
```

One `SELECT` or `WITH` statement, on a read-only connection. Every table is
keyed by `snapshot_id`, so comparing two dates is a join:

```sql
SELECT a.repo, a.code
FROM finding a
LEFT JOIN finding b
  ON b.snapshot_id = 1 AND b.repo = a.repo AND b.code = a.code
WHERE a.snapshot_id = 2 AND b.repo IS NULL;
```

That lists the findings that are new in snapshot 2. `hk snapshots` shows the
ids.

## Working offline

```bash
npm run rebuild
```

Rebuilds the database and the report from the snapshots already on disk. No
network. Use it after pulling a change to the schema, or after the database
is deleted: the database is derived, and the snapshots are the source of
truth.

## From an agent

```bash
hk-mcp            # installed package; in a clone, npm run mcp
```

Serves the warehouse over stdio as an MCP server, so an AI agent can ask a
question and get a small table back instead of reading a multi-megabyte
snapshot. The tools are listed in the [Reference](../reference/).

With it, one agent can coordinate the whole organization: sweep, triage what
is red or blocked, find every repository with the same defect in one `hk_sql`
query, open the fixes with its own tools, and sweep again to confirm.
housekeeping itself never writes.

Give the same agent [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)
as a second server (`atlas mcp`) for the inside of one repository: which
workflow runs a file and what a change reaches. housekeeping already reads
every repository's Atlas map, so a red mainline's finding names the job, the
step and the command that broke.

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

## How much it says

| Flag | Level | What you see on standard error |
|---|---|---|
| `--quiet` | silent | errors only |
| (none) | normal | one line per pass, and what was written |
| `--verbose` | verbose | adds one line per GitHub call |
| `--debug` | debug | adds stack traces on errors |

`HK_LOG=silent|normal|verbose|debug` sets the same thing from the
environment.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | user error: the command, its arguments or the config file are wrong |
| 2 | runtime error: GitHub, the database or the disk failed |
| 3 | partial: the sweep finished, with collection errors or an incomplete cost pass |

On exit 3 the snapshot and the report are still written. What was collected
is true; it is just not everything that was asked for.
