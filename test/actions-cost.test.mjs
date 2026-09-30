// Actions cost: runner classification, per-job billing arithmetic, rate
// derivation, reconciliation, and expanded-matrix width.
//
// Every case below is either a shape measured against an org's live billing
// data on 2026-09-21 or a false positive an earlier draft of this code
// produced. The three marked TRAP each looked completely plausible and would
// have shipped a confident, wrong number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runnerClass, billableMinutes, priceRun, ratesFromUsage, withFallback, reconcile,
  FALLBACK_RATES,
} from '../src/cost.mjs';
import { matrixWidths, jobBaseName } from '../src/analyze.mjs';

// --------------------------------------------------------- runner class ----

test('standard hosted runners map to their billing class', () => {
  assert.equal(runnerClass(['ubuntu-latest']), 'UBUNTU');
  assert.equal(runnerClass(['ubuntu-24.04']), 'UBUNTU');
  assert.equal(runnerClass(['windows-latest']), 'WINDOWS');
  assert.equal(runnerClass(['macos-latest']), 'MACOS');
  assert.equal(runnerClass(['macos-14']), 'MACOS');
});

test('TRAP: self-hosted wins over the OS label it also carries', () => {
  // `runs-on: [self-hosted, linux, x64]` is the common spelling. Matching on
  // the OS label first bills the org for hardware it owns.
  assert.equal(runnerClass(['self-hosted', 'linux', 'x64']), 'SELF_HOSTED');
  assert.equal(runnerClass(['self-hosted', 'macos']), 'SELF_HOSTED');
});

test('TRAP: a larger runner is not its standard namesake', () => {
  // `ubuntu-latest-4-core` bills under its own SKU at several times standard.
  // Pricing it as UBUNTU silently undercounts; OTHER leaves it unpriced and
  // lets the reconciliation surface the gap.
  assert.equal(runnerClass(['ubuntu-latest-4-core']), 'OTHER');
  assert.equal(runnerClass(['windows-latest-8-core']), 'OTHER');
});

test('an unknown or empty label is never guessed at the Linux rate', () => {
  assert.equal(runnerClass([]), 'OTHER');
  assert.equal(runnerClass(['some-org-custom-pool']), 'OTHER');
});

// ------------------------------------------------------ billable minutes ----

test('a job is rounded UP to the whole minute', () => {
  assert.equal(billableMinutes('2026-09-01T00:00:00Z', '2026-09-01T00:00:01Z'), 1);
  assert.equal(billableMinutes('2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z'), 1);
  assert.equal(billableMinutes('2026-09-01T00:00:00Z', '2026-09-01T00:01:01Z'), 2);
});

test('a job that never ran is free, not unmeasured', () => {
  assert.equal(billableMinutes(null, null), 0);
  assert.equal(billableMinutes('2026-09-01T00:00:00Z', null), 0);
  // Cancelled before dispatch can report completed_at <= started_at.
  assert.equal(billableMinutes('2026-09-01T00:01:00Z', '2026-09-01T00:00:00Z'), 0);
});

// -------------------------------------------------------------- pricing ----

test('TRAP: billing is per job, so short jobs cost more than wall time', () => {
  // The single fact that makes a run's cost differ from its duration. Six
  // 10-second jobs bill six minutes, not one. Measured on a real run: 119
  // billable minutes across 9 jobs of far less wall time.
  const jobs = Array.from({ length: 6 }, () => ({
    labels: ['ubuntu-latest'],
    started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:10Z',
  }));
  const p = priceRun(jobs, { UBUNTU: 0.006 });
  assert.equal(p.billable_minutes, 6);
  assert.equal(p.cost_usd, 0.036);
});

test('the OS multiplier can invert the ranking of minutes and cost', () => {
  // A measured shape: the fewest minutes of the five costliest repos, and the
  // fourth-largest bill, because macOS is ~10x Linux.
  const rates = { UBUNTU: 0.006, WINDOWS: 0.01, MACOS: 0.062 };
  const mac = priceRun([{
    labels: ['macos-latest'],
    started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:03:00Z',
  }], rates);
  const linux = priceRun([{
    labels: ['ubuntu-latest'],
    started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:20:00Z',
  }], rates);
  assert.ok(mac.billable_minutes < linux.billable_minutes, '3 min < 20 min');
  assert.ok(mac.cost_usd > linux.cost_usd, 'yet macOS costs more');
});

test('self-hosted minutes are counted but free, and never priced as hosted', () => {
  const p = priceRun([{
    labels: ['self-hosted', 'linux'],
    started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:10:00Z',
  }], FALLBACK_RATES);
  assert.equal(p.self_hosted_minutes, 10);
  assert.equal(p.billable_minutes, 0);
  assert.equal(p.cost_usd, 0);
});

test('unpriced minutes make the cost a floor and say so', () => {
  const p = priceRun([{
    labels: ['ubuntu-latest-4-core'],
    started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:05:00Z',
  }], FALLBACK_RATES);
  assert.equal(p.unpriced_minutes, 5);
  assert.equal(p.cost_usd, 0, 'never guessed');
  assert.equal(p.billable_minutes, 0);
});

test('skipped jobs contribute nothing but are still reported in job_count', () => {
  const p = priceRun([
    { labels: ['ubuntu-latest'], started_at: null, completed_at: null },
    {
      labels: ['ubuntu-latest'],
      started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:02:00Z',
    },
  ], { UBUNTU: 0.006 });
  assert.equal(p.job_count, 2);
  assert.equal(p.billed_job_count, 1);
  assert.equal(p.billable_minutes, 2);
});

// ------------------------------------------------------- rate derivation ----

test('rates are read out of the invoice, not hardcoded', () => {
  // This account is billed 0.006 for Linux where the published list price is
  // 0.008 -- a hardcoded table overstates every number by a third.
  const { rates, estimated } = ratesFromUsage([
    { product: 'actions', sku: 'Actions Linux', pricePerUnit: 0.006 },
    { product: 'actions', sku: 'Actions Windows', pricePerUnit: 0.01 },
    { product: 'actions', sku: 'Actions macOS 3-core', pricePerUnit: 0.062 },
  ]);
  assert.deepEqual(rates, { UBUNTU: 0.006, WINDOWS: 0.01, MACOS: 0.062 });
  assert.equal(estimated, false);
});

test('TRAP: rates are read under BOTH field spellings', () => {
  // A real defect, caught only by running the collector for real on 2026-09-21.
  // The billing API answers `pricePerUnit`; collect.mjs normalises to the
  // snake_case `price_per_unit` shape that the snapshot and the billing_usage
  // table use, then handed THAT to this function. Reading one spelling found no
  // rates at all, fell back to list prices, and overstated the sweep by up to
  // 60% while logging only a warning. Both shapes must work.
  const camel = ratesFromUsage([
    { product: 'actions', sku: 'Actions Linux', pricePerUnit: 0.006 },
  ]);
  const snake = ratesFromUsage([
    { product: 'actions', sku: 'Actions Linux', price_per_unit: 0.006 },
  ]);
  assert.deepEqual(camel.rates, { UBUNTU: 0.006 });
  assert.deepEqual(snake.rates, { UBUNTU: 0.006 });
  assert.equal(snake.estimated, false, 'the stored shape must not read as unpriced');
});

test('TRAP: a larger-runner SKU must not be matched as its standard one', () => {
  // Substring matching would price "Actions Linux 4-core" at the standard Linux
  // rate. Exact matching leaves it unmapped and visible.
  const { rates, unmapped } = ratesFromUsage([
    { product: 'actions', sku: 'Actions Linux', pricePerUnit: 0.006 },
    { product: 'actions', sku: 'Actions Linux 4-core', pricePerUnit: 0.024 },
  ]);
  assert.equal(rates.UBUNTU, 0.006);
  assert.deepEqual(unmapped, ['Actions Linux 4-core']);
});

test('storage and non-Actions products do not become runner rates', () => {
  const { rates, estimated } = ratesFromUsage([
    { product: 'actions', sku: 'Actions storage', pricePerUnit: 0.00033602 },
    { product: 'copilot', sku: 'Copilot Business', pricePerUnit: 19 },
  ]);
  assert.deepEqual(rates, {});
  assert.equal(estimated, true, 'no runner rate could be established');
});

test('an unreadable invoice degrades to list prices rather than to zero', () => {
  const r = withFallback(ratesFromUsage([]).rates);
  assert.deepEqual(r, FALLBACK_RATES);
});

// -------------------------------------------------------- reconciliation ----

test('close agreement is trustworthy; a big gap is not', () => {
  // The five costliest repos landed between 0.99 and 1.03 on 2026-09-21.
  assert.equal(reconcile(22.96, 22.98).trustworthy, true);
  assert.equal(reconcile(13.59, 13.27).trustworthy, true);
  assert.equal(reconcile(2.00, 20.00).trustworthy, false);
});

test('no invoice line means untrustworthy, never agreement', () => {
  // A repo we priced but that has no billing line cannot be confirmed. Claiming
  // agreement here is how a partial window becomes a confident wrong number.
  const r = reconcile(5, 0);
  assert.equal(r.trustworthy, false);
  assert.equal(r.ratio, null);
  assert.match(r.reason, /no billing line/);
});

test('an under-count and an over-count are reported as different problems', () => {
  assert.match(reconcile(5, 20).reason, /below billed/);
  assert.match(reconcile(20, 5).reason, /above billed/);
});

// --------------------------------------------------------- matrix width ----

test('jobBaseName strips the matrix cell', () => {
  assert.equal(jobBaseName('test (20, ubuntu-latest)'), 'test');
  assert.equal(jobBaseName('lint-and-test (3.11)'), 'lint-and-test');
  assert.equal(jobBaseName('build'), 'build');
});

test('an expanded matrix is counted in cells, not declared jobs', () => {
  // node [20,22,24] x os [ubuntu,windows] is ONE declared job.
  const rows = [];
  for (const node of [20, 22, 24]) {
    for (const os of ['ubuntu-latest', 'windows-latest']) {
      rows.push({
        repo: 'repo-a', workflow_name: 'CI',
        name: `test (${node}, ${os})`, conclusion: 'success',
        created_at: '2026-09-18T00:00:00Z',
      });
    }
  }
  const [w] = matrixWidths(rows);
  assert.equal(w.cells, 6);
  assert.equal(w.base, 'test');
});

test('TRAP: width comes from the newest run, so a fixed matrix stops being a finding', () => {
  // The repo ran 9 cells until its macOS removal landed and 6 after. A window
  // maximum reports 9 for as long as the window lasts and files a stale finding against
  // the repo that did the work.
  const rows = [];
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    for (const node of [20, 22, 24]) {
      rows.push({
        repo: 'repo-a', workflow_name: 'CI', name: `test (${node}, ${os})`,
        conclusion: 'success', created_at: '2026-09-07T00:00:00Z',
      });
    }
  }
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    for (const node of [20, 22, 24]) {
      rows.push({
        repo: 'repo-a', workflow_name: 'CI', name: `test (${node}, ${os})`,
        conclusion: 'success', created_at: '2026-09-18T00:00:00Z',
      });
    }
  }
  const [w] = matrixWidths(rows);
  assert.equal(w.cells, 6, 'the 9-cell history must not outlive the fix');
  assert.equal(w.at, '2026-09-18T00:00:00Z');
});

test('TRAP: a gated job collapses to one skipped check and must not read as narrow', () => {
  // `lint-and-test` is 3 cells on push, but the repo's scheduled canary
  // gates it off with `if: github.event_name != 'schedule'`. GitHub then emits
  // ONE unsuffixed skipped check, so reading the newest run alone reports 1.
  const rows = [
    ...['3.11', '3.12', '3.13'].map(v => ({
      repo: 'repo-b', workflow_name: 'CI', name: `lint-and-test (${v})`,
      conclusion: 'success', created_at: '2026-09-08T00:00:00Z',
    })),
    {
      repo: 'repo-b', workflow_name: 'CI', name: 'lint-and-test',
      conclusion: 'skipped', created_at: '2026-09-20T00:00:00Z',
    },
  ];
  const [w] = matrixWidths(rows);
  assert.equal(w.cells, 3, 'measured from the last run in which it truly ran');
  assert.equal(w.at, '2026-09-08T00:00:00Z');
});

test('jobs are tracked per workflow, so two workflows do not merge', () => {
  const rows = [
    { repo: 'r', workflow_name: 'CI', name: 'test (1)', conclusion: 'success', created_at: '2026-09-18T00:00:00Z' },
    { repo: 'r', workflow_name: 'CI', name: 'test (2)', conclusion: 'success', created_at: '2026-09-18T00:00:00Z' },
    { repo: 'r', workflow_name: 'Release', name: 'test (1)', conclusion: 'success', created_at: '2026-09-18T00:00:00Z' },
  ];
  const w = matrixWidths(rows).sort((a, b) => b.cells - a.cells);
  assert.equal(w.length, 2);
  assert.equal(w[0].cells, 2);
  assert.equal(w[1].cells, 1);
});
