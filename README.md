<p align="center">
  <a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/housekeeping/readme.png" alt="housekeeping" width="400" />
</p>

<h1 align="center">housekeeping</h1>

<p align="center">
  An operational-health warehouse for a GitHub organization.<br>
  One sweep, one SQLite database, findings you can argue with,<br>
  and the whole-organization view an AI agent needs to coordinate every repository.
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/handbook/"><img src="https://img.shields.io/badge/Handbook-read-blue" alt="Handbook" /></a>
</p>

One sweep collects every repository's CI status, open issues and pull requests,
releases, version tags, workflow files, branch protection, security alerts,
lockfiles and Actions billing into SQLite, then audits it all against written
rules.

It answers, for the whole organization at once:

- Which default branches are red, and is that a broken mainline or stale history?
- Which pull requests can never merge, because a required check nothing emits is blocking them?
- Which deploys do the repository's own settings refuse?
- Where have `package.json`, git tags and the npm registry drifted apart?
- Which workflows break the Actions cost rules, what did they cost, and which jobs spent it?
- Which repositories carry advisories that GitHub's own alert count misses?

It is an audit instrument, not a fixer. It reads GitHub and changes nothing.

## An agent over every repository

An organization with dozens of repositories has no single place where its
state lives. housekeeping is that place, and its MCP server, `hk-mcp`, hands
it to an AI agent. With it, one agent can act as the coordinator for the whole
organization:

1. **Sweep.** `hk refresh` takes one snapshot of every repository.
2. **Triage.** The agent asks what is red, what is blocked and what got worse,
   and gets answers that already tell a broken mainline from stale history, and
   a stuck pull request from a conflicted one.
3. **Plan a wave.** One `hk_sql` query finds every repository with the same
   shape, so a fix becomes one pull request per repository instead of a hunt.
4. **Do the work.** housekeeping never writes. The agent opens pull requests
   with its own tools, under its own permissions and your review.
5. **Verify.** Sweep again. The finding is gone or it is not, and the change
   between two snapshots is a query.

Questions an agent answers in a call or two:

- Which default branches are red, and which job and step broke?
- Which pull requests can never merge, and is the trigger or a conflict to blame?
- Which repositories carry a production advisory that GitHub shows no alert for?
- Which scheduled workflows break the rules for schedules, and how?
- What did Actions cost, and which job spent it?
- What changed since the last sweep?

| Tool | What it answers |
|---|---|
| `hk_summary` | Totals for the newest sweep: repositories, issues, pull requests, workflows, findings. |
| `hk_findings` | Findings by code, severity, category or repository; counts by code when unfiltered. A red mainline's finding names the job and step that broke. |
| `hk_ci` | Repositories whose default branch is red and the workflows that failed; also failing schedules, failing pull-request branches, and repositories with no CI. |
| `hk_repo` | One repository in full: findings, workflows, open pull requests and issues. |
| `hk_backlog` | Open pull requests or issues across the organization, oldest first. |
| `hk_health` | A health score per repository, worst first. |
| `hk_cost` | Actions spend by repository, workflow or job, gross and net apart. |
| `hk_sql` | One read-only `SELECT` or `WITH` statement against the warehouse. |
| `hk_schema` | The tables and columns, for writing `hk_sql` queries. |

Every answer comes from the newest snapshot, opened read-only. A failing call
returns a structured error, never a stack trace.

### Connect it

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` is the directory you sweep from. From a clone, use
`"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. The second
server is [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas),
which answers the same agent about one repository at a time (see below). On
Windows, start a globally installed command through `cmd /c`.

## housekeeping and Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)
(`@dogfood-lab/atlas`) maps one repository: its parts, and its doors, meaning
every workflow with what it runs, publishes and deploys. The map is committed
as `atlas/` and checked in CI. housekeeping is the organization view. The two
are built to work together.

- **Every map, swept.** A sweep reads each repository's committed map along
  with everything else, and reports which repositories have none, which never
  run `atlas check`, and which carry an engine behind the one the rest of the
  organization pins.
- **Where a red run broke.** When a default branch is red, the finding names
  the job and step that failed and, through the map, the command that step
  runs, so the repair starts in the right file.
- **Deploy facts from the map.** The environment a job deploys to is taken from
  the map where it records one, so both tools read a workflow the same way.
- **Warnings across the fleet.** Atlas flags a workflow step that will break
  before it runs, such as a tool that needs a newer runtime than the job
  installs. The report lists these for every repository at once.

An agent with both servers moves from "these twelve repositories are blocked"
(housekeeping) to "this is the workflow, the job and the files a change will
reach" (Atlas), without opening each repository by hand.

## Why it is shaped this way

| Layer | Choice | Reason |
|---|---|---|
| Transport | the `gh` CLI | It already holds your token. The tool never stores or asks for a credential. |
| Collection | GitHub GraphQL, paged | One query returns metadata, open issues, open pull requests, releases and file trees for a page of repositories. A page that keeps timing out is halved and re-asked from the same cursor. |
| Actions runs | REST | GraphQL has no Actions surface. |
| Actions cost | billing API plus per-job durations | The invoice says which repository; only jobs say which workflow. GitHub's `/timing` endpoints return zeros, so the per-job sum is rebuilt and then reconciled against the invoice. |
| Runner rates | read from the invoice | A billed rate can differ from the list price, and a constant in source would misstate every number. |
| Storage | SQLite through the built-in `node:sqlite` | No native build step. |
| Source of truth | `data/snapshots/*.json` | Raw, diffable and append-only. The database is derived: `npm run rebuild` reconstructs it offline. |
| Sweep log | `data/sweeps.jsonl` | One line per sweep, including sweeps that failed and sweeps that found nothing new. |

Snapshots are immutable and additive, so drift between two dates is a `JOIN`.

## Requirements

- Node.js 22.5 or later.
- The [GitHub CLI](https://cli.github.com/), signed in (`gh auth status`) as an
  account that can read the organization. Reading billing and security alerts
  needs the matching access; a sweep without it records "not measured" and
  carries on. It never records a missing permission as a clean result.
- Windows or Linux. It is developed on Windows and its tests run on Linux in
  CI. macOS should work and is not tested.

## Use

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

To keep settings between sweeps, put a `housekeeping.config.json` in that
directory (see Configuration); then `hk refresh` needs no argument.

Or run it from a clone, which keeps its data in the clone:

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

Then query it:

```bash
hk summary               # portfolio totals
hk ci                    # repositories whose default branch is red
hk findings              # findings grouped by severity and code
hk health                # per-repository health score, worst first
hk repo <name>           # one repository in full
hk prs                   # every open pull request by age
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

In a clone without `npm link`, each `hk <command>` is `node src/cli.mjs <command>`.

`npm run rebuild` re-derives the database and the report from snapshots already
on disk, with no network access.

A full sweep makes a few hundred API calls. Do not run `refresh` in a loop.

Results go to standard output; progress and errors go to standard error. Every
error prints a code and a hint. Exit codes: 0 ok, 1 user error, 2 runtime
error, 3 partial (the sweep finished, with gaps).

## Configuration

`housekeeping.config.json`, in the directory housekeeping works in (see below):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` is the organization to sweep. `hk refresh <org>` overrides it. With
  neither, a sweep refuses to start.
- `metaRepos` are repositories that hold organization defaults, assets or
  tooling, not a shipped product. They are exempt from the findings that only
  make sense for a product: missing README, LICENSE and similar files, having
  no workflows, and having no releases.

A malformed file is an error, never a silent default: an unknown key, a wrong
type or broken JSON stops the run.

Run from a clone, housekeeping keeps `data/`, `reports/` and the config file
in the clone. Run as an installed package, it keeps them in the directory you
run it from, or in `HK_HOME` when that is set.

Environment: `HK_HOME` (where data, reports and the config live),
`HK_CONFIG` (config path), `HK_DB` (database path), `HK_LOG`
(`silent`, `normal`, `verbose` or `debug`), `HK_COST_REPOS` and
`HK_COST_BUDGET` (bounds on the per-job cost pass), `GH_PATH` (path to `gh`).

## Keep the data private

**What a sweep writes is sensitive. Do not commit `data/` or `reports/` to a
public repository.**

A snapshot records the names and descriptions of private repositories, every
open security alert with the package it names, workflow files and Actions
billing. GitHub deliberately hides a public repository's security alerts from
everyone but its maintainers; a published snapshot would hand that list out.

This repository's `.gitignore` excludes `data/`, `reports/` and
`housekeeping.config.json`. To keep history, which is the point of snapshots,
run the tool from a **private** repository of your own and commit them there.

## Findings

Rules live in `src/analyze.mjs`. Each one cites the written rule it enforces,
so a finding is arguable against a standard and not against taste. The rules
this repository ships are in [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): paths filters, runners, matrix size, the workflow file limit, concurrency.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): CI must pass, the ship gates, versions.
- [`rules/repo-first.md`](rules/repo-first.md): the default branch.
- [`rules/atlas-map.md`](rules/atlas-map.md): a committed map of each repository, checked in CI.

They are one organization's standards. If yours differ, change the rule file
and the rule together.

The rules take care to keep apart things that look alike, because collapsing
them produces noise:

- **A red default branch is not a red pull-request branch.** A failing
  Dependabot branch is backlog; a failing `push` run on the default branch is
  breakage. The run's event decides which.
- **History is not breakage.** A workflow moved to release-only triggers keeps
  its last default-branch failure forever. A deleted workflow keeps its runs.
  Neither is a live defect.
- **A required check nothing can emit is not a check that did not run here.**
  One says drop the requirement; the other says fix the trigger. The repairs
  contradict each other.
- **A pull request the trigger skipped is not a conflicted one.** GitHub runs
  no pull-request workflow on a pull request with conflicts, so its missing
  check says nothing about the trigger. That one needs a rebase.
- **A failed run is not a cancelled one.** `cancel-in-progress` exists to kill
  superseded runs, so cancelled minutes are usually the concurrency rule working.
- **Gross cost is not net cost.** GitHub meters public repositories at full
  price and discounts them to zero. Gross is real compute; net is real money.
  They are never summed.
- **Not measured is not clean.** A repository GitHub is not scanning reports
  zero alerts. A repository the cost pass did not reach has no cost row. Both
  are reported as unknown.

Severity drives a health score: critical 40, high 15, medium 6, low 2, info 0,
deducted from 100. The score ranks attention, not quality.

The [handbook](https://mcp-tool-shop-org.github.io/housekeeping/handbook/)
lists every finding, command, error code and table.

## Security

- **Read-only.** The collector issues GraphQL queries and REST `GET`s. It never
  merges, pushes, releases, publishes or edits a setting.
- **No credentials.** Authentication is whatever `gh` already holds. Nothing is
  written to disk about it.
- **No telemetry.** The only hosts contacted are the GitHub API, through `gh`,
  and the npm registry, for version and advisory lookups.
- **What it stores** is the sensitive part: see "Keep the data private".

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

Every rule is tested in both directions: the shape that must fire, and the
neighbouring shape that must not. A separate verifier re-derives a sample of
findings from live GitHub through its own transport, and skips, loudly, when
there is no database or no network.

## License

MIT. See [LICENSE](LICENSE).

---

Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
