#!/usr/bin/env node
// housekeeping CLI - query the org operational-health warehouse.
import { readFileSync } from 'node:fs';
import { openDb, loadSnapshot, latestSnapshotFile } from './load.mjs';
import { analyze, healthScores, RUN_IS_LIVE_MAINLINE_SIGNAL } from './analyze.mjs';
import { collect, DRILL_BUDGET } from './collect.mjs';
import { preflight, RateLimitError } from './gh.mjs';
import { resolveOrg } from './config.mjs';

const db = openDb();
const latestSid = () => {
  const row = db.prepare('SELECT MAX(id) AS id FROM snapshot').get();
  if (!row?.id) throw new Error('no snapshots loaded - run `npm run refresh`');
  return row.id;
};

function table(rows, { max = 200 } = {}) {
  if (!rows.length) return console.log('(no rows)');
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, max);
  const w = cols.map(c => Math.min(60, Math.max(c.length,
    ...shown.map(r => String(r[c] ?? '').length))));
  const line = (cells) => cells.map((s, i) => String(s ?? '').slice(0, w[i]).padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of shown) console.log(line(cols.map(c => r[c])));
  if (rows.length > shown.length) console.log(`... ${rows.length - shown.length} more rows`);
}

const REPORTS = {
  summary: sid => {
    const s = db.prepare('SELECT * FROM snapshot WHERE id=?').get(sid);
    console.log(`snapshot ${sid}  org=${s.org}  taken=${s.taken_at}  collector=${s.collector_version}`);
    table(db.prepare(`SELECT
      (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1) repos,
      (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_archived=1) archived,
      (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_private=1) private,
      (SELECT COUNT(*) FROM issue WHERE snapshot_id=?1) open_issues,
      (SELECT COUNT(*) FROM pull_request WHERE snapshot_id=?1) open_prs,
      (SELECT COUNT(*) FROM workflow WHERE snapshot_id=?1) workflows,
      (SELECT COUNT(*) FROM workflow_run WHERE snapshot_id=?1) runs,
      (SELECT COUNT(*) FROM release WHERE snapshot_id=?1) releases,
      (SELECT COUNT(*) FROM finding WHERE snapshot_id=?1) findings,
      (SELECT COUNT(*) FROM collect_error WHERE snapshot_id=?1) collect_errors`).all(sid));
  },
  // Must stay identical to report.mjs's "default branch is red" query: only
  // latest-on-default runs from push-like events count as a broken mainline.
  ci: sid => table(db.prepare(`
    SELECT DISTINCT r.name, r.default_branch branch, r.ci_rollup rollup,
           r.open_prs, r.days_since_push push_age,
           (SELECT GROUP_CONCAT(wr.workflow_name, '; ') FROM workflow_run wr
             WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name
               AND ${RUN_IS_LIVE_MAINLINE_SIGNAL}) failing
    FROM repo r WHERE r.snapshot_id=? AND r.is_archived=0
      AND (r.ci_rollup IN ('FAILURE','ERROR') OR EXISTS (
        SELECT 1 FROM workflow_run wr WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name
          AND ${RUN_IS_LIVE_MAINLINE_SIGNAL}))
    ORDER BY r.name`).all(sid)),
  findings: sid => table(db.prepare(`
    SELECT severity, category, code, COUNT(*) n, COUNT(DISTINCT repo) repos
    FROM finding WHERE snapshot_id=?
    GROUP BY severity, category, code
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                           WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, n DESC`).all(sid)),
  health: sid => table(healthScores(db, latestOr(sid)).slice(0, 40)),
  prs: sid => table(db.prepare(`
    SELECT repo, number, age_days age, stale_days stale, is_draft draft, mergeable,
           author, SUBSTR(title,1,54) title
    FROM pull_request WHERE snapshot_id=? ORDER BY age_days DESC`).all(sid), { max: 400 }),
  issues: sid => table(db.prepare(`
    SELECT repo, number, age_days age, stale_days stale, comments c,
           author, SUBSTR(title,1,54) title
    FROM issue WHERE snapshot_id=? ORDER BY stale_days DESC`).all(sid), { max: 400 }),
  actions: sid => table(db.prepare(`
    SELECT repo, path, on_triggers, has_paths_filter paths, has_concurrency conc,
           has_workflow_dispatch disp, runners, job_count jobs
    FROM workflow WHERE snapshot_id=? ORDER BY repo, path`).all(sid), { max: 400 }),
  // Gross vs net are printed side by side and never summed. On a public repo
  // GitHub meters at full price and discounts to zero: gross is compute worth
  // managing, net is money owed.
  cost: sid => {
    const lines = db.prepare(
      "SELECT COUNT(*) n FROM billing_usage WHERE snapshot_id=? AND product='actions'").get(sid);
    if (!lines.n) {
      const err = db.prepare(
        "SELECT message FROM collect_error WHERE snapshot_id=? AND stage='billing'").all(sid);
      return console.log(err.length
        ? `no cost data - billing API unreadable: ${err[0].message}`
        : 'no cost data in this snapshot - run `hk refresh`');
    }
    table(db.prepare(`SELECT b.repo,
        printf('%.2f', SUM(b.gross)) gross, printf('%.2f', SUM(b.net)) net,
        CASE WHEN r.is_private=1 THEN 'private' ELSE 'public' END vis,
        ROUND(SUM(CASE WHEN b.sku='Actions Linux'       THEN b.quantity ELSE 0 END)) linux_min,
        ROUND(SUM(CASE WHEN b.sku='Actions Windows'     THEN b.quantity ELSE 0 END)) win_min,
        ROUND(SUM(CASE WHEN b.sku LIKE 'Actions macOS%' THEN b.quantity ELSE 0 END)) mac_min
      FROM billing_usage b LEFT JOIN repo r ON r.snapshot_id=b.snapshot_id AND r.name=b.repo
      WHERE b.snapshot_id=? AND b.product='actions' AND b.sku<>'Actions storage'
        AND b.repo IS NOT NULL
      GROUP BY b.repo ORDER BY SUM(b.gross) DESC`).all(sid), { max: 25 });
  },
  // Per-workflow attribution, restricted to repos whose priced runs agreed with
  // the invoice. A cost claim on a repo that diverged is a guess.
  'cost-workflows': (sid, repo) => table(db.prepare(`
    SELECT c.repo, c.workflow_name workflow, COUNT(*) runs,
           SUM(c.billable_minutes) min, printf('%.2f', SUM(c.cost_usd)) cost,
           printf('%.1f', AVG(c.billed_job_count)) jobs_per_run,
           SUM(CASE WHEN c.conclusion='failure' THEN 1 ELSE 0 END) failed
    FROM run_cost c
    JOIN cost_reconciliation x ON x.snapshot_id=c.snapshot_id AND x.repo=c.repo
    WHERE c.snapshot_id=? AND x.trustworthy=1 AND (?2 IS NULL OR c.repo=?2)
    GROUP BY c.repo, c.workflow_name ORDER BY SUM(c.cost_usd) DESC`).all(sid, repo ?? null)),
  'cost-jobs': (sid, repo) => table(db.prepare(`
    SELECT j.repo, c.workflow_name workflow,
           TRIM(CASE WHEN j.name LIKE '%(%)' THEN SUBSTR(j.name,1,INSTR(j.name,' (')-1)
                     ELSE j.name END) job,
           COUNT(*) cells, SUM(j.minutes) min, printf('%.2f', SUM(j.cost_usd)) cost
    FROM run_cost_job j JOIN run_cost c
      ON c.snapshot_id=j.snapshot_id AND c.run_id=j.run_id
    WHERE j.snapshot_id=? AND (?2 IS NULL OR j.repo=?2)
    GROUP BY j.repo, c.workflow_name, job
    ORDER BY SUM(j.cost_usd) DESC`).all(sid, repo ?? null), { max: 40 }),
  versions: sid => table(db.prepare(`
    SELECT name, pkg_name, pkg_version pkg, latest_tag tag,
           latest_release_tag release, npm_latest_version npm, npm_status,
           (SELECT COUNT(*) FROM tag t WHERE t.snapshot_id=r.snapshot_id
              AND t.repo=r.name AND t.is_semver=1 AND t.has_release=0) untagged_rel
    FROM repo r WHERE snapshot_id=? AND pkg_name IS NOT NULL
    ORDER BY name`).all(sid), { max: 200 }),
  repos: sid => table(db.prepare(`
    SELECT name, is_private priv, is_archived arch, primary_language lang,
           disk_usage_kb kb, days_since_push push_age, open_issues iss, open_prs prs,
           release_count rels, ci_rollup, workflow_count wfs
    FROM repo WHERE snapshot_id=? ORDER BY name`).all(sid), { max: 200 }),
  repo: (sid, name) => {
    if (!name) throw new Error('usage: hk repo <name>');
    table(db.prepare('SELECT * FROM repo WHERE snapshot_id=? AND name=?').all(sid, name));
    console.log('\n-- findings --');
    table(db.prepare('SELECT severity, code, message, evidence FROM finding WHERE snapshot_id=? AND repo=?').all(sid, name));
    console.log('\n-- workflows --');
    table(db.prepare('SELECT path, on_triggers, has_paths_filter, has_concurrency, runners FROM workflow WHERE snapshot_id=? AND repo=?').all(sid, name));
    console.log('\n-- open PRs --');
    table(db.prepare('SELECT number, age_days, mergeable, author, SUBSTR(title,1,60) title FROM pull_request WHERE snapshot_id=? AND repo=?').all(sid, name));
  },
};

function latestOr(sid) { return sid; }

const [, , cmd = 'summary', ...rest] = process.argv;

try {
  if (cmd === 'refresh') {
    const org = resolveOrg(rest[0]);

    // A sweep costs roughly 90 GraphQL points and 80+ REST calls. Starting one
    // without the headroom to finish produces a PARTIALLY collected snapshot,
    // and load.mjs stores it without complaint -- a half-swept org then reads
    // as a healthy one. Refuse up front instead. `--force` is there for the
    // case where you accept a partial and know it.
    const force = rest.includes('--force');
    // 300 covers the base sweep. The cost drill is the expensive part -- one
    // REST call per priced run on a cold cache -- so its budget is added here
    // rather than discovered halfway through. Capped at 900 because a warm
    // cache spends almost none of it, and refusing an otherwise-healthy sweep
    // over a reserve it will not use is its own failure. If the drill does run
    // out it halts and marks the attribution incomplete; it never truncates
    // silently.
    const pre = await preflight({
      rest: 300 + Math.min(DRILL_BUDGET, 900),
      graphql: 300,
    });
    if (!pre.ok && !force) {
      if (pre.limit === 'secondary') {
        // The quota is fine and we are still blocked: burst/concurrency limit.
        // It is short-lived and has no published clock, so there is nothing to
        // wait *for* -- just fewer callers.
        console.error('[refresh] refusing to start: SECONDARY rate limit is active ' +
          `(quota is healthy at core ${pre.core}, graphql ${pre.graphql} -- that is why it is not the quota).`);
        console.error('[refresh] too many concurrent callers on this token. Retry in a few minutes with fewer.');
      } else {
        console.error(`[refresh] refusing to start: core ${pre.core}, graphql ${pre.graphql} remaining; ` +
          `resets in ${pre.resetsInS}s. A full sweep needs ~80 REST + ~90 GraphQL and would truncate.`);
        console.error('[refresh] wait for the reset, or re-run with --force to accept a partial snapshot.');
      }
      process.exit(3);
    }
    if (pre.unknown) console.error('[refresh] rate-limit probe unreadable; continuing without a budget check.');

    const { snapshot } = await collect(org);
    const sid = loadSnapshot(db, snapshot);
    const n = analyze(db, sid);
    console.error(`[refresh] snapshot ${sid}: ${snapshot.repo_count} repos, ${n} findings`);
    REPORTS.summary(sid);
  } else if (cmd === 'load') {
    const file = rest[0] ?? latestSnapshotFile();
    const sid = loadSnapshot(db, JSON.parse(readFileSync(file, 'utf8')));
    analyze(db, sid);
    console.error(`[load] snapshot ${sid} <- ${file}`);
  } else if (cmd === 'sql') {
    const sql = rest.join(' ');
    if (!sql) throw new Error('usage: hk sql "<query>"');
    table(db.prepare(sql).all(), { max: 500 });
  } else if (cmd === 'snapshots') {
    table(db.prepare('SELECT id, taken_at, org, repo_count, duration_ms FROM snapshot ORDER BY id').all());
  } else if (REPORTS[cmd]) {
    REPORTS[cmd](latestSid(), ...rest);
  } else {
    console.log(`housekeeping - org operational-health warehouse

  hk refresh [org]     collect + load + analyze (network)
  hk load [file]       load a snapshot JSON already on disk
  hk summary           snapshot totals
  hk repos             every repo, one line each
  hk repo <name>       one repo in full, with findings
  hk findings          finding counts by severity/category/code
  hk health            per-repo health score, worst first
  hk ci                repos with failing CI
  hk actions           every workflow and its rule-compliance flags
  hk cost              Actions spend per repo, gross vs net
  hk cost-workflows [repo]  which workflow burned the minutes
  hk cost-jobs [repo]  which job, with expanded matrix cells
  hk versions          package.json vs tag vs npm
  hk prs               every open PR by age
  hk issues            every open issue by staleness
  hk snapshots         collection history
  hk sql "<query>"     arbitrary read-only SQL`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
