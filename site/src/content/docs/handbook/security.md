---
title: Security
description: What housekeeping reads, what it never does, and why its output must stay private.
sidebar:
  order: 7
---

## What it does to GitHub: nothing

housekeeping is read-only. The collector issues GraphQL queries and REST
`GET` requests through the `gh` CLI. It never merges, pushes, releases,
publishes, comments or edits a setting. There is no code path that does.

## What it needs

- The `gh` CLI, signed in as an account that can read the organization.
- Read access to whatever you want audited. Security alerts and Actions
  billing need more access than repository metadata does. A pass that is
  refused records "not measured" and the sweep continues.

## What it never handles

- **Credentials.** It does not read, store or print a token. `gh` holds the
  credential and makes the authenticated calls.
- **Telemetry.** None is collected or sent.
- **Other hosts.** It contacts the GitHub API, through `gh`, and the npm
  registry, for package versions and advisories. Nothing else.

The MCP server makes no network call at all. It reads the local database,
read-only.

## What it stores, and why that matters

Everything a sweep writes stays on your disk, under `data/` and `reports/`.
That output is the sensitive part of this tool.

A snapshot contains:

- the names and descriptions of **private repositories**
- every **open security alert**, with the vulnerable package it names
- workflow files
- the **Actions invoice**, line by line

GitHub deliberately hides a public repository's Dependabot alerts from
everyone but its maintainers. A published snapshot would hand that list to
anyone: which repository, which package, which advisory, unpatched.

## Keep the data private

- The repository's `.gitignore` excludes `data/`, `reports/` and
  `housekeeping.config.json`. Leave it that way in any public clone.
- Snapshot history is the point of the tool, so you will want to keep it.
  Commit it to a **private** repository of your own.
- Do not paste findings into a public issue, README or chat. A finding names
  a repository and a defect.
- Deleting a snapshot from a public repository does not remove it. History
  keeps it.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/mcp-tool-shop-org/housekeeping/blob/main/SECURITY.md)
in the repository.
