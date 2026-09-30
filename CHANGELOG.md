# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
