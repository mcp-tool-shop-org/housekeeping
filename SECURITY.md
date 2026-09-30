# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Reporting a Vulnerability

Email: **64996768+mcp-tool-shop@users.noreply.github.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Version affected
- Potential impact

### Response timeline

| Action | Target |
|--------|--------|
| Acknowledge report | 48 hours |
| Assess severity | 7 days |
| Release fix | 30 days |

## Scope

- **GitHub, read-only.** GraphQL queries and REST `GET`s, issued through the
  `gh` CLI with the token `gh` already holds. No mutating call exists in the
  collector or the analyzer.
- **The npm registry, read-only.** Version lookups and the bulk advisory
  endpoint.
- **Data touched:** snapshots, a sweep log, a derived SQLite database, three
  caches and the generated report, all under `data/` and `reports/` on your
  disk.
- **No secrets handling.** It does not read, store or transmit credentials;
  authentication is whatever `gh` holds.
- **No telemetry** is collected or sent, and no other host is contacted.

## The data is the sensitive part

A snapshot contains the names and descriptions of private repositories, every
open security alert with the vulnerable package it names, workflow files and
Actions billing. Treat `data/` and `reports/` as confidential. This repository
ignores both; keep snapshot history in a private repository.
