---
title: Configuration
description: The config file, the environment variables, and the bounds on the expensive pass.
sidebar:
  order: 3
---

## The config file

`housekeeping.config.json` sits beside `package.json`. It holds the two facts
about your organization that the rules cannot work out for themselves.

```json
{
  "org": "your-org",
  "metaRepos": [".github", "design-assets"]
}
```

| Key | Meaning | Default |
|---|---|---|
| `org` | The organization to sweep. | none: a sweep refuses to start without one |
| `metaRepos` | Repositories that are not shipped products. | `[".github"]` |

`hk refresh <org>` overrides `org` for one run.

### What a meta repository is

Some repositories hold organization defaults, shared assets or internal
tooling. They are not products, so product-hygiene findings about them are
noise: a missing CHANGELOG on the repository that stores your logos is not a
defect.

A repository named in `metaRepos` is exempt from the findings that only make
sense for a product:

- the `hygiene` and `metadata` group: no README, LICENSE, SECURITY.md,
  CHANGELOG, description or topics
- `CI_NO_WORKFLOWS`: nothing verifies it on push
- `NO_RELEASES`: a substantial repository that has never released

It is still audited for everything else: failing CI, security, Actions cost,
backlog.

### A malformed file stops the run

`metaRepos` suppresses findings, so the dangerous mistake is a config that
looks set and is silently ignored. Every malformed shape is an error:

- broken JSON
- an unknown key, such as `metaRepo` for `metaRepos`
- a value of the wrong type

Only a missing file falls back to the defaults.

The file names your organization and its repositories, so the repository's
`.gitignore` excludes it.

## Environment variables

| Variable | Effect |
|---|---|
| `HK_HOME` | The directory that holds `data/`, `reports/` and the config file. Unset, it is the clone when housekeeping runs from one, and the current directory when it runs as an installed package. |
| `HK_CONFIG` | Path to the config file. |
| `HK_DB` | Path to the SQLite database, for the CLI and the MCP server. |
| `HK_LOG` | `silent`, `normal`, `verbose` or `debug`. An unknown value is an error. |
| `HK_COST_REPOS` | How many repositories get the per-job cost pass. Default 12. |
| `HK_COST_BUDGET` | The ceiling on job-list fetches per sweep. Default 1500. |
| `GH_PATH` | Path to the `gh` executable, when it is not on your path. |

## The cost pass and its bounds

Most of a sweep is cheap: GitHub's GraphQL API returns a page of repositories
in one call. The cost pass is the exception. To say which workflow and which
job spent the minutes, it needs the job list of every run, and that is one
REST call per run.

So it is bounded twice:

- **By rank.** The invoice already says which repositories cost the most.
  Only the top `HK_COST_REPOS` are examined job by job.
- **By budget.** No more than `HK_COST_BUDGET` job lists are fetched in one
  sweep.

Completed runs are cached by run id, because a completed run never changes.
A cold cache costs about one call per run in the examined repositories; a
warm one costs almost nothing.

If the budget runs out, the snapshot records it, the sweep exits with code 3,
and the affected repositories are marked as not reconciled. The cost rules
then stay silent about them. An incomplete attribution is never reported as a
small bill.

## Raising the bounds

Raise `HK_COST_REPOS` to cover more repositories, and `HK_COST_BUDGET` if the
first sweep reports that it ran out. Both cost API calls from the same hourly
quota the sweep itself needs, so raise them together and watch the
preflight: a sweep that cannot finish within the remaining quota refuses to
start.
