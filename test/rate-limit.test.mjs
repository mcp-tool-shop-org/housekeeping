// Rate-limit awareness in the gh transport.
//
// These exist because of a real incident on 2026-09-17: a sweep took a hard
// 403 "API rate limit exceeded" while `gh api rate_limit` reported core
// 5000/5000. Two lessons are encoded here as tests.
//
//   1. The secondary limit says "API rate limit exceeded" too, so message text
//      alone cannot tell you which limit you hit. Classification must be broad.
//   2. A throttled call must never be reducible to a value that reads like
//      data. The expensive failure is not the 403 -- it is a 403 that a caller
//      records as "absent", which inverts a finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksRateLimited, looksTransient, backoffMs, RateLimitError } from '../src/gh.mjs';

test('looksRateLimited matches every throttling shape GitHub actually returns', () => {
  const throttled = [
    // The exact text of the 2026-09-17 incident -- note it says nothing about
    // "secondary", which is why it cannot be distinguished by wording.
    'API rate limit exceeded for user ID 1234567.',
    'You have exceeded a secondary rate limit and have been temporarily blocked',
    'You have triggered an abuse detection mechanism',
    'HTTP 429: Too Many Requests',
    'rate limit',
  ];
  for (const t of throttled) {
    assert.equal(looksRateLimited(t), true, `should be treated as throttling: ${t}`);
  }
});

test('looksRateLimited does not swallow ordinary failures', () => {
  // Misclassifying these as throttling would make the transport retry a
  // permanent error four times and then report the wrong cause.
  const notThrottled = [
    '{"message":"Not Found","status":"404"}',
    '{"message":"Bad credentials","status":"401"}',
    '{"message":"Branch not protected","status":"403"}',
    'fatal: repository not found',
    '',
  ];
  for (const t of notThrottled) {
    assert.equal(looksRateLimited(t), false, `should NOT be treated as throttling: ${t}`);
  }
  assert.equal(looksRateLimited(null), false);
  assert.equal(looksRateLimited(undefined), false);
});

test('a 403 that is merely a permission denial is not retried as throttling', () => {
  // `branches/<b>/protection` answers 403 on private repos without the feature.
  // The collector relies on that being a fast, single, non-retried failure.
  assert.equal(
    looksRateLimited('Upgrade to GitHub Pro or make this repository public to enable this feature.'),
    false,
  );
});

test('backoffMs grows, stays jittered, and is capped', () => {
  for (let i = 0; i < 8; i++) {
    const v = backoffMs(i);
    assert.ok(v > 0, 'must be positive');
    assert.ok(v <= 60000, `must respect the cap, got ${v} at attempt ${i}`);
  }
  // Growth is probabilistic because of jitter, so compare medians over samples
  // rather than single draws -- a flaky test here would be worse than none.
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const early = median(Array.from({ length: 21 }, () => backoffMs(0)));
  const late = median(Array.from({ length: 21 }, () => backoffMs(4)));
  assert.ok(late > early, `attempt 4 should back off longer than attempt 0 (${late} vs ${early})`);
});

test('backoffMs jitters, so parallel workers do not retry in lockstep', () => {
  // Without jitter every throttled worker wakes at the same instant and trips
  // the secondary limit again immediately.
  const draws = new Set(Array.from({ length: 30 }, () => backoffMs(3)));
  assert.ok(draws.size > 1, 'backoff must not be deterministic');
});

test('RateLimitError carries the flag callers branch on', () => {
  // restStatus() checks `isRateLimit` to decide whether to rethrow instead of
  // returning null. If this flag is ever dropped, a throttled probe silently
  // becomes "endpoint reports disabled" -- the exact inversion these guard.
  const primary = new RateLimitError('primary', 3_600_000, 'core 0/5000');
  assert.equal(primary.isRateLimit, true);
  assert.equal(primary.kind, 'primary');
  assert.equal(primary.name, 'RateLimitError');
  assert.ok(primary instanceof Error);
  assert.match(primary.message, /primary/);

  const secondary = new RateLimitError('secondary', 0, 'gave up');
  assert.equal(secondary.isRateLimit, true);
  assert.equal(secondary.kind, 'secondary');
});

test('primary and secondary are distinguishable by the consumer', () => {
  // They need different responses: primary means wait for a clock that may be
  // an hour out (so surface it); secondary means back off seconds and retry.
  const p = new RateLimitError('primary', 3_600_000);
  const s = new RateLimitError('secondary', 0);
  assert.notEqual(p.kind, s.kind);
  assert.ok(p.waitMs > s.waitMs);
});

// 2026-09-30: two sweeps each died on a lone "gh: HTTP 502". A gateway error is
// retried; a 4xx that means something (404 absent, 401 auth) must not be, or a
// real answer gets papered over by retries.
test('looksTransient retries gateway errors and nothing that carries meaning', () => {
  for (const t of ['gh: HTTP 502', 'HTTP 503: Service Unavailable', 'gh: HTTP 504']) {
    assert.equal(looksTransient(t), true, `should retry: ${t}`);
  }
  for (const t of ['gh: HTTP 404', 'HTTP 401: Bad credentials', 'HTTP 500', 'HTTP 5020', '']) {
    assert.equal(looksTransient(t), false, `should not retry: ${t}`);
  }
});
