---
title: housekeeping Handbook
description: An operational-health warehouse for a GitHub organization. One sweep, one SQLite database, findings you can argue with.
sidebar:
  order: 0
---

**housekeeping** answers questions about a whole GitHub organization at once,
without opening every repository.

One sweep collects each repository's CI status, open issues and pull requests,
releases, version tags, workflow files, branch protection, security alerts,
lockfiles and Actions billing. It stores the result as a snapshot, loads it
into SQLite, and audits it against written rules. What comes out is a list of
findings, each citing the rule it enforces.

It is an audit instrument. It reads GitHub and changes nothing.

## What you can ask it

- Which default branches are red, and which of those are a broken mainline as opposed to stale history?
- Which pull requests can never merge, because protection requires a check that nothing emits?
- Which deploys do the repository's own settings refuse?
- Where have `package.json`, git tags and the npm registry drifted apart?
- Which workflows break the Actions cost rules, what did they cost, and which job spent it?
- Which repositories carry advisories that GitHub's own alert count misses?

## Where to go next

| You want to | Read |
|---|---|
| Install it and run a first sweep | [Getting started](./getting-started/) |
| Query the warehouse day to day | [Usage](./usage/) |
| Point it at your organization | [Configuration](./configuration/) |
| Understand what a finding means | [Findings](./findings/) |
| Look up a command, a tool or a table | [Reference](./reference/) |
| Change it or add a rule | [Architecture](./architecture/) |
| Know what it touches and stores | [Security](./security/) |

## One thing to know first

**What a sweep writes is sensitive.** A snapshot records the names of private
repositories, every open security alert with the package it names, and Actions
billing. Keep `data/` and `reports/` out of any public repository. The
[Security](./security/) page says why and how.
