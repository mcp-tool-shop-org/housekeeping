// ATLAS_MAP_MISSING, ATLAS_CHECK_NOT_IN_CI and ATLAS_ENGINE_BEHIND against
// rules/atlas-map.md, each in both directions. The end-to-end cases load a
// small snapshot through the real loader into an in-memory warehouse; the
// pure cases pin the decision function the analyzer calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/load.mjs';
import { analyze, healthScores, atlasMapFindings, ATLAS_ENGINE_BEHIND_COUNTS } from '../src/analyze.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');
const lines = (...l) => l.join('\n');

const CI_WITH_CHECK = pin => lines(
  'on:',
  '  push: { branches: [main], paths: ["src/**"] }',
  '  pull_request: { paths: ["src/**"] }',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm test',
  `      - run: npx --yes @dogfood-lab/atlas${pin ? `@${pin}` : ''} check`,
);
const CI_PLAIN = lines('on: { push: { paths: ["src/**"] } }', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps: [{ run: npm test }]');
const WEEKLY_CHECK = lines('on: { schedule: [{ cron: "0 6 * * 1" }] }', 'jobs:', '  a:', '    runs-on: ubuntu-latest',
  '    steps: [{ run: "npx --yes @dogfood-lab/atlas@1.20.0 check" }]');

const FLEET = { version: '1.23.5', source: 'npm dist-tags latest' };
const MAP = { oid: 'b10b', byteSize: 1000 };

/** One repo through loadSnapshot and analyze; returns the atlas findings. */
function run({ files = [CI_WITH_CHECK('1.23.5')], atlasMap = MAP, engine = '1.23.5', fleet = FLEET,
  archived = false, scripts, noAtlasPass = false }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const repo = {
    name: 'repo-a', id: 'R_1', description: 'x', isPrivate: false, isArchived: archived, isEmpty: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', pushedAt: new Date().toISOString(),
    defaultBranchRef: { name: 'main' },
    wfTree: { entries: files.map((_, i) => ({ name: `w${i}.yml`, type: 'blob' })) },
    ...(scripts ? { pkg: { text: JSON.stringify({ name: 'repo-a', version: '1.0.0', scripts }) } } : {}),
  };
  if (atlasMap !== 'never-collected') repo.atlasMap = atlasMap;
  const snap = {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [repo],
    workflow_files: { 'repo-a': files.map((text, i) => ({ path: `.github/workflows/w${i}.yml`, name: `w${i}.yml`, text, byteSize: text.length })) },
    workflow_runs: [],
  };
  if (!noAtlasPass) {
    snap.atlas_maps = {
      ok: true, fleet_version: fleet,
      repos: atlasMap?.oid ? { 'repo-a': { blob: atlasMap.oid, size: atlasMap.byteSize, engine, commit: 'c', doors: [] } } : {},
    };
  }
  const sid = loadSnapshot(db, snap);
  analyze(db, sid);
  return {
    f: db.prepare("SELECT code, severity, category, message, evidence FROM finding WHERE code LIKE 'ATLAS_%' ORDER BY code").all(),
    db, sid,
  };
}
const codes = r => r.f.map(x => x.code);

// ------------------------------------------------------------- no map ----

test('a repo that runs workflows and has no map fires, medium, citing the rule', () => {
  const r = run({ files: [CI_PLAIN], atlasMap: null });
  assert.deepEqual(codes(r), ['ATLAS_MAP_MISSING']);
  assert.equal(r.f[0].severity, 'medium');
  assert.equal(r.f[0].category, 'atlas');
  assert.match(r.f[0].evidence, /rules\/atlas-map\.md: "Every repository that runs workflows keeps a committed Atlas map/);
});

test('a repo with its map is not missing one', () => {
  assert.ok(!codes(run({})).includes('ATLAS_MAP_MISSING'));
});

test('a repo that runs no workflows owes no map', () => {
  assert.deepEqual(codes(run({ files: [], atlasMap: null })), []);
});

test('an archived repo is exempt', () => {
  assert.deepEqual(codes(run({ files: [CI_PLAIN], atlasMap: null, archived: true })), []);
});

test('a snapshot that never looked for the map files nothing', () => {
  // Every snapshot before collector 1.3.0: no atlasMap key at all.
  assert.deepEqual(codes(run({ files: [CI_PLAIN], atlasMap: 'never-collected', noAtlasPass: true })), []);
});

// ----------------------------------------------------------- no check ----

test('a map with no atlas check in any workflow fires', () => {
  const r = run({ files: [CI_PLAIN] });
  assert.deepEqual(codes(r), ['ATLAS_CHECK_NOT_IN_CI']);
  assert.equal(r.f[0].severity, 'medium');
  assert.match(r.f[0].message, /no workflow runs `atlas check`/);
  assert.match(r.f[0].evidence, /push-triggered workflow/);
});

test('a pinned check in a push-triggered workflow satisfies the rule', () => {
  assert.deepEqual(codes(run({ files: [CI_WITH_CHECK('1.23.5')] })), []);
});

test('a check only in a scheduled workflow does not count', () => {
  const r = run({ files: [CI_PLAIN, WEEKLY_CHECK] });
  assert.ok(codes(r).includes('ATLAS_CHECK_NOT_IN_CI'));
  assert.match(r.f.find(x => x.code === 'ATLAS_CHECK_NOT_IN_CI').message, /runs only in \.github\/workflows\/w1\.yml/);
});

test('an unpinned check does not count: the rule forbids a floating engine', () => {
  const r = run({ files: [CI_WITH_CHECK(null)] });
  assert.deepEqual(codes(r), ['ATLAS_CHECK_NOT_IN_CI']);
  assert.match(r.f[0].message, /no pinned version/);
});

test('a check reached through an npm script is unknown, not missing', () => {
  const r = run({ files: [CI_PLAIN], scripts: { 'atlas:check': 'npx --yes @dogfood-lab/atlas@1.23.5 check' } });
  assert.ok(!codes(r).includes('ATLAS_CHECK_NOT_IN_CI'));
});

// ------------------------------------------------------- engine behind ----

test('a pin older than the fleet is reported as info, and costs no health points', () => {
  const r = run({ files: [CI_WITH_CHECK('1.20.0')], engine: null });
  assert.deepEqual(codes(r), ['ATLAS_ENGINE_BEHIND']);
  assert.equal(r.f[0].severity, 'info');
  assert.match(r.f[0].message, /CI pins 1\.20\.0; the fleet engine is 1\.23\.5\. Reported, not counted/);
  assert.match(r.f[0].evidence, /map engine not recorded \(before 1\.23\.0\)/);
  // Same repo on the current pin: the score must not move.
  const current = run({ files: [CI_WITH_CHECK('1.23.5')], engine: null });
  assert.equal(healthScores(r.db, r.sid)[0].score, healthScores(current.db, current.sid)[0].score);
});

test('a pin and a map at the fleet version are not behind', () => {
  assert.deepEqual(codes(run({ files: [CI_WITH_CHECK('1.23.5')], engine: '1.23.5' })), []);
});

test('a map made by an older engine is behind even when the pin is current', () => {
  const r = run({ files: [CI_WITH_CHECK('1.23.5')], engine: '1.23.0' });
  assert.deepEqual(codes(r), ['ATLAS_ENGINE_BEHIND']);
  assert.match(r.f[0].message, /the map was made by 1\.23\.0/);
});

test('with no fleet version to measure against, nothing is behind', () => {
  assert.deepEqual(codes(run({ files: [CI_WITH_CHECK('1.14.0')], fleet: { version: null, source: 'npm', error: 'http_503' } })), []);
});

test('the transition switch is off, and flipping it makes the finding count', () => {
  // rules/atlas-map.md, Transition: reported and not counted until the first
  // pin-bump wave lands. The flip is a one-line change; this pins what it does.
  assert.equal(ATLAS_ENGINE_BEHIND_COUNTS, false);
  const args = { hasMap: 1, workflows: [{ path: 'ci.yml', on_triggers: 'push', atlas_check: '1.20.0' }], fleetVersion: '1.23.5' };
  assert.equal(atlasMapFindings(args)[0].severity, 'info');
  const counted = atlasMapFindings({ ...args, engineCounts: true })[0];
  assert.equal(counted.severity, 'low');
  assert.doesNotMatch(counted.message, /not counted/);
});

test('atlasMapFindings: an unknown map state yields nothing at all', () => {
  const wf = [{ path: 'ci.yml', on_triggers: 'push', atlas_check: '' }];
  assert.deepEqual(atlasMapFindings({ hasMap: null, workflows: wf, fleetVersion: '1.23.5' }), []);
  assert.deepEqual(atlasMapFindings({ hasMap: undefined, workflows: wf }), []);
});
