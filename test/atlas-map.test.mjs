// The committed Atlas map, collected: what a trimmed record keeps, when the
// blob is fetched, and how the loader tells "no map" from "not collected".
//
// The door shape below is the one Atlas 1.23.5 writes: workflow doors with
// triggers, commands, sends and counts, plus the long per-file lists that the
// org view does not need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimAtlasDoor, trimAtlasMap, collectAtlasMaps, ATLAS_TRIM_VERSION } from '../src/collect.mjs';
import { hasAtlasMap, loadSnapshot } from '../src/load.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');

const DOOR = {
  checksCount: 0,
  commands: [
    { job: 'render', programs: ['npm'], step: '2', extra: 'dropped' },
    { job: 'render', programs: ['node'], step: '3' },
  ],
  elsewhere: [], file: '.github/workflows/atlas-render.yml',
  landings: Array.from({ length: 50 }, (_, i) => ({ file: `f${i}` })),
  mentions: [], name: 'Atlas render', permissions: ['contents:write'], pushes: false,
  reach: [{ boundary: 'scripts', depth: 0, files: 1 }], readers: [],
  runs: [{ job: 'render', path: 'scripts/atlas-render.mjs', runKind: 'executes' }],
  runsCount: 1, secrets: [],
  sends: { deploysPages: false, publishes: false, publishesTo: [] },
  stages: [], triggers: [{ cron: '0 6 * * 1', event: 'schedule' }, { event: 'workflow_dispatch' }],
  uses: ['actions/checkout'], usesWorkflowToken: true,
};

test('a trimmed door keeps its outline and drops the long lists', () => {
  const t = trimAtlasDoor(DOOR);
  assert.deepEqual(t, {
    file: '.github/workflows/atlas-render.yml', name: 'Atlas render',
    triggers: DOOR.triggers, sends: DOOR.sends,
    commands: [{ job: 'render', step: '2', programs: ['npm'] }, { job: 'render', step: '3', programs: ['node'] }],
    counts: { checksCount: 0, runsCount: 1 },
  });
  for (const gone of ['landings', 'reach', 'runs', 'readers', 'mentions', 'uses', 'permissions']) {
    assert.ok(!(gone in t), `${gone} is not kept`);
  }
});

test('jobs and findings are kept whole when a door carries them', () => {
  // Atlas 1.24.0 adds both; keeping them now is what spares the later slices
  // a collector change.
  const jobs = [{ id: 'deploy', runsOn: ['ubuntu-latest'], environment: 'github-pages' }];
  const findings = [{ rule: 'D1', job: 'deploy', step: '4', lines: [12, 14] }];
  const t = trimAtlasDoor({ ...DOOR, kind: 'workflow', jobs, findings });
  assert.equal(t.kind, 'workflow');
  assert.deepEqual(t.jobs, jobs);
  assert.deepEqual(t.findings, findings);
  assert.ok(!('jobs' in trimAtlasDoor(DOOR)), 'absent stays absent, not an empty list');
});

test('a map made before Atlas 1.23.0 has no engine, and the record says null', () => {
  const t = trimAtlasMap({ doors: [DOOR], generatedFrom: { commit: 'abc', tracked: 3 } });
  assert.equal(t.engine, null);
  assert.equal(t.commit, 'abc');
  assert.equal(t.doors.length, 1);
  assert.equal(trimAtlasMap({ engine: '1.23.5' }).engine, '1.23.5');
  assert.deepEqual(trimAtlasMap(null), { engine: null, commit: null, doors: [] });
});

// ------------------------------------------------------------------ the pass --

const MAP = { engine: '1.23.5', generatedFrom: { commit: 'c0ffee' }, doors: [DOOR] };
const blobOf = obj => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(obj)).toString('base64') });
const noFetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '1.23.5' } }) });

test('the blob is fetched only when its id is not cached, and never for an archived repo or a repo with no map', async () => {
  const asked = [];
  const get = async path => { asked.push(path); return blobOf(MAP); };
  const repos = [
    { name: 'fresh', atlasMap: { oid: 'aaa', byteSize: 100 } },
    { name: 'known', atlasMap: { oid: 'bbb', byteSize: 200 } },
    { name: 'none', atlasMap: null },
    { name: 'old', isArchived: true, atlasMap: { oid: 'ccc', byteSize: 300 } },
  ];
  const cache = { bbb: { trim: ATLAS_TRIM_VERSION, record: { engine: null, commit: 'x', doors: [] } } };
  const out = await collectAtlasMaps('org', repos, { get, fetchImpl: noFetch, cache, writeCache: false });
  assert.deepEqual(asked, ['repos/org/fresh/git/blobs/aaa']);
  assert.deepEqual(Object.keys(out.repos).sort(), ['fresh', 'known']);
  assert.equal(out.repos.fresh.engine, '1.23.5');
  assert.equal(out.repos.fresh.blob, 'aaa');
  assert.equal(out.repos.fresh.size, 100);
  assert.equal(out.repos.known.commit, 'x', 'served from the cache');
  assert.deepEqual(out.fleet_version, { version: '1.23.5', source: 'npm dist-tags latest' });
});

test('a record cached by an older trim is fetched again', async () => {
  const asked = [];
  const get = async path => { asked.push(path); return blobOf(MAP); };
  const cache = { aaa: { trim: ATLAS_TRIM_VERSION - 1, record: { engine: 'stale', doors: [] } } };
  const out = await collectAtlasMaps('org', [{ name: 'r', atlasMap: { oid: 'aaa' } }],
    { get, fetchImpl: noFetch, cache, writeCache: false });
  assert.equal(asked.length, 1);
  assert.equal(out.repos.r.engine, '1.23.5');
});

test('an unreadable map is recorded as present with an error, not as absent', async () => {
  const get = async () => ({ encoding: 'base64', content: Buffer.from('{not json').toString('base64') });
  const out = await collectAtlasMaps('org', [{ name: 'r', atlasMap: { oid: 'aaa', byteSize: 9 } }],
    { get, fetchImpl: noFetch, cache: {}, writeCache: false });
  assert.equal(out.repos.r.blob, 'aaa');
  assert.ok(out.repos.r.error);
  assert.ok(!('doors' in out.repos.r));
});

test('a registry failure leaves the fleet version unknown, not empty', async () => {
  const down = async () => ({ ok: false, status: 503 });
  const out = await collectAtlasMaps('org', [], { get: async () => null, fetchImpl: down, cache: {}, writeCache: false });
  assert.equal(out.fleet_version.version, null);
  assert.equal(out.fleet_version.error, 'http_503');
});

// ------------------------------------------------------------------ the load --

test('hasAtlasMap tells "no map" from "not collected"', () => {
  assert.equal(hasAtlasMap({ name: 'r' }), null, 'a snapshot before the field existed');
  assert.equal(hasAtlasMap({ atlasMap: null }), 0);
  assert.equal(hasAtlasMap({ atlasMap: { oid: 'aaa', byteSize: 1 } }), 1);
  assert.equal(hasAtlasMap({ atlasMap: {} }), null, 'the path is not a file');
});

function load(snapExtra, repoExtra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const snap = {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [{ name: 'r', id: 'R_1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      pushedAt: '2026-09-29T00:00:00Z', defaultBranchRef: { name: 'main' }, ...repoExtra }],
    workflow_files: {}, workflow_runs: [], ...snapExtra,
  };
  const sid = loadSnapshot(db, snap);
  return { db, sid };
}

test('a loaded map writes its record, its doors and each command', () => {
  const rec = { blob: 'aaa', size: 100, ...trimAtlasMap(MAP) };
  const { db } = load({ atlas_maps: { ok: true, fleet_version: { version: '1.23.5', source: 'npm dist-tags latest' }, repos: { r: rec } } },
    { atlasMap: { oid: 'aaa', byteSize: 100 } });
  assert.equal(db.prepare('SELECT has_atlas_map h FROM repo').get().h, 1);
  const m = db.prepare('SELECT * FROM atlas_map').get();
  assert.deepEqual([m.blob_sha, m.size_bytes, m.engine, m.generated_from, m.door_count, m.error],
    ['aaa', 100, '1.23.5', 'c0ffee', 1, null]);
  const cmds = db.prepare('SELECT door, job, step, programs FROM atlas_door_command ORDER BY step').all();
  assert.deepEqual(cmds.map(c => [c.door, c.job, c.step, c.programs]),
    [['Atlas render', 'render', '2', 'npm'], ['Atlas render', 'render', '3', 'node']]);
  const door = db.prepare('SELECT * FROM atlas_door').get();
  assert.deepEqual(JSON.parse(door.counts), { checksCount: 0, runsCount: 1 });
  assert.equal(door.jobs, null);
  assert.equal(db.prepare('SELECT version FROM atlas_fleet').get().version, '1.23.5');
});

test('a snapshot from before the pass loads, with every map fact unknown', () => {
  const { db } = load({});
  assert.equal(db.prepare('SELECT has_atlas_map h FROM repo').get().h, null);
  for (const t of ['atlas_map', 'atlas_door', 'atlas_door_command', 'atlas_fleet']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  }
});
