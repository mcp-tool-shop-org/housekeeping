// The snapshot dedupe guard: don't write 9 MB that records zero drift.
//
// The decision is entirely in canonicalJson() and snapshotFingerprint(); the
// write path around them is four lines. These tests cover the decision, and
// each case is a way an earlier draft got it wrong or would have.
//
// Verified against real data on 2026-09-21: fingerprinting all 18 committed
// snapshots flags exactly one adjacent pair -- 2026-09-08T00-02-37 and
// 00-04-27, two of the ten sweeps taken inside two hours that day -- and leaves
// the other seventeen distinct. Over-eagerness is the failure that would lose
// history, so that second half matters as much as the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, snapshotFingerprint } from '../src/collect.mjs';

// ----------------------------------------------------------- canonical ----

test('key order does not change the serialisation', () => {
  // The reason this function exists. The lockfile pass fills an object keyed by
  // repo from pMap at concurrency 6, so keys land in COMPLETION order: two
  // sweeps of an unchanged org can serialise the same data differently. Hashing
  // raw JSON.stringify would call every sweep a change and the guard would
  // never fire even once.
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'raw stringify disagrees');
  assert.equal(canonicalJson(a), canonicalJson(b), 'canonical form agrees');
});

test('array order IS preserved, because it carries meaning here', () => {
  // Runs, findings and advisories are all ordered. Sorting arrays to make more
  // things compare equal would hide real drift -- the opposite of the point.
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test('undefined is handled the way JSON.stringify handles it', () => {
  // The fingerprint has to describe the bytes that actually get written.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test('nesting is canonicalised all the way down', () => {
  const a = { x: [{ q: 1, p: 2 }] };
  const b = { x: [{ p: 2, q: 1 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('primitives and null survive intact', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(0), '0');
  assert.equal(canonicalJson(''), '""');
  assert.equal(canonicalJson(false), 'false');
});

// --------------------------------------------------------- fingerprint ----

const base = () => ({
  taken_at: '2026-09-21T00:00:00Z',
  duration_ms: 1000,
  rate_limit_remaining: 4900,
  org: 'org',
  collector_version: '1.1.0',
  gh_login: 'someone',
  repo_count: 2,
  repos: [{ name: 'a', pushedAt: '2026-09-20T00:00:00Z' }, { name: 'b' }],
});

test('two sweeps of an unchanged org fingerprint identically', () => {
  const first = base();
  const second = { ...base(), taken_at: '2026-09-21T02:00:00Z', duration_ms: 987, rate_limit_remaining: 4321 };
  assert.equal(snapshotFingerprint(first), snapshotFingerprint(second));
});

test('anything the sweep actually observed changes the fingerprint', () => {
  const changed = base();
  changed.repos[0].pushedAt = '2026-09-21T09:00:00Z';
  assert.notEqual(snapshotFingerprint(base()), snapshotFingerprint(changed));
});

test('a different collector is a different observation, not a duplicate', () => {
  // Tempting to exclude alongside taken_at, and wrong. A collector change is
  // exactly when you want a fresh snapshot on disk: it is the evidence that the
  // new code sees what the old code saw.
  assert.notEqual(
    snapshotFingerprint(base()),
    snapshotFingerprint({ ...base(), collector_version: '1.2.0' }),
  );
});

test('a different token is a different observation too', () => {
  // Visibility is per-token. Two logins can sweep the same org and legitimately
  // see different repo sets, so gh_login stays inside the fingerprint.
  assert.notEqual(
    snapshotFingerprint(base()),
    snapshotFingerprint({ ...base(), gh_login: 'someone-else' }),
  );
});

test('an empty or missing snapshot does not throw', () => {
  assert.equal(typeof snapshotFingerprint({}), 'string');
  assert.equal(typeof snapshotFingerprint(undefined), 'string');
});

test('the fingerprint is stable across key insertion order at the top level', () => {
  const a = { taken_at: 'x', org: 'o', repos: [] };
  const b = { repos: [], org: 'o', taken_at: 'y' };
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
});
