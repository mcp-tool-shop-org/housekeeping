// pnpm-lock.yaml read into the same package map and dev-only list the npm
// path produces, so pnpm repositories reach the advisory audit. Checked on
// 2026-09-30 against `pnpm audit` on a real 9.0 lock: the same two advisories,
// one on a package reached from a production dependency (prod) and one only
// through a devDependency (dev).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { parsePnpmKey, pnpmPackageMap, readLockfile, lockfilePathsFromTree } from '../src/lockfile.mjs';

const lines = (...l) => l.join('\n');

// ------------------------------------------------------------------- keys --

test('each lockfile version\'s key spelling parses to a name and a registry version', () => {
  assert.deepEqual(parsePnpmKey('fast-uri@3.1.7'), { name: 'fast-uri', version: '3.1.7' });                 // 9.x
  assert.deepEqual(parsePnpmKey('@scope/pkg@2.0.0'), { name: '@scope/pkg', version: '2.0.0' });
  assert.deepEqual(parsePnpmKey('pkg-a@1.0.0(pkg-b@2.0.0)'), { name: 'pkg-a', version: '1.0.0' });         // peer suffix
  assert.deepEqual(parsePnpmKey('/pkg-a@1.0.0'), { name: 'pkg-a', version: '1.0.0' });                     // 6.x
  assert.deepEqual(parsePnpmKey('/@scope/pkg@2.0.0(pkg-b@1.0.0)'), { name: '@scope/pkg', version: '2.0.0' });
  assert.deepEqual(parsePnpmKey('/pkg-a/1.0.0'), { name: 'pkg-a', version: '1.0.0' });                     // 5.x
  assert.deepEqual(parsePnpmKey('/@scope/pkg/2.0.0_pkg-b@1.0.0'), { name: '@scope/pkg', version: '2.0.0' });
  assert.deepEqual(parsePnpmKey('pkg-a@1.0.0-rc.1'), { name: 'pkg-a', version: '1.0.0-rc.1' });
});

test('a key that is not a registry version is left out, as npm workspace links are', () => {
  for (const k of ['pkg-a@https://codeload.example.invalid/x/tar.gz/abc', 'pkg-a@file:../pkg-a', 'pkg-a@link:../pkg-a', '', 'pkg-a']) {
    assert.equal(parsePnpmKey(k), null, k);
  }
});

// ------------------------------------------------------------------- 9.x --

// A 9.0 lock: a root and a workspace importer. pkg-a is a production
// dependency with a child; pkg-t is a devDependency with its own child; the
// workspace links to the root through `link:` and adds a production dep.
const V9 = lines(
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      pkg-a: { specifier: ^8.0.0, version: 8.17.1 }',
  '    devDependencies:',
  "      pkg-t: { specifier: ^4.0.0, version: 4.21.0(pkg-p@2.0.0) }",
  '  packages/tool:',
  '    dependencies:',
  "      root-pkg: { specifier: 'workspace:*', version: 'link:../..' }",
  "      '@scope/pkg': { specifier: ^2.0.0, version: 2.0.0 }",
  'packages:',
  '  pkg-a@8.17.1: { resolution: { integrity: sha512-a } }',
  '  pkg-uri@3.1.7: { resolution: { integrity: sha512-b } }',
  '  pkg-t@4.21.0: { resolution: { integrity: sha512-c } }',
  '  pkg-p@2.0.0: { resolution: { integrity: sha512-d } }',
  '  pkg-bundler@0.27.7: { resolution: { integrity: sha512-e } }',
  "  '@scope/pkg@2.0.0': { resolution: { integrity: sha512-f } }",
  'snapshots:',
  '  pkg-a@8.17.1:',
  '    dependencies: { pkg-uri: 3.1.7 }',
  '  pkg-uri@3.1.7: {}',
  '  pkg-t@4.21.0(pkg-p@2.0.0):',
  '    dependencies: { pkg-bundler: 0.27.7, pkg-p: 2.0.0 }',
  '  pkg-p@2.0.0: {}',
  '  pkg-bundler@0.27.7: {}',
  "  '@scope/pkg@2.0.0': {}",
);

test('9.x: every package reachable from a production dependency ships; the rest is dev-only', () => {
  const r = readLockfile(V9, 'pnpm', parse);
  assert.equal(r.version, 9);
  assert.deepEqual(Object.keys(r.packages), ['@scope/pkg', 'pkg-a', 'pkg-bundler', 'pkg-p', 'pkg-t', 'pkg-uri']);
  assert.deepEqual(r.dev, ['pkg-bundler', 'pkg-p', 'pkg-t'],
    'a production dependency\'s child ships (pkg-uri); a devDependency\'s child does not (pkg-bundler); a workspace\'s production dependency ships (@scope/pkg)');
});

test('9.x: a package reached from both sides ships', () => {
  const both = V9.replace("  pkg-uri@3.1.7: {}", "  pkg-uri@3.1.7:\n    dependencies: { pkg-bundler: 0.27.7 }");
  assert.deepEqual(readLockfile(both, 'pnpm', parse).dev, ['pkg-p', 'pkg-t']);
});

test('9.x without snapshots calls nothing dev-only: the louder reading, not a guess', () => {
  const lock = parse(V9);
  delete lock.snapshots;
  assert.deepEqual(pnpmPackageMap(lock).dev, []);
});

// --------------------------------------------------------------- 6.x, 5.x --

test('6.x and 5.x read each package\'s own dev flag, as the npm path does', () => {
  const v6 = parse(lines(
    "lockfileVersion: '6.0'",
    'packages:',
    '  /pkg-a@1.0.0: { dev: false }',
    '  /pkg-t@2.0.0(pkg-a@1.0.0): { dev: true }',
    '  /pkg-t@2.1.0: { dev: false }',
  ));
  assert.deepEqual(pnpmPackageMap(v6), { packages: { 'pkg-a': ['1.0.0'], 'pkg-t': ['2.0.0', '2.1.0'] }, dev: [] },
    'a name with one production entry ships');
  const v5 = parse(lines('lockfileVersion: 5.4', 'packages:', '  /pkg-a/1.0.0: { dev: false }', '  /@scope/pkg/2.0.0_pkg-a@1.0.0: { dev: true }'));
  assert.deepEqual(pnpmPackageMap(v5), { packages: { '@scope/pkg': ['2.0.0'], 'pkg-a': ['1.0.0'] }, dev: ['@scope/pkg'] });
  assert.equal(readLockfile('lockfileVersion: 5.4\npackages: {}\n', 'pnpm', parse).version, 5.4);
});

// ------------------------------------------------------------ the boundary --

test('both kinds of lockfile are found in a tree, and a vendored one is not', () => {
  const found = lockfilePathsFromTree([
    { path: 'pnpm-lock.yaml', type: 'blob', sha: 'a', size: 1 },
    { path: 'site/package-lock.json', type: 'blob', sha: 'b', size: 2 },
    { path: 'vendor/node_modules/x/pnpm-lock.yaml', type: 'blob', sha: 'c' },
    { path: 'docs/pnpm-lock.yaml.bak', type: 'blob', sha: 'd' },
    { path: 'pnpm-workspace.yaml', type: 'blob', sha: 'e' },
  ]);
  assert.deepEqual(found.map(f => [f.path, f.kind]), [['pnpm-lock.yaml', 'pnpm'], ['site/package-lock.json', 'npm']]);
});

test('an unreadable lockfile throws, which the collector records as not measured', () => {
  assert.throws(() => readLockfile('just a string', 'pnpm', parse), /does not parse to a mapping/);
  assert.throws(() => readLockfile('{ not json', 'npm', parse));
});

test('an npm lockfile reads exactly as before', () => {
  const r = readLockfile(JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'repo-a' }, 'node_modules/pkg-a': { version: '1.0.0' }, 'node_modules/pkg-t': { version: '2.0.0', dev: true } } }), 'npm', parse);
  assert.deepEqual(r, { version: 3, packages: { 'pkg-a': ['1.0.0'], 'pkg-t': ['2.0.0'] }, dev: ['pkg-t'] });
});
