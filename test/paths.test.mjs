// Where housekeeping writes (src/paths.mjs), and the guard that keeps the
// private working repository from being published to npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workDir } from '../src/paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('HK_HOME wins over everything', () => {
  assert.equal(workDir({ env: { HK_HOME: 'somewhere' }, root: '/pkg', cwd: '/here', exists: () => true }), resolve('somewhere'));
});

test('a git checkout keeps writing into itself, as it always has', () => {
  const seen = [];
  const dir = workDir({ env: {}, root: '/pkg', cwd: '/here', exists: p => (seen.push(p), true) });
  assert.equal(dir, '/pkg');
  assert.equal(seen[0], join('/pkg', '.git'));
});

test('an installed package writes where it is run, never into node_modules', () => {
  assert.equal(workDir({ env: {}, root: '/x/node_modules/pkg-a', cwd: '/here', exists: () => false }), '/here');
});

test('the publish guard refuses the private working repository and allows the public tree', () => {
  const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.prepublishOnly;
  const code = script.match(/^node -e "(.*)"$/)?.[1]?.replace(/\\"/g, '"');
  assert.ok(code, 'prepublishOnly is a single `node -e` guard');
  const run = cwd => spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8' });
  const privateRepo = mkdtempSync(join(tmpdir(), 'hk-guard-'));
  mkdirSync(join(privateRepo, 'public'));
  writeFileSync(join(privateRepo, 'public', 'SHIP_GATE.md'), '');
  const refused = run(privateRepo);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing: this is the private working repository/);
  assert.equal(run(mkdtempSync(join(tmpdir(), 'hk-guard-'))).status, 0);
});
