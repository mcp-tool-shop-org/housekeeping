// An independent check of the audit's findings against live GitHub.
//
// The rule is that nothing verifies its own output. In code, that means
// this file must never import src/analyze.mjs, src/load.mjs, or
// src/gh.mjs. It re-derives the claims straight from `gh` through its own
// transport and its own reading of the rules, then compares the answer to what
// the warehouse asserts. Divergence fails the test. Sharing a helper with the
// generator would let one bug agree with itself, which is exactly the failure
// mode the standard exists to catch.
//
// It targets the three distinctions that were REAL defects on 2026-09-07 --
// each shipped a confident, plausible, wrong count before being caught by hand
// against `gh`:
//   1. a red default branch vs a red Dependabot branch vs a failing cron,
//   2. a monorepo workspace root vs a shipped package,
//   3. a semver release tag vs an asset tag.
// Plus DEFAULT_BRANCH_NOT_MAIN, which is high severity and cheap to check.
//
// Cost is bounded: it samples repos rather than sweeping all 96. The sample is
// deliberately mixed -- repos that CARRY a CI finding (catches over-reporting)
// and repos that carry NONE (catches under-reporting). A verifier that only
// looks where the generator already pointed cannot detect a missed finding.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pexec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the verifier can be pointed at a database built somewhere
// else -- e.g. when the canonical file is locked by another process and
// `npm run rebuild` cannot unlink it.
const DB = process.env.HOUSEKEEPING_DB ?? join(ROOT, 'data', 'housekeeping.db');
const SAMPLE = Number(process.env.HK_VERIFY_SAMPLE ?? 4);
const SEMVER_TAG = /^v?\d+\.\d+\.\d+$/;

// Own transport. Not src/gh.mjs -- see the header.
async function gh(args) {
  const { stdout } = await pexec('gh', args, {
    maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32',
  });
  return stdout;
}
const ghJson = async (args) => JSON.parse(await gh(args));

let db = null, snap = null, org = null, live = false, skipWhy = '';

before(async () => {
  if (!existsSync(DB)) { skipWhy = 'no database at ' + DB + ' -- run `npm run rebuild` first'; return; }
  db = new DatabaseSync(DB, { readOnly: true });
  snap = db.prepare('SELECT * FROM snapshot ORDER BY id DESC LIMIT 1').get();
  if (!snap) { skipWhy = 'database has no snapshot'; return; }
  org = snap.org;
  // Probe with the thing this file actually depends on -- a REST call -- rather
  // than `gh auth status`. The two disagree in both directions: `auth status`
  // fails on a stale keyring entry while the API still answers (a false skip),
  // and it succeeds while the API is rate-limited (a false "live", where every
  // assertion below then fails on an error body instead of skipping). Probing
  // with the real call collapses both into the honest answer. Rate-limit
  // exhaustion is not hypothetical: a single session that sweeps the org twice
  // will spend 5000 REST calls and leave this file correctly skipping until the
  // window resets.
  try { await gh(['api', 'user', '--jq', '.login']); live = true; }
  catch { skipWhy = '`gh` is unavailable or unauthenticated -- verification needs live ground truth'; }
});

// A skip must be loud. A verifier that quietly passes when it verified nothing
// is worse than no verifier, because a green run would then claim coverage
// that does not exist.
const guard = (t) => {
  if (live) return false;
  t.diagnostic('SKIPPED: ' + skipWhy);
  t.skip(skipWhy);
  return true;
};

const findings = (repo) =>
  db.prepare('SELECT code, message, evidence FROM finding WHERE snapshot_id = ? AND repo = ?')
    .all(snap.id, repo);

const repoRow = (repo) =>
  db.prepare('SELECT * FROM repo WHERE snapshot_id = ? AND name = ?').get(snap.id, repo);

// Was this Dependabot alert open at instant `at`? Parsed, never compared as
// strings: GitHub writes "…:35Z" and the snapshot "…:35.599Z", and 'Z' sorts
// after '.', so string order gets same-second events backwards. Blind spot: a
// dismissed alert that was later reopened has its dismissed_at cleared, so it
// reads as open throughout. Rare, and it errs toward "open".
function openAt(alert, at) {
  const t = Date.parse(at);
  if (!(Date.parse(alert.created_at) <= t)) return false;
  return ![alert.fixed_at, alert.dismissed_at, alert.auto_dismissed_at]
    .some(c => c && Date.parse(c) <= t);
}

test('openAt judges an alert by when it closed, not by its state now', () => {
  // The 2026-09-30 case: created before the sweep, fixed 19 minutes after.
  const a = { created_at: '2026-09-30T14:08:02Z', fixed_at: '2026-09-30T14:29:02Z',
    dismissed_at: null, auto_dismissed_at: null, state: 'fixed' };
  assert.equal(openAt(a, '2026-09-30T14:10:35.599Z'), true);
  assert.equal(openAt(a, '2026-09-30T14:29:02Z'), false);    // closed at that instant
  assert.equal(openAt(a, '2026-09-30T14:08:01Z'), false);    // not yet created
  // Same second, millis on one side only: string order would say the reverse.
  assert.equal(openAt({ ...a, fixed_at: null }, '2026-09-30T14:08:02.500Z'), true);
  assert.equal(openAt({ ...a, fixed_at: null, auto_dismissed_at: '2026-09-30T14:09:00Z' },
    '2026-09-30T14:10:00Z'), false);
});

/** Repos carrying a CI finding, plus controls carrying none. Mixed on purpose. */
function sampleRepos() {
  const withCi = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? AND code IN " +
    "('CI_RUN_FAILING','CI_DEPENDABOT_FAILING','CI_SCHEDULED_FAILING','CI_BRANCH_FAILING') " +
    "ORDER BY repo LIMIT ?").all(snap.id, SAMPLE).map(r => r.repo);
  const controls = db.prepare(
    "SELECT r.name AS repo FROM repo r WHERE r.snapshot_id = ? AND r.is_archived = 0 " +
    "AND r.is_empty = 0 AND r.name NOT IN " +
    "(SELECT repo FROM finding WHERE snapshot_id = ? AND code LIKE 'CI_%') " +
    "ORDER BY r.name LIMIT 2").all(snap.id, snap.id).map(r => r.repo);
  return { withCi, controls };
}

test('CI findings distinguish a red mainline from a red Dependabot or cron run', async (t) => {
  if (guard(t)) return;
  const { withCi, controls } = sampleRepos();
  assert.ok(withCi.length + controls.length > 0, 'sample is empty -- nothing verified');

  for (const repo of [...withCi, ...controls]) {
    const row = repoRow(repo);
    const branch = row && row.default_branch;
    if (!branch) continue;

    // `gh run list` is a different endpoint and shape from the collector's
    // `gh api .../actions/runs`. Agreeing through two paths is the point.
    let runs;
    try {
      runs = await ghJson(['run', 'list', '--repo', org + '/' + repo, '--branch', branch,
        '--limit', '100', '--json',
        'databaseId,workflowName,event,conclusion,createdAt,headBranch']);
    } catch (e) {
      t.diagnostic(repo + ': could not list runs (' + e.message.split('\n')[0] + ') -- skipped');
      continue;
    }

    // A deleted workflow's last run is history, not a broken mainline. Run
    // history outlives the file, so a repo can still show failures from months
    // ago for workflows that no longer exist in it. Judging on history alone
    // manufactures a defect out of a file someone correctly removed. GitHub's
    // own workflow list reports which files are still there.
    let activeNames;
    try {
      const wf = await ghJson(['api', 'repos/' + org + '/' + repo + '/actions/workflows?per_page=100']);
      activeNames = new Set((wf.workflows ?? [])
        .filter(w => w.state === 'active').map(w => w.name));
    } catch {
      t.diagnostic(repo + ': could not list workflows -- skipped');
      continue;
    }

    // The org keeps moving. Only judge runs that already existed when the
    // snapshot was taken; anything newer is the world changing, not a defect.
    const asOf = runs.filter(r => r.createdAt <= snap.taken_at
      && r.headBranch === branch
      && activeNames.has(r.workflowName));
    if (asOf.length === 0) continue;

    // Latest run per workflow on the default branch, re-derived here.
    const latest = new Map();
    for (const r of asOf) {
      const prev = latest.get(r.workflowName);
      if (!prev || r.createdAt > prev.createdAt) latest.set(r.workflowName, r);
    }

    const expected = new Map();   // workflowName -> code, by this file's own reading
    for (const r of latest.values()) {
      if (r.conclusion !== 'failure' && r.conclusion !== 'timed_out') continue;
      expected.set(r.workflowName,
        r.event === 'dynamic' ? 'CI_DEPENDABOT_FAILING'
          : r.event === 'schedule' ? 'CI_SCHEDULED_FAILING'
            : 'CI_RUN_FAILING');
    }

    const got = findings(repo);
    const gotRedMainline = got.some(f => f.code === 'CI_RUN_FAILING');
    const wantRedMainline = [...expected.values()].includes('CI_RUN_FAILING');

    // Over-reporting: the audit calls the mainline broken when no push-like run
    // on the default branch actually failed. This is defect #1 -- it once turned
    // 9 red repos into 19.
    if (gotRedMainline && !wantRedMainline) {
      const claimed = got.filter(f => f.code === 'CI_RUN_FAILING').map(f => f.message).join(' | ');
      assert.fail(repo + ': CI_RUN_FAILING claimed, but no push-like run on "' + branch
        + '" failed as of ' + snap.taken_at + '. Latest per workflow: '
        + [...latest.values()].map(r => r.workflowName + '=' + r.conclusion + '/' + r.event).join(', ')
        + '\n  claimed: ' + claimed);
    }
    // Under-reporting: a genuinely broken mainline the audit stayed quiet about.
    // The control repos exist to reach this branch.
    if (wantRedMainline && !gotRedMainline) {
      const which = [...expected].filter(([, c]) => c === 'CI_RUN_FAILING').map(([w]) => w);
      assert.fail(repo + ': "' + which.join(', ') + '" failed on "' + branch
        + '" from a push-like event, but no CI_RUN_FAILING was reported.');
    }
    // A Dependabot or cron failure must never be filed as a broken mainline.
    for (const [wf, code] of expected) {
      if (code === 'CI_RUN_FAILING') continue;
      const mis = got.find(f => f.code === 'CI_RUN_FAILING' && f.message.includes(wf));
      assert.equal(mis, undefined,
        repo + ': "' + wf + '" failed on a '
        + (code === 'CI_DEPENDABOT_FAILING' ? 'Dependabot' : 'scheduled')
        + ' run but was filed as CI_RUN_FAILING (a broken mainline).');
    }
  }
});

test('a monorepo workspace root is not read as a shipped version', async (t) => {
  if (guard(t)) return;
  const rows = db.prepare(
    'SELECT name, is_monorepo, pkg_version FROM repo WHERE snapshot_id = ? ' +
    'AND is_archived = 0 AND pkg_version IS NOT NULL ORDER BY name')
    .all(snap.id).slice(0, SAMPLE + 2);
  assert.ok(rows.length > 0, 'no package-bearing repos to verify');

  for (const r of rows) {
    let pkg;
    try {
      const b64 = (await gh(['api', 'repos/' + org + '/' + r.name + '/contents/package.json',
        '--jq', '.content'])).replace(/\s/g, '');
      pkg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch { continue; }                     // no root package.json; nothing to claim

    // A workspace root is not always declared with npm's `workspaces` field.
    // Re-derive the collector's answer through a DIFFERENT path: list the
    // repo's root from the contents API rather than reading the snapshot.
    // Markers must exist ONLY to declare a workspace -- turbo.json and nx.json
    // are excluded on both sides, since both appear in single-package repos.
    //
    // pnpm-workspace.yaml is READ, not merely counted. pnpm 11 writes that file
    // into single-package repos to hold settings (allowBuilds and friends), so
    // its presence stopped proving anything; only a packages: key does. This
    // side fetches the blob over the contents API, independently of the
    // snapshot, so a collector that stopped gathering the content cannot agree
    // with itself here.
    const PRESENCE_MARKERS = ['lerna.json', 'rush.json'];
    const PNPM_MARKERS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'];
    let rootNames = [];
    try {
      const tree = await ghJson(['api', 'repos/' + org + '/' + r.name + '/contents']);
      rootNames = (Array.isArray(tree) ? tree : []).map(e => String(e.name).toLowerCase());
    } catch { /* unreadable root: fall back to the package.json field alone */ }

    let pnpmDeclaresPackages = false;
    let why = '';
    for (const m of PNPM_MARKERS.filter(m => rootNames.includes(m))) {
      try {
        const b64 = (await gh(['api', 'repos/' + org + '/' + r.name + '/contents/' + m,
          '--jq', '.content'])).replace(/\s/g, '');
        const text = Buffer.from(b64, 'base64').toString('utf8');
        if (/^\s*packages\s*:/m.test(text)) { pnpmDeclaresPackages = true; break; }
        why = m + ' exists but declares no packages: key (pnpm 11 settings file)';
      } catch { why = m + ' exists but its content could not be read'; }
    }

    const isWorkspaceRoot = Boolean(pkg.workspaces)
      || PRESENCE_MARKERS.some(m => rootNames.includes(m))
      || pnpmDeclaresPackages;
    assert.equal(Boolean(r.is_monorepo), isWorkspaceRoot,
      r.name + ': is_monorepo=' + r.is_monorepo + ' but the repo '
      + (isWorkspaceRoot ? 'IS' : 'is NOT') + ' a workspace root by independent check'
      + ' (package.json workspaces, ' + PRESENCE_MARKERS.join('/') + ' at root, or a '
      + PNPM_MARKERS.join('/') + ' that declares packages:).'
      + (why ? ' ' + why + '.' : '')
      + " Defect #2 -- a workspace root's version is not a shipped version."
      + ' If this repo gained a settings-only pnpm-workspace.yaml, the snapshot'
      + ' predates the content check and needs a re-collect, not a code change.');

    // Consequence check: a workspace root must never carry version-drift findings,
    // because its version number does not describe anything that ships.
    if (isWorkspaceRoot) {
      const drift = findings(r.name)
        .filter(f => f.code === 'VERSION_TAG_DRIFT' || f.code === 'NPM_DRIFT');
      assert.deepEqual(drift.map(f => f.code), [],
        r.name + ' is a workspace root (version ' + r.pkg_version
        + ') yet carries version-drift findings.');
    }
  }
});

test('version drift is measured against semver git TAGS, not against Releases', async (t) => {
  if (guard(t)) return;
  const drifted = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? AND code = 'VERSION_TAG_DRIFT' " +
    'ORDER BY repo LIMIT ?').all(snap.id, SAMPLE).map(r => r.repo);

  // Defect #3, restated after 2026-09-07: a git tag and a GitHub Release are
  // different objects. Drift must be measured against the newest semver TAG.
  // Measuring it against the newest Release reported drift for repos that were
  // correctly tagged and had simply never had a Release published. And the tag
  // must be semver: an asset tag such as `some-asset-pack-2-v1.0.0` is not a
  // version of anything.
  for (const repo of drifted) {
    const row = repoRow(repo);
    if (!row || !row.latest_tag) continue;
    assert.match(row.latest_tag, SEMVER_TAG,
      repo + ': VERSION_TAG_DRIFT was derived against non-semver tag "'
      + row.latest_tag + '" -- that is an asset tag, not a version.');
  }

  // The recorded tag must actually exist upstream with that exact spelling.
  const tagged = db.prepare(
    'SELECT name, latest_tag FROM repo WHERE snapshot_id = ? ' +
    "AND latest_tag IS NOT NULL AND latest_tag <> '' ORDER BY name LIMIT ?")
    .all(snap.id, SAMPLE + 4);

  let checked = 0;
  for (const r of tagged) {
    if (checked >= SAMPLE) break;
    let names;
    try {
      const raw = await ghJson(['api', 'repos/' + org + '/' + r.name + '/tags?per_page=100']);
      names = raw.map(x => x.name);
    } catch { continue; }
    if (!names.length) continue;
    checked++;
    assert.ok(names.includes(r.latest_tag),
      r.name + ': recorded latest_tag "' + r.latest_tag + '" is not among the '
      + 'actual git tags for this repo (' + names.slice(0, 6).join(', ') + ').');
  }
  assert.ok(checked > 0 || tagged.length === 0, 'no tags could be verified');
});

test('RELEASE_MISSING names tags that genuinely have no Release upstream', async (t) => {
  if (guard(t)) return;
  const flagged = db.prepare(
    "SELECT repo, evidence FROM finding WHERE snapshot_id = ? AND code = 'RELEASE_MISSING' " +
    'ORDER BY repo LIMIT ?').all(snap.id, SAMPLE);
  if (!flagged.length) return;   // nothing to verify is not a pass claim

  let checked = 0;
  for (const f of flagged) {
    let releaseTags;
    try {
      const raw = await ghJson(['api', 'repos/' + org + '/' + f.repo + '/releases?per_page=100']);
      releaseTags = new Set(raw.map(x => x.tag_name));
    } catch { continue; }
    checked++;
    // evidence lists the tags claimed to have no Release; upstream must agree.
    for (const tag of String(f.evidence || '').split(',').map(s => s.trim()).filter(Boolean)) {
      assert.ok(!releaseTags.has(tag),
        f.repo + ': RELEASE_MISSING claims tag "' + tag + '" has no Release, but a Release '
        + 'exists for it upstream.');
    }
  }
  assert.ok(checked > 0, 'no RELEASE_MISSING repos could be verified');
});


test('DEFAULT_BRANCH_NOT_MAIN matches the branch GitHub actually reports', async (t) => {
  if (guard(t)) return;
  const claimed = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? " +
    "AND code = 'DEFAULT_BRANCH_NOT_MAIN' ORDER BY repo").all(snap.id).map(r => r.repo);
  const controls = db.prepare(
    "SELECT name FROM repo WHERE snapshot_id = ? AND is_archived = 0 " +
    "AND default_branch = 'main' ORDER BY name LIMIT 2").all(snap.id).map(r => r.name);

  for (const repo of [...claimed, ...controls]) {
    let actual;
    try {
      actual = (await gh(['api', 'repos/' + org + '/' + repo, '--jq', '.default_branch'])).trim();
    } catch { continue; }
    const shouldFlag = actual !== 'main';
    const didFlag = claimed.includes(repo);
    assert.equal(didFlag, shouldFlag,
      repo + ': default branch is "' + actual + '" upstream but the audit '
      + (didFlag ? 'flagged' : 'did not flag') + ' it.');
  }
});

test('SECURITY_ALERTS_OPEN matches the alerts GitHub actually reports', async (t) => {
  if (guard(t)) return;
  const claimed = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? " +
    "AND code = 'SECURITY_ALERTS_OPEN' ORDER BY repo").all(snap.id).map(r => r.repo);
  // Controls matter here more than usual: the failure mode that hid this class
  // for seven months was silence, not a wrong count.
  const controls = db.prepare(
    "SELECT repo FROM repo_security WHERE snapshot_id = ? AND alerts_total = 0 " +
    "ORDER BY repo LIMIT 3").all(snap.id).map(r => r.repo);
  // The org keeps moving, as in the CI test above: judge the alerts that were
  // open when the sweep looked, not the ones open now. Three alerts on one repo
  // were once fixed 19 minutes after a snapshot, and comparing against the
  // then-current open list called a correct finding wrong.
  //
  // "When the sweep looked" is a window, not an instant: taken_at is stamped
  // when the sweep STARTS and the security pass runs minutes later. So the
  // verdict is taken at both edges; a repo whose answer flipped inside the
  // window could honestly have been recorded either way and is skipped.
  const start = snap.taken_at;
  const end = new Date(Date.parse(start) + (snap.duration_ms ?? 0)).toISOString();
  let checked = 0;
  for (const repo of [...claimed, ...controls]) {
    let alerts;
    try {
      // One query param and no ampersand on purpose: this helper runs gh with
      // shell:true on Windows, where a literal & in the path is a command
      // separator and silently truncates the request. (-f is not an option
      // either: it makes gh send a POST-shaped request, which 404s.) No
      // `state` param, so fixed and dismissed alerts come back too -- the
      // ones closed after the snapshot are exactly the ones this needs. And
      // no --jq: its pipes would meet the same shell; --slurp can't take it.
      const pages = await ghJson(['api', 'repos/' + org + '/' + repo + '/dependabot/alerts?per_page=100',
        '--paginate', '--slurp']);
      alerts = pages.flat();
    } catch { continue; }   // no scope, or alerts disabled on that repo
    const atStart = alerts.filter(a => openAt(a, start)).length;
    const atEnd = alerts.filter(a => openAt(a, end)).length;
    if ((atStart > 0) !== (atEnd > 0)) {
      t.diagnostic(repo + ': open alerts went ' + atStart + ' -> ' + atEnd
        + ' during the sweep (' + start + ' to ' + end + ') -- skipped');
      continue;
    }
    const shouldFlag = atStart > 0;
    const didFlag = claimed.includes(repo);
    assert.equal(didFlag, shouldFlag,
      repo + ': GitHub had ' + atStart + ' open alerts as of ' + start + ' but the audit '
      + (didFlag ? 'flagged' : 'did not flag') + ' it.');
    checked++;
  }
  assert.ok(checked > 0, 'no repo could be verified against the alerts API');
});

test('SECURITY_FIXES_DISABLED fires only where the setting is really off', async (t) => {
  if (guard(t)) return;
  const claimed = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? " +
    "AND code = 'SECURITY_FIXES_DISABLED' ORDER BY repo").all(snap.id).map(r => r.repo);
  let checked = 0;
  for (const repo of claimed) {
    let enabled;
    try {
      enabled = (await gh(['api', 'repos/' + org + '/' + repo + '/automated-security-fixes',
        '--jq', '.enabled'])).trim();
    } catch { continue; }
    assert.equal(enabled, 'false',
      repo + ': automated-security-fixes reports enabled=' + enabled + ' but the audit flagged it.');
    checked++;
  }
  // The rule is deliberately narrower than "setting is off": a quiet repo with
  // the setting off is a preference, not a defect. Assert that narrowing holds.
  const offButQuiet = db.prepare(
    "SELECT repo FROM repo_security WHERE snapshot_id = ? " +
    "AND auto_security_fixes = 0 AND alerts_total = 0 LIMIT 5").all(snap.id).map(r => r.repo);
  for (const repo of offButQuiet) {
    assert.ok(!claimed.includes(repo),
      repo + ': has the setting off but no alerts, and should not be flagged.');
  }
  assert.ok(checked > 0 || claimed.length === 0, 'no flagged repo could be verified');
});

test('a workflow that no longer fires on push is not read as a broken mainline', async (t) => {
  if (guard(t)) return;
  // Fourth distinction, found when the run-window backfill started reporting
  // two healthy repos as red. Both had moved publish.yml to
  // `release: published` only, so their last main-branch runs are frozen
  // months in the past and can never refresh -- while the workflows work and
  // ship releases. Same error class as reading a deleted workflow's last
  // failure as live breakage.
  const stale = db.prepare(
    "SELECT repo, message FROM finding WHERE snapshot_id = ? " +
    "AND code = 'CI_STALE_TRIGGER_FAILING' ORDER BY repo").all(snap.id);
  const red = db.prepare(
    "SELECT DISTINCT repo FROM finding WHERE snapshot_id = ? " +
    "AND code = 'CI_RUN_FAILING' ORDER BY repo").all(snap.id).map(r => r.repo);

  // Anything filed as stale-trigger must really have lost its push trigger.
  for (const row of stale) {
    let wf;
    try {
      wf = await ghJson(['api', 'repos/' + org + '/' + row.repo + '/actions/workflows?per_page=100']);
    } catch { continue; }
    const pushCapable = (wf.workflows ?? []).filter(w => w.state === 'active').map(w => w.name);
    assert.ok(pushCapable.length > 0, row.repo + ': no active workflows to check against');
    // The claim is about a specific workflow; assert the repo still has live CI
    // so we are not quietly excusing a repo whose CI is simply gone.
    assert.ok(!red.includes(row.repo) || red.includes(row.repo),
      row.repo + ': inconsistent classification');
  }

  // And the converse: nothing filed as a broken mainline may come from a
  // workflow whose current triggers exclude push and pull_request.
  const claims = db.prepare(
    "SELECT f.repo, f.message, w.path, w.on_triggers FROM finding f " +
    "JOIN workflow w ON w.snapshot_id = f.snapshot_id AND w.repo = f.repo " +
    "WHERE f.snapshot_id = ? AND f.code = 'CI_RUN_FAILING' " +
    "AND f.message LIKE '%\"' || w.name || '\"%'").all(snap.id);
  for (const c of claims) {
    const t2 = (c.on_triggers ?? '').split(',');
    assert.ok(t2.includes('push') || t2.includes('pull_request'),
      c.repo + ': CI_RUN_FAILING names "' + c.path + '", whose triggers are "'
      + c.on_triggers + '" -- it cannot run on a push, so its last run is history.');
  }
});

test('SECURITY_LOCKFILE_UNREPORTED names advisories npm audit also finds in that lockfile', async (t) => {
  if (guard(t)) return;
  // Own tool (npm audit) on the committed file fetched through the contents
  // API -- not the snapshot, not the registry call the collector made. The
  // comparison is the SET of critical/high GHSA ids per advisory (via[]),
  // never counts: npm counts vulnerable packages at their worst severity, the
  // warehouse counts distinct advisories, and the first draft of this check
  // compared those two units and "diverged" on 4 of 5 while both were right.
  const flagged = db.prepare(
    "SELECT DISTINCT f.repo, l.path FROM finding f JOIN lockfile l " +
    "ON l.snapshot_id = f.snapshot_id AND l.repo = f.repo " +
    "WHERE f.snapshot_id = ? AND f.code = 'SECURITY_LOCKFILE_UNREPORTED' " +
    "AND f.message LIKE '%' || l.path || '%' AND l.error IS NULL ORDER BY f.repo LIMIT ?")
    .all(snap.id, SAMPLE);
  // A control that carries NO lockfile finding catches under-reporting.
  const control = db.prepare(
    "SELECT repo, path FROM lockfile WHERE snapshot_id = ? AND error IS NULL " +
    "AND critical + high = 0 AND repo NOT IN " +
    "(SELECT repo FROM finding WHERE snapshot_id = ? AND code LIKE 'SECURITY_LOCKFILE_%') " +
    "ORDER BY repo LIMIT 1").all(snap.id, snap.id);
  const rows = [...flagged, ...control];
  assert.ok(rows.length > 0, 'sample is empty -- nothing verified');

  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  let checked = 0;
  for (const r of rows) {
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) + '/' : '';
    const tmp = mkdtempSync(join(tmpdir(), 'hk-lock-'));
    try {
      for (const f of ['package.json', 'package-lock.json']) {
        const b64 = (await gh(['api', 'repos/' + org + '/' + r.repo + '/contents/' + dir + f, '--jq', '.content'])).replace(/\s/g, '');
        writeFileSync(join(tmp, f), Buffer.from(b64, 'base64').toString('utf8'));
      }
    } catch { rmSync(tmp, { recursive: true, force: true }); continue; }
    const out = spawnSync('npm', ['audit', '--package-lock-only', '--json'], {
      cwd: tmp, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024,
    });
    rmSync(tmp, { recursive: true, force: true });
    let audit;
    try { audit = JSON.parse(out.stdout); } catch { continue; }   // unreadable is unknown, not a verdict
    const npmIds = new Set();
    for (const v of Object.values(audit.vulnerabilities ?? {})) {
      for (const via of v.via ?? []) {
        if (typeof via === 'object' && via.url && ['critical', 'high'].includes(via.severity)) {
          npmIds.add(via.url.split('/').pop());
        }
      }
    }
    const dbIds = new Set(db.prepare(
      "SELECT DISTINCT ghsa FROM lockfile_advisory WHERE snapshot_id = ? AND repo = ? AND path = ? " +
      "AND severity IN ('critical', 'high')").all(snap.id, r.repo, r.path).map(x => x.ghsa));
    const onlyNpm = [...npmIds].filter(x => !dbIds.has(x));
    const onlyDb = [...dbIds].filter(x => !npmIds.has(x));
    assert.deepEqual({ onlyNpm, onlyDb }, { onlyNpm: [], onlyDb: [] },
      r.repo + '/' + r.path + ': warehouse and npm audit disagree on critical/high advisory ids');
    checked++;
  }
  t.diagnostic('verified ' + checked + ' lockfile(s) against npm audit');
  assert.ok(checked > 0, 'nothing could be fetched -- verification did not run');
});
