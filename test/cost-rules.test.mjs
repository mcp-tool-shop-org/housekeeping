// The ACTIONS_COST_* rules, exercised end to end against a fixture database.
//
// The pure arithmetic is covered in actions-cost.test.mjs. These tests exist
// for a different reason: a rule that has never been observed to fire, and one
// that fires on a repo it should have left alone, look identical in source. Each
// case below asserts BOTH directions -- the shape that must produce a finding
// and the neighbouring shape that must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');

/**
 * Build a one-snapshot warehouse. `runs` are [workflow, conclusion, minutes,
 * cost]; `jobs` are [runId, name, class, conclusion, minutes, cost].
 */
function fixture({ repo = 'r', isPrivate = 0, billing = [], runs = [], jobs = [], reconcile = 1 }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?,?)')
    .run(1, '2026-09-21T00:00:00Z', 'org', '1.1.0', 1, 1, 'test', null);
  const cols = db.prepare('PRAGMA table_info(repo)').all().map(c => c.name);
  const row = Object.fromEntries(cols.map(c => [c, null]));
  Object.assign(row, {
    snapshot_id: 1, name: repo, is_private: isPrivate, is_archived: 0, is_empty: 0,
    is_fork: 0, is_monorepo: 0, default_branch: 'main', workflow_count: 1,
    open_prs: 0, open_issues: 0, release_count: 1, topic_count: 1, description: 'x',
  });
  db.prepare(`INSERT INTO repo VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c]));

  const bill = db.prepare('INSERT INTO billing_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  let gross = 0, net = 0;
  for (const [sku, qty, rate, g, n] of billing) {
    bill.run(1, '2026-09-01', 'actions', sku, 'Minutes', qty, rate, g, g - n, n, repo);
    gross += g; net += n;
  }
  const rc = db.prepare(`INSERT INTO run_cost VALUES (${Array(17).fill('?').join(',')})`);
  let computed = 0;
  runs.forEach(([wf, concl, min, cost, at], i) => {
    rc.run(1, repo, i + 1, wf, 'x', 'push', concl, at ?? '2026-09-18T00:00:00Z',
      1, 1, min, min, 0, 0, 0, 0, cost);
    computed += cost;
  });
  const rj = db.prepare('INSERT INTO run_cost_job VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [runId, name, cls, concl, min, cost, ] of jobs) {
    rj.run(1, repo, runId, name, cls.toLowerCase(), cls, concl, min, cost);
  }
  db.prepare('INSERT INTO cost_reconciliation VALUES (?,?,?,?,?,?,?,?)')
    .run(1, repo, computed, gross, net, gross ? computed / gross : null, reconcile,
      reconcile ? 'within tolerance' : 'computed below billed');
  analyze(db, 1);
  return db.prepare('SELECT code, severity, message FROM finding WHERE snapshot_id=1').all();
}
const codes = f => f.map(x => x.code);

// --------------------------------------------------- failure vs cancelled ----

test('failure waste fires when failed runs dominate the spend', () => {
  // A measured shape: 41% of compute on runs that failed.
  const f = fixture({
    billing: [['Actions Linux', 1000, 0.006, 6.0, 0]],
    runs: [
      ['ci', 'success', 600, 3.6],
      ['ci', 'failure', 400, 2.4],
    ],
  });
  assert.ok(codes(f).includes('ACTIONS_COST_FAILURE_WASTE'));
  assert.match(f.find(x => x.code === 'ACTIONS_COST_FAILURE_WASTE').message, /40% of measured/);
});

test('cancelled runs alone never fire it - that is concurrency working', () => {
  // Another measured shape: 67% cancelled by `cancel-in-progress`, 12% failed.
  // An earlier draft counted both and would have filed against correct
  // behaviour while missing the repo above.
  const f = fixture({
    billing: [['Actions Linux', 1000, 0.006, 6.0, 0]],
    runs: [
      ['CI', 'success', 210, 1.26],
      ['CI', 'cancelled', 670, 4.02],
      ['CI', 'failure', 120, 0.72],
    ],
  });
  assert.ok(!codes(f).includes('ACTIONS_COST_FAILURE_WASTE'),
    '12% failure must not trip a rule about failure');
});

test('a small repo failing loudly is below the absolute floor', () => {
  // 100% failure but only 30 billable minutes. Percentage alone is noise on a
  // repo that barely runs CI.
  const f = fixture({
    billing: [['Actions Linux', 30, 0.006, 0.18, 0]],
    runs: [['ci', 'failure', 30, 0.18]],
  });
  assert.ok(!codes(f).includes('ACTIONS_COST_FAILURE_WASTE'));
});

// ------------------------------------------------------- expanded matrix ----

test('an oversized expanded matrix fires even though the YAML declares one job', () => {
  const jobs = [];
  let i = 0;
  for (const os of ['ubuntu', 'windows', 'macos']) {
    for (const node of [20, 22, 24]) {
      jobs.push([1, `test (${node}, ${os}-latest)`, os.toUpperCase(), 'success', 5, 0.03]);
      i++;
    }
  }
  const f = fixture({
    billing: [['Actions Linux', 500, 0.006, 3.0, 0]],
    runs: [['CI', 'success', 500, 3.0]],
    jobs,
  });
  const hit = f.find(x => x.code === 'ACTIONS_COST_MATRIX_EXPANDED');
  assert.ok(hit, `expected the rule to fire on ${i} cells`);
  assert.match(hit.message, /expands to 9 matrix cells/);
});

test('exactly six cells is at the cap, not over it', () => {
  const jobs = [];
  for (const os of ['ubuntu', 'windows']) {
    for (const node of [20, 22, 24]) {
      jobs.push([1, `test (${node}, ${os}-latest)`, os.toUpperCase(), 'success', 5, 0.03]);
    }
  }
  const f = fixture({
    billing: [['Actions Linux', 500, 0.006, 3.0, 0]],
    runs: [['CI', 'success', 500, 3.0]],
    jobs,
  });
  assert.ok(!codes(f).includes('ACTIONS_COST_MATRIX_EXPANDED'),
    'a matrix trimmed to the cap sits here and must be clean');
});

// ------------------------------------------------------- public vs private ----

test('a public repo is never billed, however much compute it burns', () => {
  // The whole org looks like this: metered at full price, discounted to zero.
  const f = fixture({
    isPrivate: 0,
    billing: [['Actions Linux', 4000, 0.006, 24.0, 0]],
    runs: [['ci', 'success', 4000, 24.0]],
  });
  assert.ok(!codes(f).includes('ACTIONS_COST_BILLED_PRIVATE'),
    '$24 gross on a public repo is compute, not a bill');
});

test('a private repo consuming the allowance does fire', () => {
  const f = fixture({
    isPrivate: 1,
    billing: [['Actions Linux', 2000, 0.006, 12.0, 0]],
    runs: [['ci', 'success', 2000, 12.0]],
  });
  const hit = f.find(x => x.code === 'ACTIONS_COST_BILLED_PRIVATE');
  assert.ok(hit);
  assert.equal(hit.severity, 'medium', 'nothing billed yet: allowance, not money');
});

test('a private repo past its allowance is escalated', () => {
  const f = fixture({
    isPrivate: 1,
    billing: [['Actions Linux', 2000, 0.006, 12.0, 4.5]],
    runs: [['ci', 'success', 2000, 12.0]],
  });
  assert.equal(f.find(x => x.code === 'ACTIONS_COST_BILLED_PRIVATE').severity, 'high');
});

// ------------------------------------------------------------ the gate ------

test('a repo whose numbers did not reconcile produces NO cost findings', () => {
  // Same shape as the firing failure-waste case, but the per-job sum disagreed
  // with the invoice. Silence is the required outcome: a cost claim built on a
  // partial window is worse than no claim.
  const f = fixture({
    billing: [['Actions Linux', 1000, 0.006, 6.0, 0]],
    runs: [
      ['ci', 'success', 600, 3.6],
      ['ci', 'failure', 400, 2.4],
    ],
    reconcile: 0,
  });
  assert.ok(!codes(f).some(c => c.startsWith('ACTIONS_COST_FAILURE')),
    'an unverified number must never become a finding');
});

test('estimated rates void trust even when the two sides agree', async () => {
  // Defence in depth for the 2026-09-21 defect. The two checks fail for
  // different reasons: the ratio catches a wrong SET of runs, the flag catches
  // a wrong RATE. A rate error smaller than the tolerance passes the ratio
  // check while being wrong everywhere, so the flag is not redundant. This
  // fixture is exactly that case -- the numbers agree and must still not be
  // trusted.
  const { reconcileRepos } = await import('../src/cost.mjs');
  const args = {
    billingItems: [{ product: 'actions', sku: 'Actions Linux', repo: 'r', gross: 6.0, net: 0 }],
    runs: [{ repo: 'r', cost_usd: 6.05 }],          // ~1.008x billed
    drilled: ['r'],
  };
  const measured = reconcileRepos({ ...args, ratesEstimated: false })[0];
  assert.ok(Math.abs(1 - measured.ratio) < 0.15, 'the two sides DO agree numerically');
  assert.equal(measured.trustworthy, 1);

  const estimated = reconcileRepos({ ...args, ratesEstimated: true })[0];
  assert.equal(estimated.ratio, measured.ratio, 'same numbers');
  assert.equal(estimated.trustworthy, 0, 'and still not trusted');
  assert.match(estimated.reason, /estimated/);
});

test('a drilled repo with no invoice line is never called agreement', async () => {
  const { reconcileRepos } = await import('../src/cost.mjs');
  const [row] = reconcileRepos({
    billingItems: [], runs: [{ repo: 'r', cost_usd: 5 }], drilled: ['r'],
  });
  assert.equal(row.trustworthy, 0);
  assert.equal(row.ratio, null);
});

test('a repo with no cost data at all is silent, not clean', () => {
  const f = fixture({ billing: [], runs: [], reconcile: 0 });
  assert.ok(!codes(f).some(c => c.startsWith('ACTIONS_COST_')));
});
