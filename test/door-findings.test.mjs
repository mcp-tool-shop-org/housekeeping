// Atlas door findings in the report, and the job environment taken from the
// map (HK3). Record shapes follow what Atlas 1.24.0 writes: a door's
// `findings` (D1, D1-python, D2), `unresolvedChecks` with a `why`, and
// `jobs[].environment` as `{ name }` or `{ unresolved }`. Measured on the two
// 1.24.0 maps available on 2026-09-30: the map and the workflow agreed on all
// 14 jobs' environments, and neither map had a door finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, inspectWorkflow } from '../src/load.mjs';
import { analyze, doorFindingRows, doorFindingSentence } from '../src/analyze.mjs';
import { buildReport } from '../src/report.mjs';
import { trimAtlasDoor } from '../src/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');
const lines = (...l) => l.join('\n');

const D1 = { rule: 'D1', job: 'test', step: 'Run tests', tool: 'vitest run', package: 'vitest', version: '5.0.0',
  requires: '^22.12.0 || ^24.0.0 || >=26.0.0', pins: ['20'], legs: 2 };
const D2 = { rule: 'D2', job: 'build', step: 'Install', tool: 'npm ci', lock: 'site/package-lock.json',
  platforms: ['linux-x64'], packages: ['esbuild', 'rollup', 'sharp', 'lightningcss'] };

// ---------------------------------------------------------------- sentences --

test('each door rule reads as one sentence built from its facts', () => {
  assert.equal(doorFindingSentence(D1), 'vitest 5.0.0 requires Node ^22.12.0 || ^24.0.0 || >=26.0.0, and the job pins 20');
  assert.equal(doorFindingSentence({ ...D1, refuses: true }),
    'vitest 5.0.0 requires Node ^22.12.0 || ^24.0.0 || >=26.0.0 and refuses to start below it, and the job pins 20');
  assert.match(doorFindingSentence({ ...D1, engineStrict: '.npmrc' }), /\(\.npmrc sets engine-strict, so the install itself refuses\)$/);
  assert.equal(doorFindingSentence({ rule: 'D1-python', manifest: 'pyproject.toml', requires: '>=3.11', pins: ['3.10'] }),
    'pyproject.toml requires Python >=3.11, and the job pins 3.10');
  assert.equal(doorFindingSentence(D2),
    "npm ci runs on linux-x64 from site/package-lock.json, which lacks that platform's build of esbuild, rollup, sharp and 1 more");
  assert.equal(doorFindingSentence({ rule: 'D9' }), null, 'an unknown rule is not described by guesswork');
});

// ----------------------------------------------------------- the population --

const map = (repo, engine, error = null) => ({ repo, engine, error });
const door = (repo, file, findings, unresolved) => ({
  repo, file, findings: findings ? JSON.stringify(findings) : null,
  unresolved_checks: unresolved ? JSON.stringify(unresolved) : null,
});

test('only maps made by 1.24.0 or later are measured; an older map is not measured, not clean', () => {
  const r = doorFindingRows(
    [map('repo-a', '1.24.0'), map('repo-b', '1.23.5'), map('repo-c', null), map('repo-d', '1.25.1'), map('repo-e', null, 'http 502')],
    [door('repo-a', '.github/workflows/ci.yml', [D1]),
     door('repo-b', '.github/workflows/ci.yml', [D2]),            // an old engine: never counted
     door('repo-d', '.github/workflows/pages.yml', [D2], [{ rule: 'D1', why: 'lts/*' }, { rule: 'D1', why: 'lts/*' }])]);
  assert.equal(r.measured, 2);
  assert.equal(r.mapped, 4, 'an unreadable map is neither measured nor mapped');
  assert.deepEqual(r.rows.map(x => [x.rule, x.repo, x.where]), [['D1', 'repo-a', 'test / Run tests'], ['D2', 'repo-d', 'build / Install']]);
  assert.deepEqual(r.unresolved, [{ why: 'D1: lts/*', count: 2 }]);
});

test('a measured fleet with no finding says so; an unmeasured one says nothing is measured', () => {
  const clean = doorFindingRows([map('repo-a', '1.24.0')], [door('repo-a', 'x.yml', [])]);
  assert.deepEqual([clean.measured, clean.rows.length], [1, 0]);
  assert.equal(doorFindingRows([map('repo-a', '1.23.5')], []).measured, 0);
});

// --------------------------------------------------------- the environment --

const DEPLOY = lines(
  'on: { push: { branches: [main] } }',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    environment: github-pages',
  '    steps: [{ uses: actions/deploy-pages@v4 }]',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    environment: { name: "${{ inputs.target }}" }',
  '    steps: [{ run: npm publish }]',
);

test('the map\'s environment is preferred where it names one, and the workflow\'s reading is kept beside it', () => {
  const atlas = new Map([['deploy', { name: 'pages-prod' }], ['publish', { unresolved: 'expression' }]]);
  const w = inspectWorkflow(DEPLOY, '.github/workflows/pages.yml', 'main', atlas);
  assert.deepEqual(w.environments.map(e => [e.job, e.environment, e.source, e.parsed]),
    [['deploy', 'pages-prod', 'atlas', 'github-pages']],
    'an unresolved map entry adds nothing; neither reader stores an expression name');
});

test('without a map entry the workflow\'s reading stands', () => {
  const w = inspectWorkflow(DEPLOY, '.github/workflows/pages.yml', 'main');
  assert.deepEqual(w.environments.map(e => [e.job, e.environment, e.source]), [['deploy', 'github-pages', 'workflow']]);
});

// ------------------------------------------------------------ end to end --

function sweep({ engine, doors }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const sid = loadSnapshot(db, {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [{ name: 'repo-a', id: 'R_1', description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', pushedAt: new Date().toISOString(),
      defaultBranchRef: { name: 'main' }, atlasMap: { oid: 'b10b', byteSize: 1 },
      wfTree: { entries: [{ name: 'pages.yml', type: 'blob' }] } }],
    workflow_files: { 'repo-a': [{ path: '.github/workflows/pages.yml', name: 'pages.yml', text: DEPLOY, byteSize: DEPLOY.length }] },
    workflow_runs: [],
    atlas_maps: { ok: true, fleet_version: { version: '1.24.0' },
      repos: { 'repo-a': { blob: 'b10b', size: 1, engine, commit: 'c', doors } } },
  });
  analyze(db, sid, { metaRepos: [] });
  return { db, sid, report: buildReport(db, sid) };
}
const pagesDoor = extra => trimAtlasDoor({ file: '.github/workflows/pages.yml', name: 'Pages', commands: [],
  jobs: [{ basis: 'declared', name: 'deploy', environment: { name: 'github-pages' } }], ...extra });

test('end to end: a 1.24.0 map\'s door finding reaches the report, with the environment taken from the map', () => {
  const { db, report } = sweep({ engine: '1.24.0', doors: [pagesDoor({ findings: [D2] })] });
  assert.match(report, /### Door findings/);
  assert.match(report, /1 of 1 readable maps are made by Atlas 1\.24\.0 or later/);
  assert.match(report, /\| repo-a \| \.github\/workflows\/pages\.yml \| D2 \| build \/ Install \| npm ci runs on linux-x64/);
  assert.match(report, /Job environments taken from the map: 1; all agree with the workflow's own reading\./);
  assert.deepEqual(db.prepare('SELECT source, environment, parsed FROM workflow_environment').get(),
    Object.assign(Object.create(null), { source: 'atlas', environment: 'github-pages', parsed: 'github-pages' }));
});

test('end to end: a map from before 1.24.0 is reported as not measured, and its findings are not shown', () => {
  const { report } = sweep({ engine: '1.23.5', doors: [pagesDoor({ findings: [D2] })] });
  assert.match(report, /_Not measured — no map is made by Atlas 1\.24\.0 or later/);
  assert.doesNotMatch(report, /\| D2 \|/);
});
