---
title: Architecture
description: How a sweep becomes a finding, which file owns which decision, and how to add a rule.
sidebar:
  order: 6
---

## The pipeline

```
GitHub  --gh-->  collect  -->  snapshot.json  -->  load  -->  SQLite  -->  analyze  -->  findings
                                (source of truth)             (derived)                      |
                                                                                           report
```

Three properties hold the design together.

**Snapshots are immutable and append-only.** A sweep writes one JSON file
and never edits an old one. Drift between two dates is therefore a join
between two snapshot ids, not a guess.

**The database is derived.** Anything in SQLite can be rebuilt from the
snapshots with `npm run rebuild`, offline. If it cannot be rebuilt, it does
not belong in the database.

**Rules are pure functions of the database.** Re-running the analysis on an
old snapshot reproduces that day's findings.

## One file per decision

The modules are split by what changes independently. An edit belongs in
exactly one of them.

| Change | File |
|---|---|
| GitHub authentication or transport | `src/gh.mjs` |
| A new field from the API | `src/collect.mjs`, then `src/schema.sql`, then `src/load.mjs` |
| A new or amended audit rule | `src/analyze.mjs` |
| How Actions is billed: rates, rounding, runner classes | `src/cost.mjs` |
| Report wording or sections | `src/report.mjs` |
| A query for people | `src/cli.mjs` |
| A query for assistants | `src/mcp.mjs` |
| Which organization, which meta repositories | `src/config.mjs` and the config file |
| The error shape and exit codes | `src/errors.mjs` |

`src/cost.mjs` is separate from the collector on purpose. How GitHub
**bills** changes independently of how it **reports**, and keeping the
arithmetic out of the network path is what makes it unit-testable. It makes
no `gh` call.

## What a sweep collects

| Pass | Through | Notes |
|---|---|---|
| Repositories, issues, pull requests, releases, file trees | GraphQL, paged | A page that keeps timing out is halved and re-asked from the same cursor, so no repository is skipped. |
| Mergeability | GraphQL | GitHub computes it lazily, so unknown answers are asked again. |
| Workflow files | GraphQL | Parsed as YAML, never matched by pattern. |
| Actions runs | REST | With a targeted backfill, so a workflow that broke and went quiet does not fall out of the window. |
| Deploy settings | REST | Pages and environments, only for repositories whose workflows use them. |
| Security alerts and settings | REST | Including whether scanning is on at all. |
| Lockfiles | REST, then the npm registry | Every committed npm lockfile is audited directly. |
| Billing | REST | One call for the organization. |
| Per-job cost | REST | Bounded by rank and by budget. See [Configuration](../configuration/). |

Gateway errors and truncated responses are retried with backoff. Rate limits
are detected before a sweep starts and again on every call. A throttled call
is never read as an empty answer.

## The cost numbers are produced twice

GitHub's billing API states what each repository cost. housekeeping also
rebuilds that figure from per-job durations, because only jobs say which
workflow spent it. The two come from endpoints that share no code path.

The rebuilt figure is compared with the invoice per repository. Every cost
rule reads only repositories where the two agree. A repository whose numbers
diverge gets silence, not a qualified finding.

## Adding a rule

1. **Write the rule down first.** Add or amend a file under `rules/`, and
   cite it in the code as `rules/<name>.md`. A finding must be arguable
   against a written standard.
2. **Put the decision in a pure function** in `src/analyze.mjs`, so it can
   be tested without a database.
3. **Test both directions.** The shape that must fire, and the neighbouring
   shape that must not. `test/cost-rules.test.mjs` and
   `test/deploy-rules.test.mjs` show the pattern: a small snapshot goes
   through the real loader into an in-memory database, and the real analyzer
   runs over it.
4. **Check it against GitHub** on a handful of repositories before trusting
   the count. A plausible aggregate is not evidence.
5. **Stay silent when the input was not measured.** A missing row means
   unknown. A rule that reads cost must require a reconciled repository.

If the rule needs a new field, add it to the collector, the schema and the
loader in that order. The loader derives its insert statements from the
schema, so a new column needs one new value in the matching call and nothing
else.

Editing `src/schema.sql`, even a comment, changes its fingerprint. An
existing database then refuses to open until `npm run rebuild`.

## Tests

```bash
npm test
```

Most tests are pure: a function, an input, an expected answer. A separate
verifier re-derives a sample of findings from live GitHub through its own
transport and its own reading of the rules, and fails the suite if the two
disagree. It imports nothing from `src/`, so a bug cannot agree with itself.
Without a database or a network it skips, and says so.
