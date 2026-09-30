// The lockfile audit exists because GitHub's alert count was a false negative
// across most of an org and nothing here could tell. These tests pin the
// parts that turn a lockfile into a finding, so the warehouse's own counter
// cannot quietly drift into the same silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packageMapFromLockfile, advisoriesFromBulk, countBySeverity,
  lockfilePathsFromTree, normaliseSeverity, devOnlyPackages,
} from '../src/lockfile.mjs';

const v3 = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'site', version: '0.0.1' },
    'node_modules/astro': { version: '7.2.0' },
    'node_modules/sharp': { version: '0.35.3' },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/a/node_modules/sharp': { version: '0.34.0' },   // nested duplicate
    'packages/theme': { link: true, resolved: 'packages/theme' }, // workspace link
    'node_modules/@scope/pkg': { version: '2.0.0' },
  },
};

test('v3 lockfile: names come from the last node_modules segment, root is skipped, links are skipped', () => {
  const m = packageMapFromLockfile(v3);
  assert.deepEqual(m, {
    '@scope/pkg': ['2.0.0'],
    a: ['1.0.0'],
    astro: ['7.2.0'],
    sharp: ['0.34.0', '0.35.3'],
  });
});

test('v1 lockfile: nested dependencies are walked', () => {
  const m = packageMapFromLockfile({
    lockfileVersion: 1,
    dependencies: {
      astro: { version: '5.17.0', dependencies: { sharp: { version: '0.34.0' } } },
    },
  });
  assert.deepEqual(m, { astro: ['5.17.0'], sharp: ['0.34.0'] });
});

test('an unparseable or empty lockfile yields an empty map, not a throw', () => {
  assert.deepEqual(packageMapFromLockfile(null), {});
  assert.deepEqual(packageMapFromLockfile({}), {});
  assert.deepEqual(packageMapFromLockfile({ packages: { '': {} } }), {});
});

test('the map is deterministic: same set of packages, same bytes', () => {
  const a = packageMapFromLockfile(v3);
  const shuffled = { lockfileVersion: 3, packages: Object.fromEntries(Object.entries(v3.packages).reverse()) };
  assert.equal(JSON.stringify(a), JSON.stringify(packageMapFromLockfile(shuffled)));
});

// Real shape from the registry on 2026-09-18 for {"astro":["7.2.0"]}.
const bulk = {
  astro: [
    { id: 1, url: 'https://github.com/advisories/GHSA-26w7-cxv4-gfx2', title: 'Astro: Remote code execution through AVIF image optimization', severity: 'critical', vulnerable_versions: '<7.2.8' },
    { id: 2, url: 'https://github.com/advisories/GHSA-376h-93r7-7g6f', title: 'Astro: Authorization bypass', severity: 'moderate', vulnerable_versions: '<=7.2.3' },
  ],
  'js-yaml': [
    { id: 3, url: 'https://github.com/advisories/GHSA-2883-xcg3-v3hh', title: 'js-yaml: maxTotalMergeKeys', severity: 'high', vulnerable_versions: '>=4.0.0 <4.3.2' },
  ],
};

test('bulk response flattens to one row per resolved version, with GHSA id and GitHub severity names', () => {
  const rows = advisoriesFromBulk({ astro: ['7.2.0'], 'js-yaml': ['4.3.1'] }, bulk);
  assert.equal(rows.length, 3);
  const rce = rows.find(r => r.ghsa === 'GHSA-26w7-cxv4-gfx2');
  assert.equal(rce.package, 'astro');
  assert.equal(rce.version, '7.2.0');
  assert.equal(rce.severity, 'critical');
  // npm's "moderate" must become GitHub's "medium", because the report and
  // repo_security already speak that dialect.
  assert.equal(rows.find(r => r.ghsa === 'GHSA-376h-93r7-7g6f').severity, 'medium');
});

test('a package the registry flags but the lockfile does not resolve produces no rows', () => {
  // The registry answers only for names it was sent, but defend anyway: a row
  // with no version would name an exposure that is not in the tree.
  assert.deepEqual(advisoriesFromBulk({ astro: ['7.2.0'] }, { 'left-pad': [{ url: 'x', severity: 'high' }] }), []);
});

test('severity counts are per distinct advisory, not per (advisory x version)', () => {
  // sharp at two vulnerable versions is ONE thing to fix.
  const rows = advisoriesFromBulk({ sharp: ['0.34.0', '0.35.3'] }, {
    sharp: [{ url: 'https://github.com/advisories/GHSA-rgj7-g3m4-5g8c', severity: 'high', vulnerable_versions: '<0.35.4' }],
  });
  assert.equal(rows.length, 2);
  // sharp carries no dev flag in this fixture, so it ships: prod_high follows high.
  assert.deepEqual(countBySeverity(rows), { critical: 0, high: 1, medium: 0, low: 0, prod_critical: 0, prod_high: 1 });
});

test('dev-only means dev on EVERY edge; one prod edge makes it prod', () => {
  // vitest is a test runner that never ships. sharp is pulled by astro (prod)
  // AND by a dev tool -- it ships, so it is prod. astro has no dev flag at all.
  const dev = devOnlyPackages({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/vitest': { version: '3.2.4', dev: true },
      'node_modules/@vitest/mocker': { version: '3.2.4', dev: true },
      'node_modules/astro': { version: '5.18.0' },
      'node_modules/sharp': { version: '0.34.0' },
      'node_modules/some-tool/node_modules/sharp': { version: '0.34.0', dev: true },
    },
  });
  assert.deepEqual(dev, ['@vitest/mocker', 'vitest']);
});

test('a critical in a dev-only package is counted, but not as PROD exposure', () => {
  const rows = advisoriesFromBulk(
    { vitest: ['3.2.4'], astro: ['5.18.0'] },
    {
      vitest: [{ url: 'https://github.com/advisories/GHSA-5xrq-8626-4rwp', severity: 'critical', vulnerable_versions: '<4.2.0' }],
      astro: [{ url: 'https://github.com/advisories/GHSA-26w7-cxv4-gfx2', severity: 'critical', vulnerable_versions: '<7.2.8' }],
    },
    ['vitest'],
  );
  assert.equal(rows.find(r => r.package === 'vitest').dev, true);
  assert.equal(rows.find(r => r.package === 'astro').dev, false);
  const c = countBySeverity(rows);
  assert.equal(c.critical, 2, 'both are real advisories in the tree');
  assert.equal(c.prod_critical, 1, 'only astro ships');
  assert.equal(c.prod_high, 0);
});

test('normaliseSeverity never returns a value the schema cannot count', () => {
  for (const s of ['critical', 'HIGH', 'moderate', 'medium', 'low', 'info', undefined, 42]) {
    assert.ok(['critical', 'high', 'medium', 'low', 'unknown'].includes(normaliseSeverity(s)), String(s));
  }
});

test('lockfile paths: root and nested, never inside a vendored node_modules', () => {
  const paths = lockfilePathsFromTree([
    { path: 'package-lock.json', type: 'blob', sha: 'a', size: 10 },
    { path: 'site/package-lock.json', type: 'blob', sha: 'b', size: 20 },
    { path: 'packages/kernel/site/package-lock.json', type: 'blob', sha: 'c' },
    { path: 'vendor/node_modules/x/package-lock.json', type: 'blob', sha: 'd' },
    { path: 'site', type: 'tree', sha: 'e' },
    { path: 'package.json', type: 'blob', sha: 'f' },
  ]).map(p => p.path);
  assert.deepEqual(paths, ['package-lock.json', 'site/package-lock.json', 'packages/kernel/site/package-lock.json']);
});
