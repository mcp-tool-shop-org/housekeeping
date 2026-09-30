// Actions cost arithmetic: runner classification, billable minutes, and the
// price table.
//
// Split from collect.mjs because the two change for different reasons. This
// module changes when GitHub changes how it *bills* (rounding, runner classes,
// SKU names); collect.mjs changes when GitHub changes how it *reports*. Mixing
// them means a pricing fix has to be made inside a network path that cannot be
// unit-tested.
//
// Two facts drive every function here, both verified against live billing data
// on 2026-09-21:
//
//   1. GitHub bills per JOB, rounded UP to the whole minute, then multiplied by
//      the runner class rate. A run's billable minutes are therefore NOT its
//      wall-clock duration: six 10-second jobs bill 6 minutes, not 1. Measured:
//      one run billed 119 minutes across 9 jobs whose wall time summed to well
//      under 30.
//
//   2. Public repositories on standard runners are metered and then discounted
//      to zero. The usage API returns grossAmount == discountAmount and
//      netAmount == 0 for every such line. Gross is real compute; net is real
//      money. A rule that conflates them either invents a bill that does not
//      exist or hides waste because nobody is charged for it. Both are wrong,
//      so both numbers are carried separately all the way to the report.

/** Runner classes we can price. OTHER is deliberately unpriced -- see below. */
export const RUNNER_CLASSES = ['UBUNTU', 'WINDOWS', 'MACOS', 'SELF_HOSTED', 'OTHER'];

// GitHub's published list prices, used ONLY when the billing API is unreadable.
// The real rates come from ratesFromUsage(): an account can be billed 0.006 for
// Linux where the list price is 0.008, and a hardcoded table would then
// overstate every number by a third. The fallback exists so a missing billing scope
// degrades to "approximate" rather than "no cost data at all", and anything
// priced this way is flagged `estimated` for the whole pipeline.
export const FALLBACK_RATES = { UBUNTU: 0.008, WINDOWS: 0.016, MACOS: 0.08 };

// Zero-cost classes. Self-hosted runners bill nothing; OTHER is anything we
// could not identify, which must stay unpriced rather than be guessed at the
// Linux rate -- a larger runner costs several times standard and would be
// silently undercounted.
const UNPRICED = new Set(['SELF_HOSTED', 'OTHER']);

/**
 * Classify a job's `labels` into a billing class.
 *
 * Order matters. `runs-on: [self-hosted, linux, x64]` carries a `linux` label
 * and would otherwise be priced as a hosted Ubuntu runner -- billing a repo for
 * hardware it owns. Self-hosted is therefore checked first, unconditionally.
 *
 * Larger runners (`ubuntu-latest-4-core`, `windows-latest-8-core`, and
 * org-named custom labels) bill at their own rates under their own SKUs, which
 * this module does not know. They return OTHER so they are counted as jobs and
 * minutes but contribute no cost, and the reconciliation against the billing
 * API surfaces the gap instead of absorbing it.
 */
export function runnerClass(labels) {
  const list = (Array.isArray(labels) ? labels : [labels])
    .filter(Boolean).map(l => String(l).toLowerCase());
  if (!list.length) return 'OTHER';
  if (list.some(l => l === 'self-hosted')) return 'SELF_HOSTED';
  // A core-count suffix means a larger runner on a different SKU.
  if (list.some(l => /-\d+-core\b/.test(l))) return 'OTHER';
  if (list.some(l => /^macos/.test(l))) return 'MACOS';
  if (list.some(l => /^windows/.test(l))) return 'WINDOWS';
  if (list.some(l => /^ubuntu/.test(l))) return 'UBUNTU';
  return 'OTHER';
}

/**
 * Billable minutes for one job: wall time rounded UP to the whole minute.
 *
 * Returns 0 -- never null -- for a job that did not run. A skipped job carries
 * a null `started_at`, and a job cancelled before dispatch can report
 * completed_at <= started_at. Both are free, and both must be distinguishable
 * from "not measured", which is the absence of the row entirely.
 */
export function billableMinutes(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 0;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60000);
}

// Exact SKU spellings observed in the enhanced billing usage API. Matching is
// exact rather than by substring because "Actions Linux" and "Actions Linux
// 4-core" differ by a multiple, and a substring match would price the larger
// runner as standard.
const SKU_CLASS = new Map([
  ['actions linux', 'UBUNTU'],
  ['actions windows', 'WINDOWS'],
  ['actions macos', 'MACOS'],
  ['actions macos 3-core', 'MACOS'],
  ['actions macos 12-core', 'MACOS'],
]);

/**
 * Derive this account's actual per-minute rates from its own billing lines.
 *
 * Self-calibrating on purpose: rates vary by plan and change without notice, so
 * reading them back out of the invoice is the only way to stay correct without
 * a maintenance burden. Returns the rates it could establish plus the SKUs it
 * could not map, so an unrecognised runner class shows up in the report as a
 * named gap instead of vanishing into a wrong total.
 */
export function ratesFromUsage(items = []) {
  const seen = new Map();          // class -> Set(rate)
  const unmapped = new Set();
  for (const i of items) {
    if (i?.product !== 'actions') continue;
    const sku = String(i.sku ?? '').trim().toLowerCase();
    if (!sku || sku === 'actions storage') continue;
    const cls = SKU_CLASS.get(sku);
    if (!cls) { unmapped.add(String(i.sku)); continue; }
    // Both spellings on purpose. The billing API answers in camelCase, but
    // collect.mjs normalises to the snake_case shape the snapshot and the
    // `billing_usage` table use, and this function is handed BOTH: raw items
    // during collection, stored rows when re-deriving from a snapshot. Reading
    // only `pricePerUnit` silently found no rates at all on 2026-09-21 and fell
    // back to list prices, overstating every figure by up to 60% -- the run
    // logged "billing revealed no rates" and kept going. Matching one spelling
    // is the bug; matching both is the fix.
    const rate = i.price_per_unit ?? i.pricePerUnit;
    if (!(rate > 0)) continue;
    if (!seen.has(cls)) seen.set(cls, new Set());
    seen.get(cls).add(rate);
  }
  const rates = {};
  const ambiguous = [];
  for (const [cls, set] of seen) {
    const vals = [...set];
    // Two rates for one class means a SKU split we do not model (e.g. both a
    // 3-core and a 12-core macOS line). Take the dearest so an estimate errs
    // toward over-reporting cost, and say so rather than picking silently.
    if (vals.length > 1) ambiguous.push(`${cls}: ${vals.join(', ')}`);
    rates[cls] = Math.max(...vals);
  }
  return {
    rates,
    estimated: Object.keys(rates).length === 0,
    unmapped: [...unmapped],
    ambiguous,
  };
}

/** Rates with the fallback filled in for any class billing did not reveal. */
export function withFallback(rates = {}) {
  return { ...FALLBACK_RATES, ...rates };
}

/**
 * Price one run from its jobs.
 *
 * `jobs` are raw objects from GET /actions/runs/{id}/jobs. Returns per-class
 * minutes alongside the total so a caller can ask the question this whole
 * module exists for -- "few minutes, most of the cost?" -- without re-deriving
 * the split. `unpriced_minutes` is minutes we counted but could not price;
 * non-zero means the cost figure is a floor, not a total.
 */
export function priceRun(jobs = [], rates = FALLBACK_RATES) {
  const minutes = { UBUNTU: 0, WINDOWS: 0, MACOS: 0, SELF_HOSTED: 0, OTHER: 0 };
  let cost = 0, counted = 0;
  for (const j of jobs) {
    const m = billableMinutes(j?.started_at, j?.completed_at);
    if (m <= 0) continue;
    const cls = runnerClass(j?.labels ?? []);
    minutes[cls] += m;
    counted++;
    if (!UNPRICED.has(cls)) cost += m * (rates[cls] ?? 0);
  }
  const billable = minutes.UBUNTU + minutes.WINDOWS + minutes.MACOS;
  return {
    job_count: jobs.length,
    billed_job_count: counted,
    billable_minutes: billable,
    ubuntu_minutes: minutes.UBUNTU,
    windows_minutes: minutes.WINDOWS,
    macos_minutes: minutes.MACOS,
    self_hosted_minutes: minutes.SELF_HOSTED,
    unpriced_minutes: minutes.OTHER,
    cost_usd: Number(cost.toFixed(6)),
  };
}

/**
 * Compare computed attribution against what GitHub actually billed.
 *
 * This is the verifier for everything else in the pipeline. The per-job sum is
 * derived from a different endpoint than the invoice, so agreement is real
 * evidence and divergence is a real warning: it means the runs we priced are
 * not the runs that were billed (a truncated window, a deleted run, a runner
 * class we cannot price). Rules consult `trustworthy` before making any claim
 * about a repo's cost, because a confident number built on a partial sample is
 * exactly the failure this repo keeps catching.
 *
 * `tolerance` is fractional. 0.15 was chosen because same-window comparisons on
 * the five costliest repos of the first measured sweep landed within 2%, so
 * 15% is loose enough to absorb rounding and mid-sweep runs while still
 * catching a window that missed real spend.
 *
 * KNOWN DIVERGENCE, unexplained. On that sweep, 11 of 12 drilled repos landed
 * between 0.99 and 1.08 but one came back at 1.236 -- all Linux, no unpriced
 * or self-hosted minutes, so it is a minute count that is too high rather than
 * a wrong rate. The two worst ratios also had the shortest average jobs (1.51
 * and 1.33 min), which is what per-job round-up would do, but the correlation
 * is not clean -- a third repo averaged 1.6 min and reconciled at 1.010 -- so
 * rounding is a hypothesis, not a finding. Do NOT widen the tolerance to make
 * it fit. The gate is doing its job: a repo that does not reconcile is
 * excluded from every cost rule until someone works out where the minutes
 * come from.
 */
/**
 * Reconcile every drilled repo, producing the rows `cost_reconciliation` holds.
 *
 * Pure so the gate can be tested without a database.
 *
 * `ratesEstimated` voids trust on its own, independent of whether the two sides
 * agree. The two checks fail for different reasons and neither subsumes the
 * other: the ratio catches a wrong SET of runs, the flag catches a wrong RATE.
 * A rate error smaller than the tolerance would pass the ratio check while
 * being wrong everywhere, so the flag is not redundant. When this actually
 * happened on 2026-09-21 both fired -- list prices put every repo at 1.32-1.43x
 * its invoice -- but that was luck about the size of the error, not a property
 * of the check.
 */
export function reconcileRepos({ billingItems = [], runs = [], drilled = [], ratesEstimated = false } = {}) {
  const billed = new Map();
  for (const i of billingItems) {
    if (i.product !== 'actions' || i.sku === 'Actions storage' || !i.repo) continue;
    const cur = billed.get(i.repo) ?? { gross: 0, net: 0 };
    cur.gross += i.gross ?? 0;
    cur.net += i.net ?? 0;
    billed.set(i.repo, cur);
  }
  const computed = new Map();
  for (const r of runs) {
    computed.set(r.repo, (computed.get(r.repo) ?? 0) + (r.cost_usd ?? 0));
  }
  return drilled.map(repo => {
    const b = billed.get(repo) ?? { gross: 0, net: 0 };
    const c = computed.get(repo) ?? 0;
    const rec = reconcile(c, b.gross);
    return {
      repo,
      computed_usd: Number(c.toFixed(4)),
      billed_gross_usd: Number(b.gross.toFixed(4)),
      billed_net_usd: Number(b.net.toFixed(4)),
      ratio: rec.ratio,
      trustworthy: (rec.trustworthy && !ratesEstimated) ? 1 : 0,
      reason: ratesEstimated ? 'rates estimated from list prices - not measured' : rec.reason,
    };
  });
}

export function reconcile(computedUsd, billedGrossUsd, tolerance = 0.15) {
  const billed = Number(billedGrossUsd ?? 0);
  const computed = Number(computedUsd ?? 0);
  if (!(billed > 0)) {
    // No invoice line to check against. Never claim agreement we cannot show.
    return { ratio: null, delta_usd: null, trustworthy: false, reason: 'no billing line' };
  }
  const ratio = computed / billed;
  const ok = Math.abs(1 - ratio) <= tolerance;
  return {
    ratio: Number(ratio.toFixed(4)),
    delta_usd: Number((computed - billed).toFixed(4)),
    trustworthy: ok,
    reason: ok ? 'within tolerance'
      : ratio < 1 ? 'computed below billed - window misses runs that were charged'
        : 'computed above billed - double counting or a rate that is too high',
  };
}
