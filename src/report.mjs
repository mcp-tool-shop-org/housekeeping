#!/usr/bin/env node
// Generate reports/AUDIT-<date>.md from a snapshot. The report is derived, never
// hand-edited: regenerating it from the same snapshot yields the same bytes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './load.mjs';
import { healthScores, RUN_IS_LIVE_MAINLINE_SIGNAL, HEAD_CHECKS_RED, doorFindingRows, ATLAS_DOOR_CHECKS_SINCE, fleetEngineFor } from './analyze.mjs';
import { exitCodeFor, formatError, userError } from './errors.mjs';
import { REPORTS_DIR } from './paths.mjs';


const md = {
  h1: s => `# ${s}\n`,
  h2: s => `\n## ${s}\n`,
  h3: s => `\n### ${s}\n`,
  p: s => `\n${s}\n`,
  table(rows, cols) {
    if (!rows.length) return '\n_None._\n';
    const keys = cols ?? Object.keys(rows[0]);
    const esc = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return '\n| ' + keys.join(' | ') + ' |\n|' + keys.map(() => '---').join('|') + '|\n' +
      rows.map(r => '| ' + keys.map(k => esc(r[k])).join(' | ') + ' |').join('\n') + '\n';
  },
};

export function buildReport(db, sid) {
  const q = (sql, ...p) => db.prepare(sql).all(sid, ...p);
  const one = (sql, ...p) => db.prepare(sql).get(sid, ...p);
  const snap = db.prepare('SELECT * FROM snapshot WHERE id=?').get(sid);

  const totals = one(`SELECT
    (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1) repos,
    (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_archived=1) archived,
    (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_private=1) private,
    (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_empty=1) empty,
    (SELECT COUNT(*) FROM issue WHERE snapshot_id=?1) issues,
    (SELECT COUNT(*) FROM pull_request WHERE snapshot_id=?1) prs,
    (SELECT COUNT(*) FROM workflow WHERE snapshot_id=?1) workflows,
    (SELECT COUNT(*) FROM workflow_run WHERE snapshot_id=?1) runs,
    (SELECT COUNT(*) FROM release WHERE snapshot_id=?1) releases,
    (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND npm_status='published') published,
    (SELECT COUNT(*) FROM finding WHERE snapshot_id=?1) findings,
    (SELECT COUNT(*) FROM collect_error WHERE snapshot_id=?1) errors`);

  const sev = q(`SELECT severity, COUNT(*) findings, COUNT(DISTINCT repo) repos
    FROM finding WHERE snapshot_id=? GROUP BY severity
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`);

  const out = [];
  const push = (...s) => out.push(...s);

  push(md.h1(`${snap.org} — operational audit`));
  push(md.p(
    `**Snapshot ${sid}** · collected \`${snap.taken_at}\` by \`${snap.gh_login}\` ` +
    `· collector v${snap.collector_version} · ${snap.duration_ms} ms · ` +
    `${totals.errors} collection errors.\n\n` +
    'Every number below is a query against `data/housekeeping.db`, rebuilt from ' +
    '`data/snapshots/*.json`. Nothing here is hand-entered. Reproduce with `npm run refresh`.'
  ));

  push(md.h2('Portfolio at a glance'));
  push(md.table([{
    repos: totals.repos, archived: totals.archived, private: totals.private,
    empty: totals.empty, 'npm published': totals.published,
    workflows: totals.workflows, 'runs sampled': totals.runs, releases: totals.releases,
    'open issues': totals.issues, 'open PRs': totals.prs,
  }]));
  push(md.p('Findings by severity:'));
  push(md.table(sev));

  // ---------------------------------------------------------------- CI ----
  push(md.h2('1. CI status'));
  const redMain = q(`SELECT DISTINCT r.name repo, r.default_branch branch, r.ci_rollup rollup,
      (SELECT GROUP_CONCAT(wr.workflow_name, '; ') FROM workflow_run wr
        WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name
          AND ${RUN_IS_LIVE_MAINLINE_SIGNAL}) failing_workflows
    FROM repo r
    WHERE r.snapshot_id=? AND r.is_archived=0
      AND (${HEAD_CHECKS_RED} OR EXISTS (
        SELECT 1 FROM workflow_run wr WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name
          AND ${RUN_IS_LIVE_MAINLINE_SIGNAL}))
    ORDER BY r.name`);
  push(md.h3(`Default branch is red — ${redMain.length} repos`));
  push(md.p('These are the only CI failures that mean "the mainline is broken." Fix first.'));
  push(md.table(redMain));

  const sched = q(`SELECT repo, message, evidence url FROM finding
    WHERE snapshot_id=? AND code='CI_SCHEDULED_FAILING' ORDER BY repo`);
  push(md.h3(`Scheduled workflows failing — ${sched.length}`));
  push(md.p('Cron jobs that have been failing unattended. Not mainline breakage, but silent rot.'));
  push(md.table(sched));

  const depFail = q(`SELECT repo, COUNT(*) failing_runs FROM finding
    WHERE snapshot_id=? AND code IN ('CI_DEPENDABOT_FAILING','CI_BRANCH_FAILING')
    GROUP BY repo ORDER BY failing_runs DESC, repo`);
  push(md.h3(`Failing on Dependabot / side branches — ${depFail.length} repos`));
  push(md.p('Backlog, not breakage: these block dependency PRs from merging.'));
  push(md.table(depFail));

  const noCi = q(`SELECT repo, message FROM finding
    WHERE snapshot_id=? AND code IN ('CI_NO_WORKFLOWS','CI_NEVER_RAN') ORDER BY repo`);
  push(md.h3(`No CI at all — ${noCi.length} repos`));
  push(md.table(noCi));

  // Sits inside the CI section because it is a CI verdict, but it is the one
  // kind of red that every other view here reports as green: the runs all
  // succeed, the rollup is SUCCESS, and the PR is still unmergeable.
  const staleGate = q(`SELECT repo, message, evidence FROM finding
    WHERE snapshot_id=? AND code='CI_REQUIRED_CHECK_STALE' ORDER BY repo`);
  push(md.h3(`Required checks nothing reports — ${staleGate.length} repos`));
  push(md.p('Branch protection is waiting on a context no job emits, so every PR is '
    + 'BLOCKED and merges only with `--admin`. Usually a renamed job or a deleted '
    + 'matrix cell that protection was never updated to match. Fix in protection '
    + '(drop the context) or in the matrix (restore the cell) — check which the '
    + 'workflow intends before dropping.'));
  push(md.table(staleGate));

  const gatedGate = q(`SELECT repo, message, evidence FROM finding
    WHERE snapshot_id=? AND code='CI_REQUIRED_CHECK_GATED' ORDER BY repo`);
  push(md.h3(`Required checks the PR never triggered — ${gatedGate.length} repos`));
  push(md.p('The job is alive; these PRs just changed files its workflow filters out, '
    + 'so the context never reports and the PR waits forever. A paths filter on a '
    + '`pull_request` trigger and a required status check cannot both be satisfied — '
    + 'rules/github-actions.md wants the filter, branch protection wants the report. '
    + 'Fix in the workflow trigger, NOT by dropping the context: the gate still works.'));
  push(md.table(gatedGate));

  const refused = q(`SELECT repo, code, message, evidence FROM finding
    WHERE snapshot_id=? AND code IN ('CI_PAGES_NOT_ENABLED','CI_ENVIRONMENT_EXCLUDES_DEFAULT')
    ORDER BY repo, code`);
  push(md.h3(`Deploys the repository's settings refuse — ${new Set(refused.map(x => x.repo)).size} repos`));
  push(md.p('The workflow is correct and the deploy still cannot succeed, because a setting '
    + 'outside the code says no: GitHub Pages is switched off under a job that deploys to it, '
    + 'or an environment\'s branch policy does not admit the default branch the job runs on. '
    + 'No workflow edit fixes these; the setting does. Read from `repos/{r}/pages` and '
    + '`repos/{r}/environments` only for repos whose workflows need them; a setting that '
    + 'could not be read produces no row here rather than a guess.'));
  push(md.table(refused));

  const runHealth = q(`SELECT conclusion, COUNT(*) runs FROM workflow_run
    WHERE snapshot_id=? GROUP BY conclusion ORDER BY runs DESC`);
  push(md.h3('Run outcomes across the sampled window'));
  push(md.p(`Last ${totals.runs} runs across all repos (up to 30 most recent per repo):`));
  push(md.table(runHealth));

  // ------------------------------------------------------------ issues ----
  // Security sits directly after CI because it answers the same question --
  // "is this repo safe to depend on today" -- and because nothing else in this
  // report would surface it.
  const secRows = q(`SELECT * FROM repo_security
    WHERE snapshot_id=? AND alerts_total > 0
    ORDER BY critical DESC, high DESC, alerts_total DESC`);
  if (secRows.length) {
    const sum = k => secRows.reduce((a, r) => a + r[k], 0);
    const off = secRows.filter(r => r.auto_security_fixes === 0);
    const fixable = sum('fixable'), total = sum('alerts_total');
    push(md.h2('2. Security'));
    push(md.p(`${total} open Dependabot alerts across ${secRows.length} repos — ` +
      `${sum('critical')} critical, ${sum('high')} high. ` +
      `${fixable} of ${total} already have a patched version available.`));
    if (off.length) {
      push(md.p(`${off.length} of these repos have Dependabot security updates **disabled**, so no fix PR ` +
        'will ever be opened: ' + off.map(r => '`' + r.repo + '`').join(', ') + '.'));
    }
    push(md.table(secRows.map(r => ({
      repo: r.repo, critical: r.critical, high: r.high, medium: r.medium, low: r.low,
      'oldest (days)': r.oldest_age_days ?? '',
      fixable: `${r.fixable}/${r.alerts_total}`,
      'auto-fix': r.auto_security_fixes === 1 ? 'on' : r.auto_security_fixes === 0 ? 'OFF' : '?',
    }))));

    push(md.h3('Most common vulnerable packages'));
    push(md.p('Alerts cluster: a handful of dependencies account for most of the count.'));
    push(md.table(q(`SELECT package, ecosystem, severity, COUNT(*) alerts
      FROM security_alert WHERE snapshot_id=? GROUP BY package, ecosystem, severity
      ORDER BY alerts DESC LIMIT 12`)));
  }

  // The warehouse's own reading of every committed lockfile, beside GitHub's.
  // Two numbers on purpose: the TRUE exposure (what npm's advisory registry
  // says about the trees actually in the repos) and the part of it GitHub is
  // blind to. The second number can be the whole story -- many repos reporting
  // zero while carrying the same critical -- and no view of repo_security can
  // show it, because that table IS GitHub's count.
  const lockRows = q(`SELECT * FROM lockfile WHERE snapshot_id=? AND error IS NULL`);
  if (lockRows.length) {
    const sum = k => lockRows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const exposed = lockRows.filter(r => (r.critical + r.high) > 0);
    const blind = exposed.filter(r => r.github_alerts === 0);
    const blindProd = blind.filter(r => (r.prod_critical + r.prod_high) > 0);
    const repoCount = rows => new Set(rows.map(r => r.repo)).size;
    const errored = q(`SELECT COUNT(*) n FROM lockfile WHERE snapshot_id=? AND error IS NOT NULL`)[0]?.n ?? 0;
    // One vendored monorepo can carry a hundred copies of the same lockfile
    // and dominate every sum. Name its share in the sentence, data-driven,
    // so the reader does not have to subtract it from the headline.
    const share = new Map();
    for (const r of lockRows) share.set(r.repo, (share.get(r.repo) ?? 0) + (r.prod_critical ?? 0) + (r.prod_high ?? 0));
    const [topRepo, topShare] = [...share.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const shippedTotal = sum('prod_critical') + sum('prod_high');
    const topNote = topRepo && shippedTotal && topShare / shippedTotal >= 0.5
      ? ` — **${Math.round(100 * topShare / shippedTotal)}% of that is \`${topRepo}\` alone** (${share.size > 1 ? 'one row in the table below' : ''})`
      : '';
    push(md.h3('Committed lockfiles, audited directly'));
    push(md.p(`${lockRows.length} lockfiles in ${repoCount(lockRows)} repos, read against the npm advisory registry this sweep. ` +
      `On **shipped** dependencies they resolve to **${sum('prod_critical')} critical** and **${sum('prod_high')} high**${topNote}; ` +
      `counting dev-only toolchain packages too, ${sum('critical')} critical and ${sum('high')} high. ` +
      `**${blindProd.length} lockfiles in ${repoCount(blindProd)} repos carry shipped critical/high advisories that GitHub reports as 0 alerts** ` +
      `for that manifest, so Dependabot will never open a fix PR for them` +
      (blind.length > blindProd.length ? ` (${blind.length - blindProd.length} more are dev-only)` : '') + '.' +
      (errored ? ` ${errored} lockfile(s) could not be read and are NOT counted as clean.` : '')));
    if (blindProd.length) {
      // Group by repo: a vendored monorepo contributes one row here, not one
      // per lockfile, so it cannot drown the other findings.
      const byRepo = new Map();
      for (const r of blindProd) {
        const g = byRepo.get(r.repo) ?? { repo: r.repo, lockfiles: 0, 'critical (shipped)': 0, 'high (shipped)': 0, 'GitHub alerts': 0 };
        g.lockfiles++; g['critical (shipped)'] += r.prod_critical; g['high (shipped)'] += r.prod_high; g['GitHub alerts'] += r.github_alerts;
        byRepo.set(r.repo, g);
      }
      push(md.table([...byRepo.values()].sort((a, b) => b['critical (shipped)'] - a['critical (shipped)'] || b['high (shipped)'] - a['high (shipped)'])));
      push(md.h4 ? md.h4('Most common shipped advisories GitHub is blind to') : md.p('**Most common shipped advisories GitHub is blind to**'));
      push(md.table(q(`SELECT a.package, a.severity, a.ghsa, COUNT(DISTINCT a.repo) repos, COUNT(*) lockfiles
        FROM lockfile_advisory a JOIN lockfile l ON l.snapshot_id=a.snapshot_id AND l.repo=a.repo AND l.path=a.path
        WHERE a.snapshot_id=? AND a.dev=0 AND a.severity IN ('critical','high') AND l.github_alerts=0
        GROUP BY a.package, a.severity, a.ghsa ORDER BY repos DESC, lockfiles DESC LIMIT 10`)));
    }
  }

  push(md.h2('3. Issues'));
  const issueTop = q(`SELECT r.name repo, r.open_issues open, r.closed_issues closed,
      (SELECT COUNT(*) FROM issue i WHERE i.snapshot_id=r.snapshot_id AND i.repo=r.name AND i.stale_days>90) stale_90d,
      (SELECT MAX(age_days) FROM issue i WHERE i.snapshot_id=r.snapshot_id AND i.repo=r.name) oldest_days
    FROM repo r WHERE r.snapshot_id=? AND r.open_issues>0 ORDER BY r.open_issues DESC, r.name`);
  push(md.p(`${totals.issues} open issues across ${issueTop.length} repos.`));
  push(md.table(issueTop));

  const oldIssues = q(`SELECT repo, number, age_days age, stale_days stale, author,
      SUBSTR(title,1,70) title FROM issue WHERE snapshot_id=?
    ORDER BY stale_days DESC LIMIT 20`);
  push(md.h3('Stalest 20 issues'));
  push(md.table(oldIssues));

  // --------------------------------------------------------------- PRs ----
  push(md.h2('4. Pull requests'));
  const prTop = q(`SELECT r.name repo, r.open_prs open,
      (SELECT COUNT(*) FROM pull_request p WHERE p.snapshot_id=r.snapshot_id AND p.repo=r.name AND p.age_days>30) older_30d,
      (SELECT COUNT(*) FROM pull_request p WHERE p.snapshot_id=r.snapshot_id AND p.repo=r.name AND p.mergeable='CONFLICTING') conflicting,
      (SELECT COUNT(*) FROM pull_request p WHERE p.snapshot_id=r.snapshot_id AND p.repo=r.name AND p.is_draft=1) draft,
      (SELECT MAX(age_days) FROM pull_request p WHERE p.snapshot_id=r.snapshot_id AND p.repo=r.name) oldest_days
    FROM repo r WHERE r.snapshot_id=? AND r.open_prs>0 ORDER BY r.open_prs DESC, r.name`);
  push(md.p(`${totals.prs} open pull requests across ${prTop.length} repos.`));
  push(md.table(prTop));

  const prAuthors = q(`SELECT author, COUNT(*) prs, COUNT(DISTINCT repo) repos,
      SUM(CASE WHEN age_days>30 THEN 1 ELSE 0 END) older_30d
    FROM pull_request WHERE snapshot_id=? GROUP BY author ORDER BY prs DESC`);
  push(md.h3('Who opened the open PRs'));
  push(md.p('Bot-authored backlog is a batching problem; human backlog is a review problem.'));
  push(md.table(prAuthors));

  const oldPrs = q(`SELECT repo, number, age_days age, mergeable, author,
      SUBSTR(title,1,60) title FROM pull_request WHERE snapshot_id=?
    ORDER BY age_days DESC LIMIT 20`);
  push(md.h3('Oldest 20 pull requests'));
  push(md.table(oldPrs));

  // ---------------------------------------------------- version drift -----
  push(md.h2('5. Release and version drift'));
  const drift = q(`SELECT r.name repo, r.pkg_name package, r.pkg_version 'package.json',
      r.latest_tag 'latest tag', r.latest_release_tag 'latest release',
      r.npm_latest_version 'npm latest', r.npm_status
    FROM repo r JOIN finding f ON f.snapshot_id=r.snapshot_id AND f.repo=r.name
    WHERE r.snapshot_id=? AND f.code IN ('VERSION_TAG_DRIFT','NPM_DRIFT','NEVER_TAGGED')
    GROUP BY r.name ORDER BY r.name`);
  push(md.p(
    'Repo version, git **tag**, and npm disagree. Tags and Releases are tracked ' +
    'separately: a repo can be correctly tagged and simply never have had a ' +
    'Release published, which is the next table, not this one.'
  ));
  push(md.table(drift));

  const relMissing = q(`SELECT repo, message, evidence tags FROM finding
    WHERE snapshot_id=? AND code='RELEASE_MISSING' ORDER BY repo`);
  push(md.h3(`Tagged but never released — ${relMissing.length} repos`));
  push(md.p('A semver tag exists with no GitHub Release behind it. The version is correct; the release was never published.'));
  push(md.table(relMissing));

  const unpub = q(`SELECT repo, message FROM finding
    WHERE snapshot_id=? AND code IN ('NPM_UNPUBLISHED','MONOREPO_ROOT') ORDER BY code, repo`);
  push(md.h3('Other version observations'));
  push(md.table(unpub));

  // ------------------------------------------------------- actions cost ---
  push(md.h2('6. GitHub Actions — cost and rule compliance'));
  push(md.p(
    'Checked mechanically against `rules/github-actions.md`. ' +
    'Each row is one workflow file, parsed as YAML rather than grepped.'
  ));

  // ---- measured cost ------------------------------------------------------
  // Absent for snapshots taken before the billing pass, or without the billing
  // scope. Say so rather than printing zeros, which would read as "free".
  const billTotals = one(`SELECT COUNT(*) lines, SUM(gross) gross, SUM(net) net
    FROM billing_usage WHERE snapshot_id=? AND product='actions'`);
  if (!billTotals?.lines) {
    push(md.h3('Measured cost'));
    const why = q("SELECT message FROM collect_error WHERE snapshot_id=? AND stage='billing'");
    push(md.p(why.length
      ? `_Not measured — the billing API was unreadable: ${why[0].message}_`
      : '_Not measured — this snapshot predates the billing pass. Run `npm run refresh`._'));
  } else {
    push(md.h3('Measured cost — what Actions actually consumed'));
    push(md.p(
      `**$${(billTotals.gross ?? 0).toFixed(2)} gross · $${(billTotals.net ?? 0).toFixed(2)} net** ` +
      `across ${billTotals.lines} invoice lines, straight from GitHub's billing API.\n\n` +
      'The two are not the same number and must not be read as one. GitHub meters **public** ' +
      'repositories on standard runners at full price and then discounts them to zero, so gross ' +
      'is real compute while net is real money. Gross is the number worth managing — it is the ' +
      'CI minutes the rules call finite — but nothing in it is owed unless it sits on a private repo.'
    ));

    push(md.table(q(`SELECT sku,
        ROUND(SUM(quantity)) quantity, unit_type,
        '$' || printf('%.2f', SUM(gross)) gross,
        '$' || printf('%.2f', SUM(net))   net
      FROM billing_usage WHERE snapshot_id=? AND product='actions'
      GROUP BY sku ORDER BY SUM(gross) DESC`)));

    const byVis = q(`SELECT
        CASE WHEN r.is_private=1 THEN 'private' ELSE 'public' END visibility,
        COUNT(DISTINCT b.repo) repos,
        '$' || printf('%.2f', SUM(b.gross)) gross,
        '$' || printf('%.2f', SUM(b.net))   net
      FROM billing_usage b JOIN repo r ON r.snapshot_id=b.snapshot_id AND r.name=b.repo
      WHERE b.snapshot_id=? AND b.product='actions' AND b.sku<>'Actions storage'
      GROUP BY visibility ORDER BY SUM(b.gross) DESC`);
    push(md.h3('Gross by visibility'));
    push(md.p('Only the private row can ever become a bill.'));
    push(md.table(byVis));

    push(md.h3('Costliest repos this month'));
    push(md.table(q(`SELECT b.repo,
        '$' || printf('%.2f', SUM(b.gross)) gross,
        ROUND(SUM(CASE WHEN b.sku='Actions Linux'   THEN b.quantity ELSE 0 END)) linux_min,
        ROUND(SUM(CASE WHEN b.sku='Actions Windows' THEN b.quantity ELSE 0 END)) win_min,
        ROUND(SUM(CASE WHEN b.sku LIKE 'Actions macOS%' THEN b.quantity ELSE 0 END)) mac_min
      FROM billing_usage b
      WHERE b.snapshot_id=? AND b.product='actions' AND b.sku<>'Actions storage'
        AND b.repo IS NOT NULL
      GROUP BY b.repo ORDER BY SUM(b.gross) DESC LIMIT 15`)));

    // Workflow-level attribution, which the invoice cannot give. Only shown for
    // repos whose priced runs reconciled against it.
    const attributed = q(`SELECT c.repo, c.workflow_name workflow,
        COUNT(*) runs,
        SUM(c.billable_minutes) min,
        '$' || printf('%.2f', SUM(c.cost_usd)) cost,
        printf('%.1f', AVG(c.billed_job_count)) jobs_per_run
      FROM run_cost c
      JOIN cost_reconciliation x ON x.snapshot_id=c.snapshot_id AND x.repo=c.repo
      WHERE c.snapshot_id=? AND x.trustworthy=1
      GROUP BY c.repo, c.workflow_name
      HAVING SUM(c.cost_usd) >= 0.25
      ORDER BY SUM(c.cost_usd) DESC LIMIT 20`);
    if (attributed.length) {
      push(md.h3('Where it went — cost by workflow'));
      push(md.p(
        'Computed from per-job durations (GitHub bills per job, rounded up to the minute, ' +
        'x2 Windows / x10 macOS), because the `/timing` endpoints return zeros. ' +
        'Only repos whose total reconciled against the invoice appear here.'
      ));
      push(md.table(attributed));
    }

    const waste = q(`SELECT c.repo,
        SUM(CASE WHEN c.conclusion='failure'   THEN c.billable_minutes ELSE 0 END) failed_min,
        SUM(CASE WHEN c.conclusion='cancelled' THEN c.billable_minutes ELSE 0 END) cancelled_min,
        SUM(c.billable_minutes) total_min,
        printf('%.0f%%', 100.0 * SUM(CASE WHEN c.conclusion='failure' THEN c.cost_usd ELSE 0 END)
                       / NULLIF(SUM(c.cost_usd),0)) failed_pct
      FROM run_cost c
      JOIN cost_reconciliation x ON x.snapshot_id=c.snapshot_id AND x.repo=c.repo
      WHERE c.snapshot_id=? AND x.trustworthy=1
      GROUP BY c.repo
      HAVING failed_min > 0 ORDER BY failed_min DESC LIMIT 15`);
    if (waste.length) {
      push(md.h3('Compute spent on runs that did not pass'));
      push(md.p(
        'Failed and cancelled are kept apart on purpose. A cancelled run is usually ' +
        '`cancel-in-progress` killing a superseded run, which is the concurrency rule ' +
        'working — counting it as waste files a finding against correct behaviour. ' +
        'Only the failed column is a defect.'
      ));
      push(md.table(waste));
    }

    // The verifier. Shown in full, including disagreements: a cost number
    // nobody checked is exactly what this table exists to prevent.
    const recon = q(`SELECT repo,
        '$' || printf('%.2f', computed_usd) computed,
        '$' || printf('%.2f', billed_gross_usd) billed_gross,
        printf('%.3f', ratio) ratio,
        CASE trustworthy WHEN 1 THEN 'ok' ELSE 'DIVERGED' END agrees, reason
      FROM cost_reconciliation WHERE snapshot_id=? ORDER BY billed_gross_usd DESC`);
    if (recon.length) {
      push(md.h3('Reconciliation — per-job sum vs the invoice'));
      push(md.p(
        'The attribution above is derived from a different endpoint than the invoice, so ' +
        'agreement is evidence and divergence is a warning that the priced runs are not the ' +
        'billed runs. Rules stay silent on any repo marked DIVERGED.'
      ));
      push(md.table(recon));
    }
  }
  const wfRule = q(`SELECT code, COUNT(*) violations, COUNT(DISTINCT repo) repos
    FROM finding WHERE snapshot_id=? AND category='actions'
    GROUP BY code ORDER BY violations DESC`);
  push(md.table(wfRule));

  const costly = q(`SELECT repo, path, runners, on_triggers triggers, job_count jobs
    FROM workflow WHERE snapshot_id=? AND (uses_macos=1 OR uses_windows=1) ORDER BY uses_macos DESC, repo`);
  push(md.h3(`Non-Linux runners — ${costly.length} workflows`));
  push(md.p('macOS bills ~10x Linux per minute; Windows ~2x.'));
  push(md.table(costly));

  const wfCount = q(`SELECT name repo, workflow_count files FROM repo
    WHERE snapshot_id=? AND workflow_count>2 ORDER BY workflow_count DESC, name LIMIT 20`);
  push(md.h3('Most workflow files (rule caps at 2)'));
  push(md.table(wfCount));

  const scheduled = q(`SELECT repo, path, on_triggers triggers FROM workflow
    WHERE snapshot_id=? AND on_triggers LIKE '%schedule%' ORDER BY repo`);
  push(md.h3(`Scheduled workflows — ${scheduled.length}`));
  push(md.p('`rules/github-actions.md` allows a scheduled workflow only when it does what a push cannot, '
    + 'runs weekly or slower, is bounded, and opens a pull request. Each of these needs checking against that.'));
  push(md.table(scheduled));

  // ---------------------------------------------------------- hygiene -----
  push(md.h2('7. Repo hygiene and metadata'));
  const hyg = q(`SELECT code, COUNT(*) repos FROM finding
    WHERE snapshot_id=? AND category IN ('hygiene','metadata','lifecycle','docs')
    GROUP BY code ORDER BY repos DESC`);
  push(md.table(hyg));

  const missing = q(`SELECT f.repo, GROUP_CONCAT(f.code, ', ') missing
    FROM finding f WHERE f.snapshot_id=? AND f.category IN ('hygiene','metadata')
    GROUP BY f.repo HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC, f.repo`);
  push(md.h3('Repos missing three or more standard files/metadata'));
  push(md.table(missing));

  // ------------------------------------------------------------ atlas -----
  // rules/atlas-map.md. Said plainly when the snapshot never looked, because
  // an empty table would otherwise read as "every repo has its map".
  push(md.h2('8. Atlas maps'));
  const atlas = one(`SELECT
      COUNT(*) running,
      SUM(CASE WHEN r.has_atlas_map=1 THEN 1 ELSE 0 END) mapped,
      SUM(CASE WHEN r.has_atlas_map=0 THEN 1 ELSE 0 END) unmapped,
      SUM(CASE WHEN r.has_atlas_map IS NULL THEN 1 ELSE 0 END) unknown
    FROM repo r WHERE r.snapshot_id=?1 AND r.is_archived=0 AND r.is_empty=0
      AND EXISTS (SELECT 1 FROM workflow w WHERE w.snapshot_id=r.snapshot_id AND w.repo=r.name)`);
  const fleet = fleetEngineFor(db, sid);
  if (!atlas?.running || atlas.unknown === atlas.running) {
    push(md.p('_Not measured — this snapshot predates the Atlas map pass (collector 1.3.0). Run `npm run refresh`._'));
  } else {
    push(md.p('Every repository that runs workflows keeps a committed map and runs a pinned ' +
      '`atlas check` in CI (`rules/atlas-map.md`). ' +
      `${atlas.mapped} of ${atlas.running} such repos have \`atlas/structure.json\` on their default branch; ` +
      `${atlas.unmapped} do not` + (atlas.unknown ? `; ${atlas.unknown} could not be read` : '') + '. ' +
      (fleet.version
        ? (fleet.source === 'fleet-pin'
          ? `The fleet engine is **${fleet.version}**, the \`atlas check\` pin ${fleet.repos} of ${fleet.pinned} pinning repos carry` +
            (fleet.npmLatest && fleet.npmLatest !== fleet.version ? ` (npm's newest is ${fleet.npmLatest}; the fleet moves to it by a pin-bump wave)` : '') + '. ' +
            'An engine behind the fleet\'s counts as a defect (`low`): the first pin-bump wave ended on 2026-09-30.'
          : `The fleet engine is **${fleet.version}** (latest \`@dogfood-lab/atlas\` on npm). ` +
            'This snapshot predates the end of the first pin-bump wave, so an older engine is reported here and not counted in the health score.')
        : (fleet.source === 'fleet-pin'
          ? 'No repository pins an `atlas check` version, so no engine is judged behind.'
          : `The fleet engine version could not be read${fleet.npmError ? ` (${fleet.npmError})` : ''}, so no engine is judged behind.`))));
    push(md.table(q(`SELECT repo, code, message FROM finding
      WHERE snapshot_id=? AND code IN ('ATLAS_MAP_MISSING','ATLAS_CHECK_NOT_IN_CI')
      ORDER BY code, repo`)));
    push(md.h3('Engine pins in CI'));
    push(md.table(q(`SELECT w.atlas_check pin, COUNT(DISTINCT w.repo) repos FROM workflow w
      JOIN repo r ON r.snapshot_id=w.snapshot_id AND r.name=w.repo
      WHERE w.snapshot_id=? AND r.is_archived=0 AND w.atlas_check <> ''
      GROUP BY w.atlas_check ORDER BY repos DESC, pin`)));

    // Atlas's own door checks: D1, a toolchain a job pins that a package it
    // runs refuses; D2, a lockfile missing the build for the job's platform.
    // Reported as Atlas reports them, as notices, and counted only among maps
    // made by an engine that records them.
    push(md.h3('Door findings'));
    const doors = doorFindingRows(
      q('SELECT repo, engine, error FROM atlas_map WHERE snapshot_id=?'),
      q('SELECT repo, file, findings, unresolved_checks FROM atlas_door WHERE snapshot_id=?'));
    if (!doors.measured) {
      push(md.p(`_Not measured — no map is made by Atlas ${ATLAS_DOOR_CHECKS_SINCE} or later, which is the first engine that records door checks._`));
    } else {
      push(md.p(`${doors.measured} of ${doors.mapped} readable maps are made by Atlas ${ATLAS_DOOR_CHECKS_SINCE} or later and record door checks; ` +
        `the other ${doors.mapped - doors.measured} are not measured. ` +
        (doors.rows.length ? `${doors.rows.length} finding(s):` : 'No door finding in any of them.')));
      if (doors.rows.length) push(md.table(doors.rows));
      if (doors.unresolved.length) {
        push(md.p('Checks Atlas could not judge (not findings):'));
        push(md.table(doors.unresolved));
      }
    }
    // One fact, two readers: the environment a job deploys to. Where a map
    // records it, it is the one the deploy rules use; a disagreement with the
    // workflow's own reading is shown, not settled here.
    const env = one(`SELECT SUM(source='atlas') fromMap,
        SUM(source='atlas' AND parsed IS NOT NULL AND parsed <> environment) disagree
      FROM workflow_environment WHERE snapshot_id=?`);
    if (env?.fromMap) {
      push(md.p(`Job environments taken from the map: ${env.fromMap}; ` +
        `${env.disagree ? `**${env.disagree} disagree with the workflow's own reading**` : 'all agree with the workflow\'s own reading'}.`));
    }
  }

  // ----------------------------------------------------------- health -----
  push(md.h2('9. Health leaderboard'));
  push(md.p(
    'Score starts at 100; each finding deducts by severity (high 15, medium 6, low 2, info 0). ' +
    'It ranks attention, it is not a quality judgment — a busy repo accrues findings faster than a dormant one.'
  ));
  const health = healthScores(db, sid);
  push(md.h3('Needs attention (worst 25)'));
  push(md.table(health.slice(0, 25).map(h => ({ repo: h.name, score: h.score, findings: h.findings }))));
  const clean = health.filter(h => h.findings === 0);
  push(md.h3(`Clean — ${clean.length} repos with zero findings`));
  push(md.p(clean.length ? clean.map(h => `\`${h.name}\``).join(', ') : '_None._'));

  // -------------------------------------------------------- appendix ------
  push(md.h2('Appendix — finding codes'));
  push(md.table(q(`SELECT code, severity, category, COUNT(*) n,
      MIN(message) example FROM finding WHERE snapshot_id=?
    GROUP BY code ORDER BY category, code`)));

  const errs = q('SELECT repo, stage, message FROM collect_error WHERE snapshot_id=?');
  if (errs.length) {
    push(md.h2('Collection errors'));
    push(md.table(errs));
  }

  return out.join('');
}

/** Write reports/AUDIT-<date>.md for a loaded snapshot. Returns the path written. */
export function writeReport(db, sid) {
  const snap = db.prepare('SELECT taken_at FROM snapshot WHERE id=?').get(sid);
  if (!snap) throw userError('NO_SNAPSHOT', `snapshot ${sid} is not loaded`, '`hk snapshots` lists the ones that are');
  const text = buildReport(db, sid);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const file = join(REPORTS_DIR, `AUDIT-${snap.taken_at.slice(0, 10)}.md`);
  writeFileSync(file, text);
  return file;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  try {
    const db = openDb();
    const latest = db.prepare('SELECT MAX(id) AS id FROM snapshot').get().id;
    if (!process.argv[2] && !latest) throw userError('NO_SNAPSHOT', 'no snapshot is loaded', 'run `hk refresh` first');
    console.error(`[report] wrote ${writeReport(db, process.argv[2] ? Number(process.argv[2]) : latest)}`);
  } catch (e) {
    console.error(formatError(e));
    process.exit(exitCodeFor(e));
  }
}
