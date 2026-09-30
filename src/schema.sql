-- housekeeping: org operational-health warehouse
-- Snapshot-oriented: every collection run is an immutable row set, so drift is a JOIN.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS snapshot (
  id                INTEGER PRIMARY KEY,
  taken_at          TEXT NOT NULL,
  org               TEXT NOT NULL,
  collector_version TEXT,
  repo_count        INTEGER,
  duration_ms       INTEGER,
  gh_login          TEXT,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS repo (
  snapshot_id  INTEGER NOT NULL,
  name         TEXT NOT NULL,
  node_id      TEXT,
  description  TEXT,
  url          TEXT,
  homepage     TEXT,
  is_private   INTEGER, is_archived INTEGER, is_fork INTEGER,
  is_template  INTEGER, is_empty INTEGER,
  created_at   TEXT, updated_at TEXT, pushed_at TEXT,
  days_since_push INTEGER,
  disk_usage_kb INTEGER, stars INTEGER, forks INTEGER, watchers INTEGER,
  primary_language TEXT, license TEXT,
  has_issues INTEGER, has_wiki INTEGER, has_discussions INTEGER, has_projects INTEGER,
  default_branch TEXT, head_oid TEXT, head_committed_at TEXT,
  ci_rollup    TEXT,           -- SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | NONE
  open_issues INTEGER, closed_issues INTEGER,
  open_prs INTEGER, merged_prs INTEGER, closed_prs INTEGER,
  release_count INTEGER, latest_release_tag TEXT, latest_release_at TEXT,
  tag_count INTEGER, latest_tag TEXT, latest_tag_at TEXT,
  pkg_name TEXT, pkg_version TEXT, pkg_private INTEGER,
  npm_latest_version TEXT, npm_published_at TEXT, npm_status TEXT,
  topic_count INTEGER, workflow_count INTEGER, translation_count INTEGER,
  is_monorepo INTEGER,
  -- Handbook site sidebar, stored as the two halves of one compatibility fact.
  -- Neither column is a defect on its own; see HANDBOOK_SIDEBAR_* in analyze.mjs.
  -- NULL means "no site/astro.config.mjs", or a snapshot taken before this was
  -- collected -- both of which the rules read as "not measured", not "clean".
  site_sidebar_shape    TEXT,   -- labeled-autogenerate | items-autogenerate | explicit | none
  site_starlight_range  TEXT,   -- the declared range, verbatim (e.g. ^0.37.6)
  -- 1 = atlas/structure.json is on the default branch, 0 = it is not, NULL =
  -- not collected (a snapshot before collector 1.3.0). See rules/atlas-map.md.
  has_atlas_map INTEGER,
  PRIMARY KEY (snapshot_id, name)
);

-- The committed Atlas map, one row per repo whose map the sweep saw. `error`
-- set means the map exists but could not be read: it is present, and nothing
-- is known about what it says. `engine` NULL on a readable map means it was
-- made before Atlas 1.23.0, which did not record one.
CREATE TABLE IF NOT EXISTS atlas_map (
  snapshot_id INTEGER, repo TEXT, blob_sha TEXT, size_bytes INTEGER,
  engine TEXT, generated_from TEXT, door_count INTEGER, error TEXT
);

-- Each door of a map, trimmed (collect.mjs trimAtlasDoor). The JSON columns
-- are kept as Atlas wrote them; `jobs` and `findings` are NULL until the
-- map's engine records them.
CREATE TABLE IF NOT EXISTS atlas_door (
  snapshot_id INTEGER, repo TEXT, file TEXT, name TEXT, kind TEXT,
  triggers TEXT, sends TEXT, counts TEXT, jobs TEXT, findings TEXT
);

-- Each command of a door: the job and step it runs in and the programs it
-- runs. `step` is Atlas's step reference as recorded in the map.
CREATE TABLE IF NOT EXISTS atlas_door_command (
  snapshot_id INTEGER, repo TEXT, file TEXT, door TEXT,
  job TEXT, step TEXT, programs TEXT, directory TEXT
);

-- The engine version the fleet is measured against, once per snapshot.
CREATE TABLE IF NOT EXISTS atlas_fleet (
  snapshot_id INTEGER, version TEXT, source TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS topic (
  snapshot_id INTEGER, repo TEXT, topic TEXT
);

-- package.json scripts and devDependencies, so a rule can ask whether a
-- declared tool is actually invoked anywhere. A checker nobody runs is a
-- gate that exists on paper only.
CREATE TABLE IF NOT EXISTS package_script (
  snapshot_id INTEGER, repo TEXT, name TEXT, command TEXT
);

CREATE TABLE IF NOT EXISTS package_dep (
  snapshot_id INTEGER, repo TEXT, name TEXT, spec TEXT, kind TEXT  -- prod | dev
);

CREATE TABLE IF NOT EXISTS language (
  snapshot_id INTEGER, repo TEXT, language TEXT, bytes INTEGER, pct REAL
);

CREATE TABLE IF NOT EXISTS issue (
  snapshot_id INTEGER, repo TEXT, number INTEGER, title TEXT,
  author TEXT, created_at TEXT, updated_at TEXT, age_days INTEGER,
  stale_days INTEGER, comments INTEGER, labels TEXT, url TEXT
);

CREATE TABLE IF NOT EXISTS pull_request (
  snapshot_id INTEGER, repo TEXT, number INTEGER, title TEXT,
  author TEXT, created_at TEXT, updated_at TEXT, age_days INTEGER,
  stale_days INTEGER, is_draft INTEGER, mergeable TEXT, review_decision TEXT,
  additions INTEGER, deletions INTEGER, changed_files INTEGER,
  head_ref TEXT, base_ref TEXT, labels TEXT, url TEXT
);

CREATE TABLE IF NOT EXISTS release (
  snapshot_id INTEGER, repo TEXT, tag TEXT, name TEXT,
  published_at TEXT, is_latest INTEGER, is_draft INTEGER, is_prerelease INTEGER
);

-- git tags are NOT GitHub Releases: a repo can be correctly tagged and simply
-- never have had a Release published. Conflating them produced false drift.
CREATE TABLE IF NOT EXISTS tag (
  snapshot_id INTEGER, repo TEXT, name TEXT, tagged_at TEXT,
  is_semver INTEGER, has_release INTEGER
);

CREATE TABLE IF NOT EXISTS workflow (
  snapshot_id INTEGER, repo TEXT, path TEXT, name TEXT, state TEXT,
  -- mechanical checks against rules/github-actions.md
  has_paths_filter INTEGER, has_workflow_dispatch INTEGER, has_concurrency INTEGER,
  runners TEXT, uses_macos INTEGER, uses_windows INTEGER,
  on_triggers TEXT, job_count INTEGER, has_matrix INTEGER, size_bytes INTEGER,
  -- statically decidable failures that only surface on a schedule
  edits_workflow_files INTEGER, pr_create_default_token INTEGER,
  -- Job ids plus literal `name:` values, newline-joined. Names containing a
  -- ${{ }} expression are omitted: what GitHub finally calls that check cannot
  -- be known from the file. Used to tell a required context whose job was
  -- deleted from one whose job is alive but simply did not run here.
  job_names TEXT,
  -- Dependency scanners split by whether they can actually fail the job. A
  -- scanner ending in `|| true`, or carrying continue-on-error, renders exactly
  -- the same green check as a clean one -- so counting audit steps without
  -- asking whether they can fail measures ceremony, not coverage.
  audit_steps_enforcing INTEGER, audit_steps_defanged TEXT,
  -- Job ids with a step that uses actions/deploy-pages, newline-joined.
  pages_deploy_jobs TEXT,
  -- The pin of each `@dogfood-lab/atlas@<version> check` a run step issues,
  -- newline-joined; `unpinned` for a call without a version. Empty: none.
  atlas_check TEXT
);

-- One row per job that names a deployment environment, read from the YAML at
-- load. `runs_on_default` is 1 when a push to the default branch, a schedule
-- or a workflow_run can start the job, 0 when none can (a tag-only release),
-- NULL when the triggers or the job's `if:` are beyond what is evaluated. A
-- name written as an expression is not stored at all.
CREATE TABLE IF NOT EXISTS workflow_environment (
  snapshot_id INTEGER, repo TEXT, path TEXT, job TEXT,
  environment TEXT, runs_on_default INTEGER
);

-- The repository settings a deploy depends on, asked only of repos whose
-- workflows need them (see collectDeploySettings). No row: not asked, or the
-- snapshot predates the pass. Every NULL below means unknown -- a 403, a
-- gateway error, a question that was not asked -- and never "off".
CREATE TABLE IF NOT EXISTS deploy_settings (
  snapshot_id INTEGER, repo TEXT,
  pages_status INTEGER,             -- HTTP status of repos/{r}/pages; NULL = not asked
  pages_enabled INTEGER,            -- 1 on (200), 0 off (404), NULL unknown
  pages_build_type TEXT,            -- workflow | legacy, when on
  pages_source_branch TEXT,
  environments_status INTEGER,      -- HTTP status of repos/{r}/environments; NULL = not asked
  default_branch TEXT,
  default_protected INTEGER,        -- asked only for a "protected branches" environment
  any_branch_protected INTEGER,
  default_ruleset_rules INTEGER
);

-- One row per environment the repo has, from the same call. `policy` is
-- GitHub's deployment branch policy: 'all' (no restriction), 'protected'
-- (protected branches only) or 'custom' (named patterns). `branch_policies`
-- holds the custom patterns as `type:name`, newline-joined, and is read only
-- for environments a workflow names; `policies_readable` is NULL when they
-- were not asked for, 0 when the call did not answer 200 or was cut short.
CREATE TABLE IF NOT EXISTS environment (
  snapshot_id INTEGER, repo TEXT, name TEXT,
  policy TEXT, branch_policies TEXT, policies_readable INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_run (
  snapshot_id INTEGER, repo TEXT, workflow_name TEXT, path TEXT,
  run_id INTEGER, run_number INTEGER, event TEXT, status TEXT, conclusion TEXT,
  branch TEXT, created_at TEXT, updated_at TEXT, duration_s INTEGER, url TEXT,
  is_latest_for_workflow INTEGER,   -- newest run for this workflow on any branch
  on_default_branch INTEGER,        -- run's head branch == repo default branch
  is_latest_on_default INTEGER      -- newest run for this workflow ON the default branch
);

CREATE TABLE IF NOT EXISTS file_presence (
  snapshot_id INTEGER, repo TEXT,
  readme INTEGER, license INTEGER, changelog INTEGER, security INTEGER,
  contributing INTEGER, code_of_conduct INTEGER, codeowners INTEGER,
  dependabot INTEGER, gitignore INTEGER, package_json INTEGER,
  ship_gate INTEGER, claude_md INTEGER, workflows_dir INTEGER,
  root_entries INTEGER
);

-- One row per OPEN Dependabot alert. Vulnerability exposure is not derivable
-- from anything else the collector gathers: a repo can be green, released and
-- fully documented while carrying critical advisories.
CREATE TABLE IF NOT EXISTS security_alert (
  snapshot_id INTEGER, repo TEXT, number INTEGER,
  severity TEXT, ecosystem TEXT, package TEXT, manifest TEXT,
  ghsa TEXT, summary TEXT, created_at TEXT, age_days INTEGER,
  fixed_version TEXT,               -- NULL when no patched release exists yet
  url TEXT
);

-- Per-repo security posture. Kept apart from `repo` so the alert sweep can be
-- absent (missing scope, API outage) without corrupting the main row.
CREATE TABLE IF NOT EXISTS repo_security (
  snapshot_id INTEGER, repo TEXT,
  vuln_alerts INTEGER,              -- 1 scanned, 0 NOT scanned, NULL unreadable
  auto_security_fixes INTEGER,      -- 1 on, 0 off, NULL not readable
  alerts_total INTEGER, critical INTEGER, high INTEGER, medium INTEGER, low INTEGER,
  oldest_at TEXT, oldest_age_days INTEGER, fixable INTEGER
);

-- One row per committed npm lockfile, audited by the warehouse itself against
-- the npm advisory registry. This exists because GitHub's alert coverage is
-- silently per-manifest: one repo reported alerts on its root lockfile and 0
-- on site/package-lock.json, another reported 0 on both, and npm audit found a
-- critical in each of the uncounted ones. The SBOM endpoint's 404 is NOT the
-- signal (a repo can answer 404 while counting), and pushes do not repopulate
-- the graph. So the counter is read
-- directly. `github_alerts` is the open Dependabot alerts whose manifest_path
-- equals `path`, joined at load time; zero there against a non-zero
-- critical+high here is the false negative made measurable.
CREATE TABLE IF NOT EXISTS lockfile (
  snapshot_id INTEGER, repo TEXT, path TEXT, blob_sha TEXT, size_bytes INTEGER,
  lockfile_version INTEGER, packages INTEGER,
  critical INTEGER, high INTEGER, medium INTEGER, low INTEGER,
  -- The subset that SHIPS: advisories on packages with at least one non-dev
  -- edge. A critical in vitest is real but is not what users install, and
  -- many audit gates run --omit=dev, so the two must not be collapsed.
  prod_critical INTEGER, prod_high INTEGER,
  github_alerts INTEGER,
  error TEXT                        -- non-NULL means NOT measured; never read as clean
);

CREATE TABLE IF NOT EXISTS lockfile_advisory (
  snapshot_id INTEGER, repo TEXT, path TEXT,
  package TEXT, version TEXT, severity TEXT, ghsa TEXT, title TEXT, url TEXT,
  vulnerable_versions TEXT,
  dev INTEGER                       -- 1 = the package is dev-only in this lockfile
);

-- What branch protection GATES on. Split from `repo` for the same reason
-- repo_security is: the rule is readable only with admin rights, so it can be
-- absent without corrupting the main row. NULL context_count means "not
-- readable"; 0 means "read, and the branch requires nothing".
CREATE TABLE IF NOT EXISTS branch_protection (
  snapshot_id INTEGER, repo TEXT, branch TEXT,
  requires_status_checks INTEGER,   -- 1 on, 0 off, NULL not readable
  strict INTEGER,                   -- 1 = branches must be up to date to merge
  context_count INTEGER,
  contexts TEXT                     -- newline-joined, in API order
);

-- What CI actually REPORTED, per commit we can see. `source` matters: a context
-- observed on the default branch but missing from a PR head is a live job the
-- PR's file set did not trigger (paths-gated), which is a different defect with
-- a different owner than a context no commit anywhere reports (stale).
-- Rows are the observation, not the verdict -- analyze.mjs joins them.
CREATE TABLE IF NOT EXISTS check_context (
  snapshot_id INTEGER, repo TEXT,
  source TEXT,                      -- 'default' | 'pr'
  pr_number INTEGER,                -- NULL when source='default'
  name TEXT,
  state TEXT                        -- conclusion/state; NULL while still running
);

-- The Actions invoice, one row per (day, product, SKU, repo) line as GitHub
-- reports it. This is the authoritative statement of cost; everything in
-- run_cost is an ATTRIBUTION of these numbers, never a replacement for them.
--
-- `gross` and `net` are both kept and must never be collapsed. A public repo on
-- standard runners is metered at full price and then discounted to zero:
-- gross == discount, net == 0. Reporting gross as money owed invents a bill;
-- reporting only net hides real compute and with it every kind of CI waste.
-- An org of mostly public repos can show a three-figure gross month and a net
-- of exactly zero.
--
-- `repo` is NULL on org-level lines (shared storage), which is why no foreign
-- key to `repo` exists here.
CREATE TABLE IF NOT EXISTS billing_usage (
  snapshot_id INTEGER, date TEXT, product TEXT, sku TEXT,
  unit_type TEXT, quantity REAL, price_per_unit REAL,
  gross REAL, discount REAL, net REAL,
  repo TEXT
);

-- Per-run cost, computed from job durations for the repos the invoice says
-- carry the spend. Absent for every other repo BY DESIGN: the analyzer reads a
-- missing row as "not measured" and stays silent, rather than as "free".
--
-- billable_minutes is the sum of per-job wall time rounded UP to the minute --
-- not the run's duration. `unpriced_minutes` is minutes on a runner class we
-- cannot price (larger runners, unknown labels); non-zero means cost_usd is a
-- floor. self_hosted_minutes is free and is tracked so it cannot be mistaken
-- for either.
CREATE TABLE IF NOT EXISTS run_cost (
  snapshot_id INTEGER, repo TEXT, run_id INTEGER,
  workflow_name TEXT, path TEXT, event TEXT, conclusion TEXT, created_at TEXT,
  job_count INTEGER, billed_job_count INTEGER,
  billable_minutes INTEGER,
  ubuntu_minutes INTEGER, windows_minutes INTEGER, macos_minutes INTEGER,
  self_hosted_minutes INTEGER, unpriced_minutes INTEGER,
  cost_usd REAL
);

-- One row per job of a priced run. This is the only place the EXPANDED matrix
-- is visible: schema-level `workflow.job_count` counts declared jobs, and a
-- 3x2 matrix declares one. Telling "six jobs" from "one job, six cells" is the
-- difference between a workflow that complies with the matrix cap and one that
-- does not.
-- `runner_class` is cost.mjs's own verdict, stored rather than re-derived. A
-- LIKE against runner_labels would misread `self-hosted,macos` as billable
-- macOS -- free hardware charged at 10x. The labels are kept beside it as
-- evidence, never as the thing rules match on.
CREATE TABLE IF NOT EXISTS run_cost_job (
  snapshot_id INTEGER, repo TEXT, run_id INTEGER,
  name TEXT, runner_labels TEXT, runner_class TEXT, conclusion TEXT,
  minutes INTEGER, cost_usd REAL
);

-- Per-repo reconciliation of run_cost against billing_usage for the same
-- window. `trustworthy` is the gate every cost rule checks before making a
-- claim: the two sides come from different endpoints, so agreement is evidence
-- and divergence means the priced runs are not the billed runs.
CREATE TABLE IF NOT EXISTS cost_reconciliation (
  snapshot_id INTEGER, repo TEXT,
  computed_usd REAL, billed_gross_usd REAL, billed_net_usd REAL,
  ratio REAL, trustworthy INTEGER, reason TEXT
);

CREATE TABLE IF NOT EXISTS finding (
  snapshot_id INTEGER, repo TEXT, code TEXT, severity TEXT,
  category TEXT, message TEXT, evidence TEXT
);

CREATE TABLE IF NOT EXISTS collect_error (
  snapshot_id INTEGER, repo TEXT, stage TEXT, message TEXT
);

CREATE INDEX IF NOT EXISTS idx_repo_snap    ON repo(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_issue_snap   ON issue(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_pr_snap      ON pull_request(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_wf_snap      ON workflow(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_wfrun_snap   ON workflow_run(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_finding_snap ON finding(snapshot_id, severity, code);
CREATE INDEX IF NOT EXISTS idx_bprot_snap   ON branch_protection(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_ctx_snap     ON check_context(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_bill_snap    ON billing_usage(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_rcost_snap   ON run_cost(snapshot_id, repo);
CREATE INDEX IF NOT EXISTS idx_rcjob_snap   ON run_cost_job(snapshot_id, repo);
