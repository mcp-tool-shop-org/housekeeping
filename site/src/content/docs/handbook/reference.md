---
title: Reference
description: Commands, flags, exit codes, error codes, MCP tools, files and tables.
sidebar:
  order: 5
---

## Commands

| Command | What it does |
|---|---|
| `hk refresh [org] [--force]` | Sweep the organization: collect, load, analyze, write the report. Uses the network. |
| `hk load [file]` | Load a snapshot already on disk. The newest by default. |
| `hk report [snapshot-id]` | Write `reports/AUDIT-<date>.md` for a loaded snapshot. |
| `hk summary` | Snapshot totals. The default command. |
| `hk repos` | Every repository, one line each. |
| `hk repo <name>` | One repository in full, with its findings. |
| `hk findings` | Finding counts by severity, category and code. |
| `hk health` | Health score per repository, worst first. |
| `hk ci` | Repositories whose default branch is red. |
| `hk actions` | Every workflow and its rule flags. |
| `hk cost` | Actions cost per repository, gross and net. |
| `hk cost-workflows [repo]` | Which workflow spent the minutes. |
| `hk cost-jobs [repo]` | Which job, with matrix cells counted. |
| `hk versions` | `package.json` against git tag against npm. |
| `hk prs` | Every open pull request by age. |
| `hk issues` | Every open issue by staleness. |
| `hk snapshots` | The snapshots loaded into the database. |
| `hk sql "<query>"` | One read-only `SELECT` or `WITH` statement. |
| `hk help` | The command list. |

`hk refresh --force` starts a sweep even when the API quota may not cover it,
accepting a partial snapshot.

### Flags, on any command

| Flag | Effect |
|---|---|
| `--quiet` | errors only |
| `--verbose` | one line per GitHub call |
| `--debug` | stack traces on errors |
| `--help`, `-h` | the command list |

### npm scripts

| Script | Runs |
|---|---|
| `npm run refresh` | `hk refresh` |
| `npm run rebuild` | delete the database, load the newest snapshot, write the report. No network. |
| `npm run mcp` | the MCP server |
| `npm test` | the test suite |
| `npm run verify` | the tests, then a smoke run of the CLI |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | user error |
| 2 | runtime error |
| 3 | partial: finished, with gaps |

## Errors

Every error has the same shape:

```
error [CODE] what happened
hint: what to do about it
```

| Code | Exit | Meaning |
|---|---|---|
| `USAGE` | 1 | unknown command, or a missing argument |
| `NO_ORG` | 1 | no organization on the command line or in the config |
| `CONFIG_INVALID` | 1 | the config file or `HK_LOG` is malformed |
| `NO_SNAPSHOT` | 1 | nothing is loaded yet |
| `SNAPSHOT_UNREADABLE` | 1 | the file given to `hk load` cannot be read |
| `SQL_REFUSED` | 1 | the statement is not a single `SELECT` or `WITH` |
| `SQL_FAILED` | 1 | the statement is read-only and SQLite rejected it |
| `SCHEMA_CHANGED` | 2 | the database was built against a different schema; run `npm run rebuild` |
| `RATE_LIMITED` | 2 | GitHub's quota or burst limit; retryable |
| `UNEXPECTED` | 2 | anything else; re-run with `--debug` |

## MCP tools

`npm run mcp` serves these over stdio. A failing call returns a structured
result, `{ code, message, hint, retryable }`, and never a stack trace.

| Tool | Arguments | Returns |
|---|---|---|
| `hk_summary` | none | portfolio totals for the newest snapshot |
| `hk_findings` | `severity`, `category`, `code`, `repo`, `limit` | findings, or counts by code when unfiltered |
| `hk_ci` | `scope`: `red_main` (default), `scheduled`, `branches`, `none`, `all_runs` | CI health |
| `hk_repo` | `name` | everything known about one repository |
| `hk_backlog` | `kind`: `prs` (default) or `issues`; `repo`; `min_age_days`; `limit` | open work, oldest first |
| `hk_health` | `limit` | health scores, worst first |
| `hk_cost` | `scope`: `repo` (default), `workflow`, `job`; `repo`; `limit` | Actions cost |
| `hk_sql` | `query` | the rows of one `SELECT` or `WITH` statement |
| `hk_schema` | `table` | table and column names |

The server opens the database read-only and makes no network call.

## Files

| Path | What it is | Rebuildable |
|---|---|---|
| `data/snapshots/*.json` | One file per sweep that found something new. The source of truth. | no |
| `data/sweeps.jsonl` | One line per sweep: written, duplicate or failed. | no |
| `data/housekeeping.db` | The SQLite database. | yes: `npm run rebuild` |
| `data/*-cache.json` | Parsed lockfiles, job durations and map records, keyed by content. | yes: the next sweep refills them |
| `reports/AUDIT-<date>.md` | The written audit. | yes: `hk report` |
| `housekeeping.config.json` | Your organization and its meta repositories. | no |

A sweep that observed exactly what the previous one did writes no snapshot.
It still adds a line to `data/sweeps.jsonl`, so the fact that you looked is
kept.

## Tables

Every table is keyed by `snapshot_id`. `hk sql "SELECT * FROM <table> LIMIT 1"`
or the `hk_schema` tool shows the columns.

| Table | One row per |
|---|---|
| `snapshot` | sweep loaded |
| `repo` | repository |
| `topic`, `language` | repository topic, repository language |
| `file_presence` | repository: README, LICENSE, SECURITY and similar |
| `issue`, `pull_request` | open issue, open pull request |
| `release`, `tag` | GitHub Release, git tag |
| `workflow` | workflow file, with its rule flags |
| `workflow_run` | recorded run |
| `run_failed_step` | failed step of a red default-branch run, and the same step as a map names it |
| `workflow_environment`, `environment`, `deploy_settings` | what a deploy depends on |
| `branch_protection`, `check_context` | protection rule, observed check name |
| `package_script`, `package_dep` | npm script, declared dependency |
| `security_alert`, `repo_security` | open alert, repository security settings |
| `lockfile`, `lockfile_advisory` | committed lockfile, advisory found in it |
| `billing_usage` | invoice line |
| `run_cost`, `run_cost_job` | priced run, priced job |
| `cost_reconciliation` | repository: did the rebuilt cost agree with the invoice |
| `atlas_map`, `atlas_door`, `atlas_door_command`, `atlas_fleet` | committed repository map and its entries |
| `finding` | rule firing |
| `collect_error` | something a sweep could not read |
