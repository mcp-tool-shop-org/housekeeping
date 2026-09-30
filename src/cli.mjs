#!/usr/bin/env node
// housekeeping CLI - query the org operational-health warehouse.
//
// Results go to stdout; progress and errors go to stderr. Exit codes are in
// errors.mjs: 0 ok, 1 user error, 2 runtime error, 3 partial.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, loadSnapshot, latestSnapshotFile, DB_PATH } from './load.mjs';
import { analyze, healthScores, RUN_IS_LIVE_MAINLINE_SIGNAL } from './analyze.mjs';
import { collect, DRILL_BUDGET } from './collect.mjs';
import { preflight } from './gh.mjs';
import { resolveOrg } from './config.mjs';
import { writeReport } from './report.mjs';
import { EXIT, HkError, userError, exitCodeFor, formatError, readOnlyQuery, sweepGaps } from './errors.mjs';
import { info, isDebug, levelFromFlags, parseLevel, setLevel } from './log.mjs';

// Opened by the first command that needs it, so `hk help` and a mistyped
// command never create a database.
let db = null;
const latestSid = () => {
  const row = db.prepare('SELECT MAX(id) AS id FROM snapshot').get();
  if (!row?.id) throw userError('NO_SNAPSHOT', 'no snapshot is loaded', 'run `hk refresh` to sweep, or `hk load <file>` to load one');
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
    if (!name) throw userError('USAGE', '`hk repo` needs a repository name', 'hk repo <name>');
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

// ---- commands ---------------------------------------------------------------
// One table drives both the dispatch and `hk help`, so the help text cannot
// describe a command that does not exist or omit one that does.

async function refresh(args) {
  const org = resolveOrg(args.find(a => !a.startsWith('--')));
  db = openDb();

  // A sweep costs a few hundred API calls. Starting one without the headroom
  // to finish produces a PARTIALLY collected snapshot, and load.mjs stores it
  // without complaint -- a half-swept org then reads as a healthy one. Refuse
  // up front instead. `--force` is there for the case where you accept a
  // partial and know it.
  const force = args.includes('--force');
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
      throw new HkError('RATE_LIMITED',
        `refusing to start: GitHub's secondary rate limit is active (the quota is healthy at core ${pre.core}, graphql ${pre.graphql})`,
        { hint: 'too many concurrent callers on this token; retry in a few minutes with fewer', retryable: true });
    }
    throw new HkError('RATE_LIMITED',
      `refusing to start: core ${pre.core}, graphql ${pre.graphql} calls remain, and a full sweep would be cut short`,
      { hint: `the quota resets in ${pre.resetsInS}s; or re-run with --force to accept a partial snapshot`, retryable: true });
  }
  if (pre.unknown) info('[refresh] rate-limit probe unreadable; continuing without a budget check.');

  const { snapshot } = await collect(org);
  const sid = loadSnapshot(db, snapshot);
  const n = analyze(db, sid);
  info(`[refresh] snapshot ${sid}: ${snapshot.repo_count} repos, ${n} findings`);
  info(`[refresh] wrote ${writeReport(db, sid)}`);
  REPORTS.summary(sid);

  const gaps = sweepGaps(snapshot);
  if (gaps.length) {
    // The snapshot is stored and the report is written: what was collected is
    // true. But it is not everything that was asked for, and a caller that
    // only reads the exit code must be able to tell.
    for (const g of gaps) console.error(`partial: ${g}`);
    return EXIT.PARTIAL;
  }
  return EXIT.OK;
}

function load(args) {
  db = openDb();
  const file = args[0] ?? latestSnapshotFile();
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    throw userError('SNAPSHOT_UNREADABLE', `cannot read a snapshot from ${file}: ${e.message}`,
      'pass the path of a file under data/snapshots/');
  }
  const sid = loadSnapshot(db, snapshot);
  analyze(db, sid);
  info(`[load] snapshot ${sid} <- ${file}`);
}

function report(args) {
  db = openDb();
  const sid = args[0] ? Number(args[0]) : latestSid();
  if (!Number.isInteger(sid)) throw userError('USAGE', `"${args[0]}" is not a snapshot id`, 'hk snapshots lists them');
  info(`[report] wrote ${writeReport(db, sid)}`);
}

function sql(args) {
  const q = readOnlyQuery(args.join(' '));
  // A connection that cannot write, as well as a statement check: the
  // warehouse is derived data, and `hk sql` is documented as read-only.
  openDb().close();                       // make sure the file and schema exist
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  let rows;
  try { rows = db.prepare(q).all(); }
  catch (e) { throw userError('SQL_FAILED', e.message, 'hk sql "SELECT name FROM sqlite_master" lists the tables'); }
  table(rows, { max: 500 });
}

const viaReport = name => args => { db = openDb(); return REPORTS[name](latestSid(), ...args); };

const COMMANDS = {
  refresh:          ['[org] [--force]', 'sweep the org: collect, load, analyze, write the report (network)', refresh],
  load:             ['[file]',          'load a snapshot JSON already on disk (the newest by default)', load],
  report:           ['[snapshot-id]',   'write reports/AUDIT-<date>.md for a loaded snapshot', report],
  summary:          ['',                'snapshot totals (the default command)', viaReport('summary')],
  repos:            ['',                'every repo, one line each', viaReport('repos')],
  repo:             ['<name>',          'one repo in full, with findings', viaReport('repo')],
  findings:         ['',                'finding counts by severity, category and code', viaReport('findings')],
  health:           ['',                'per-repo health score, worst first', viaReport('health')],
  ci:               ['',                'repos whose default branch is red', viaReport('ci')],
  actions:          ['',                'every workflow and its rule-compliance flags', viaReport('actions')],
  cost:             ['',                'Actions cost per repo, gross and net side by side', viaReport('cost')],
  'cost-workflows': ['[repo]',          'which workflow spent the minutes', viaReport('cost-workflows')],
  'cost-jobs':      ['[repo]',          'which job, with expanded matrix cells', viaReport('cost-jobs')],
  versions:         ['',                'package.json against git tag against npm', viaReport('versions')],
  prs:              ['',                'every open pull request by age', viaReport('prs')],
  issues:           ['',                'every open issue by staleness', viaReport('issues')],
  snapshots:        ['',                'the snapshots loaded into the database', () => {
    db = openDb();
    table(db.prepare('SELECT id, taken_at, org, repo_count, duration_ms FROM snapshot ORDER BY id').all());
  }],
  sql:              ['"<query>"',       'one read-only SELECT or WITH statement', sql],
  help:             ['',                'this text', () => console.log(usage())],
};

function usage() {
  const rows = Object.entries(COMMANDS).map(([name, [args, help]]) => [`hk ${name}${args ? ' ' + args : ''}`, help]);
  const w = Math.max(...rows.map(r => r[0].length));
  return [
    'housekeeping - an operational-health warehouse for a GitHub organization',
    '',
    ...rows.map(([l, r]) => `  ${l.padEnd(w)}  ${r}`),
    '',
    'Flags, on any command:',
    '  --quiet     errors only',
    '  --verbose   one line per GitHub call',
    '  --debug     stack traces on errors',
    '  --help, -h  this text',
    '',
    'Exit codes: 0 ok, 1 user error, 2 runtime error, 3 partial (finished, with gaps).',
  ].join('\n');
}

const GLOBAL_FLAGS = new Set(['--quiet', '--verbose', '--debug', '--help', '-h']);

async function main(argv) {
  const flags = new Set(argv.filter(a => GLOBAL_FLAGS.has(a)));
  const [cmd = 'summary', ...args] = argv.filter(a => !GLOBAL_FLAGS.has(a));
  if (flags.has('--help') || flags.has('-h')) { console.log(usage()); return EXIT.OK; }
  // Validated here, once, so a mistyped HK_LOG is reported before any work
  // starts and not from the middle of a sweep.
  setLevel(levelFromFlags(flags) ?? parseLevel(process.env.HK_LOG));
  const entry = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!entry) throw userError('USAGE', `unknown command "${cmd}"`, '`hk help` lists the commands');
  return (await entry[2](args)) ?? EXIT.OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // isDebug() can itself throw on a malformed HK_LOG; that must not mask `e`.
  let debug = process.argv.includes('--debug');
  try { debug = debug || isDebug(); } catch { /* reported by the command that read it */ }
  console.error(formatError(e, { debug }));
  process.exitCode = exitCodeFor(e);
}
