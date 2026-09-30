# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] - 2026-09-30

The first release on npm, as `@mcptoolshop/housekeeping`.

### Added

- Publishable to npm as `@mcptoolshop/housekeeping`, with the `hk` and
  `hk-mcp` commands. A release workflow publishes it with provenance when a
  GitHub release is published, through npm Trusted Publishing.
- `HK_HOME`: where data, reports and the config live. Unset, a clone keeps
  them in itself as before, and an installed package keeps them in the
  directory it runs from, never inside `node_modules`.
- The default-branch CI findings say where a red run broke: the failed job and
  step, matched to the workflow file by name. One REST call per red run.
- With an Atlas map, the failed step is joined to the map's entry for it, and
  a map finding recorded against that same step is cited as a prediction.
- `run_failed_step` table.
- This repository keeps its own Atlas map in `atlas/`, made by
  `@dogfood-lab/atlas` 1.24.0 and checked in CI at the same version, as the
  rule in `rules/atlas-map.md` asks of every repository that runs workflows.
- The report's Atlas section lists each map's door findings (D1: a toolchain a
  package refuses; D2: a lockfile without the job's platform) and the checks
  Atlas could not judge, counted only among maps made by Atlas 1.24.0 or later.
- The deploy rules take a job's environment from the Atlas map where the map
  records one, and keep the workflow's own reading beside it
  (`workflow_environment.source`, `.parsed`); the report counts disagreements.
- The lockfile audit reads `pnpm-lock.yaml` (lockfile versions 5, 6 and 9) as
  well as `package-lock.json`. In a 9.x lock, what ships is found by walking
  the dependency graph from every workspace package's production
  dependencies.

### Changed

- `ATLAS_ENGINE_BEHIND` is `low`, and counts in the health score, for a
  snapshot taken after the first fleet pin-bump wave ended; an earlier
  snapshot keeps it at `info`, so rebuilding it reproduces that day's
  findings. The rule's Transition section says the same.
- A new logo: a broom and a magnifier over a database. The README header,
  the handbook's header mark and the favicon all use it, and the lockup
  also ships at the repository root as `logo.png`, where the org's logo sync
  finds it (not `readme.png`, which npm would pack as a README).

### Fixed

- The Atlas map record kept a command's `directory`, a key no map writes; it
  now keeps `dir`, and keeps the door's `unresolvedChecks`. Cached records are
  re-read once.

## [1.2.0] - 2026-09-30

The first public release.

### Added

- `hk help`, and `--help` / `-h` on any command. The help text is generated
  from the table that dispatches the commands.
- Structured errors: every failure prints `error [CODE] message` and a hint.
- Exit codes: 0 ok, 1 user error, 2 runtime error, 3 partial.
- Log levels: `--quiet`, `--verbose`, `--debug`, or `HK_LOG`.
- `hk report [snapshot-id]` writes the audit report for a loaded snapshot.
- `housekeeping.config.json`: the organization to sweep, and the repositories
  that are not shipped products. A malformed file is an error.
- `npm run verify`: the test suite, then a smoke run of the CLI.
- The written rules the findings cite, under `rules/`.
- A landing page and a handbook.

### Changed

- `hk refresh` writes the report itself, and exits 3 when the sweep finished
  with collection errors or an incomplete cost pass. The snapshot and the
  report are still written.
- A sweep refused for lack of API quota exits 2, as `RATE_LIMITED`.
- An unknown command is an error with exit 1. It used to print the usage text
  and exit 0.
- `HK_DB` selects the database for the CLI as well as the MCP server.
- The MCP server returns every failure as a structured result.

### Fixed

- `hk sql` is read-only, as documented. It ran any statement on a writable
  connection.
- Running `hk help`, or mistyping a command, no longer creates a database.

### Security

- `fast-uri` 3.1.8 and `ip-address` 10.7.2, both advisory fixes in transitive
  dependencies.
- CI runs `npm audit --audit-level=high` as a blocking step.
