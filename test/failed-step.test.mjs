// Where a red default-branch run broke, joined to the Atlas map (HK2).
//
// Three layers, each tested in both directions: the resolver that turns the
// Actions API's display names into an Atlas step reference (workflow-risks),
// the collector's choice of runs and steps (collect), and the sentence the CI
// findings gain (analyze), end to end through the real loader. Display names
// follow what the API returned for live runs on 2026-09-30: "Set up job" is
// step 1, an unnamed `uses:` step is "Run <uses as written>".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { resolveFailedStep, stepDisplayName } from '../src/workflow-risks.mjs';
import { failedStepTargets, failedJobs, collectFailedSteps, trimAtlasDoor } from '../src/collect.mjs';
import { loadSnapshot, failedStepRows } from '../src/load.mjs';
import { analyze, failedStepNote } from '../src/analyze.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');
const lines = (...l) => l.join('\n');

const PAGES = lines(
  'on: { push: { branches: [main], paths: ["site/**"] }, workflow_dispatch: {} }',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/setup-node@v4',
  '      - name: Install site dependencies',
  '        run: npm ci',
  '        working-directory: site',
  '      - run: |',
  '          npm run build',
  '          echo done',
  '  deploy:',
  '    needs: build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/deploy-pages@v4',
);
const doc = text => parse(text);

// ------------------------------------------------------------ the resolver --

test('a named step resolves to its name, an unnamed one to its index as a string', () => {
  assert.deepEqual(resolveFailedStep(doc(PAGES), 'build', 'Install site dependencies', 4),
    { job: 'build', step: 'Install site dependencies', index: 2, phase: 'main' });
  assert.deepEqual(resolveFailedStep(doc(PAGES), 'deploy', 'Run actions/deploy-pages@v4', 2),
    { job: 'deploy', step: '0', index: 0, phase: 'main' });
});

test('an unnamed script step displays as its first line', () => {
  assert.equal(stepDisplayName({ run: '\n  npm run build\n  echo done' }), 'Run npm run build');
  assert.deepEqual(resolveFailedStep(doc(PAGES), 'build', 'Run npm run build', 5),
    { job: 'build', step: '3', index: 3, phase: 'main' });
  assert.equal(resolveFailedStep(doc(PAGES), 'build', 'Run echo done', 5).step, undefined,
    'the second line is not the display name');
});

test('the runner\'s own steps are never pinned on a step of the workflow', () => {
  for (const s of ['Set up job', 'Complete job', 'Initialize containers']) {
    const r = resolveFailedStep(doc(PAGES), 'deploy', s, 1);
    assert.equal(r.job, 'deploy');
    assert.equal(r.step, undefined, s);
    assert.match(r.unresolved, /runner's own step/);
  }
});

test('a post step resolves to the uses step that owns it; a script step owns none', () => {
  assert.deepEqual(resolveFailedStep(doc(PAGES), 'build', 'Post Run actions/checkout@v4', 12),
    { job: 'build', step: '0', index: 0, phase: 'post' });
  assert.ok(resolveFailedStep(doc(PAGES), 'build', 'Post Run npm run build', 9).unresolved);
});

test('a matrix cell and a job name with an expression resolve to the job key', () => {
  const wf = doc(lines(
    'on: push', 'jobs:',
    '  test:',
    '    strategy: { matrix: { node: [20, 22] } }',
    '    runs-on: ubuntu-latest',
    '    steps: [{ name: "Test on ${{ matrix.node }}", run: npm test }]',
    '  lint:',
    '    name: Lint (${{ matrix.os }})',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: npm run lint }]',
  ));
  assert.deepEqual(resolveFailedStep(wf, 'test (22)', 'Test on 22', 2),
    { job: 'test', step: 'Test on ${{ matrix.node }}', index: 0, phase: 'main' },
    'the reference is the name as written, which is what Atlas records');
  assert.equal(resolveFailedStep(wf, 'Lint (ubuntu-latest)', 'Run npm run lint', 2).job, 'lint');
});

test('two identical steps are told apart by number only when nothing precedes them but "Set up job"', () => {
  const twice = container => doc(lines(
    'on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest',
    ...(container ? ['    container: node:22'] : []),
    '    steps:', '      - uses: actions/checkout@v4', '      - run: make', '      - uses: actions/checkout@v4',
  ));
  assert.equal(resolveFailedStep(twice(false), 'a', 'Run actions/checkout@v4', 4).step, '2');
  assert.match(resolveFailedStep(twice(true), 'a', 'Run actions/checkout@v4', 5).unresolved, /fits 2 steps/,
    'a container inserts its own steps, so the number no longer counts from 2');
  assert.match(resolveFailedStep(twice(false), 'a', 'Run actions/checkout@v4', null).unresolved, /fits 2 steps/);
});

test('a reusable-workflow call and an unknown job stay unresolved', () => {
  const wf = doc(lines('on: push', 'jobs:', '  release:', '    uses: ./.github/workflows/publish.yml'));
  const r = resolveFailedStep(wf, 'release / publish', 'Publish', 3);
  assert.equal(r.job, 'release');
  assert.match(r.unresolved, /reusable workflow/);
  assert.match(resolveFailedStep(doc(PAGES), 'renamed-job', 'Build', 3).unresolved, /no job of this file/);
  assert.match(resolveFailedStep(doc(PAGES), 'build', 'A step that was renamed', 3).unresolved, /no step of this job/);
});

// ------------------------------------------------------------- the collector --

const REPOS = [{ name: 'repo-a', defaultBranchRef: { name: 'main' } }];
const run = (over) => ({ repo: 'repo-a', path: '.github/workflows/pages.yml', branch: 'main', conclusion: 'failure', run_id: 1, ...over });

test('only the newest default-branch run of each file is a target, and only when it is red', () => {
  const runs = [
    run({ run_id: 3, conclusion: 'success' }),                     // newest pages run is green
    run({ run_id: 2 }),                                            // an older red one: history
    run({ run_id: 5, path: '.github/workflows/ci.yml', conclusion: 'timed_out' }),
    run({ run_id: 6, path: '.github/workflows/ci.yml', branch: 'feature' }),
    run({ run_id: 7, path: 'dynamic/dependabot/dependabot-updates' }),
  ];
  assert.deepEqual(failedStepTargets(runs, REPOS).map(x => x.run_id), [5]);
  assert.deepEqual(failedStepTargets([run({})], REPOS).map(x => x.run_id), [1]);
  assert.deepEqual(failedStepTargets([run({})], [{ name: 'repo-a' }]), [], 'no default branch, no claim');
});

test('failed jobs keep their red steps; a timed-out job keeps the step it was cancelled in', () => {
  const api = [
    { name: 'ok', conclusion: 'success', steps: [{ number: 1, name: 'Set up job', conclusion: 'success' }] },
    { name: 'broke', conclusion: 'failure', steps: [
      { number: 2, name: 'Build', conclusion: 'failure' }, { number: 3, name: 'Upload', conclusion: 'skipped' }] },
    { name: 'slow', conclusion: 'timed_out', steps: [
      { number: 2, name: 'Test', conclusion: 'cancelled' }, { number: 3, name: 'Report', conclusion: 'cancelled' }] },
  ];
  assert.deepEqual(failedJobs(api), [
    { name: 'broke', conclusion: 'failure', steps: [{ number: 2, name: 'Build', conclusion: 'failure' }] },
    { name: 'slow', conclusion: 'timed_out', steps: [{ number: 2, name: 'Test', conclusion: 'cancelled' }] },
  ]);
});

test('the pass asks for the last attempt of each target and records a failed read as an error', async () => {
  const asked = [];
  const get = async p => {
    asked.push(p);
    if (p.includes('/runs/9/')) throw new Error('HTTP 502');
    return { jobs: [{ name: 'deploy', conclusion: 'failure', steps: [{ number: 2, name: 'Run actions/deploy-pages@v4', conclusion: 'failure' }] }] };
  };
  const out = await collectFailedSteps('org', [run({ run_id: 8 }), run({ run_id: 9, path: '.github/workflows/ci.yml' })], REPOS, { get });
  assert.deepEqual(asked.sort(), [
    'repos/org/repo-a/actions/runs/8/jobs?filter=latest&per_page=100',
    'repos/org/repo-a/actions/runs/9/jobs?filter=latest&per_page=100',
  ]);
  assert.equal(out.runs.find(x => x.run_id === 8).jobs[0].steps[0].name, 'Run actions/deploy-pages@v4');
  assert.match(out.runs.find(x => x.run_id === 9).error, /502/);
});

test('an unread run yields no rows, and a vanished file says so instead of guessing', () => {
  assert.deepEqual(failedStepRows({ run_id: 1, error: 'HTTP 502' }, PAGES), []);
  const rec = { run_id: 1, jobs: [{ name: 'deploy', steps: [{ number: 2, name: 'Run actions/deploy-pages@v4' }] }] };
  assert.equal(failedStepRows(rec, PAGES)[0].step, '0');
  const gone = failedStepRows(rec, null)[0];
  assert.equal(gone.step, null);
  assert.match(gone.unresolved, /not on the default branch/);
  const outside = failedStepRows({ run_id: 1, jobs: [{ name: 'deploy', steps: [] }] }, PAGES)[0];
  assert.deepEqual([outside.job, outside.api_step, outside.unresolved], ['deploy', null, 'the job failed outside any step']);
});

test('a run with no jobs is told apart from a run whose jobs all passed', () => {
  // A run GitHub rejects before it starts has no jobs at all; a publish run of
  // this shape was measured on 2026-09-30, with the file path as its name.
  const none = failedStepRows({ run_id: 1, job_count: 0, jobs: [] }, PAGES);
  assert.equal(none.length, 1);
  assert.match(none[0].unresolved, /^no job ran/);
  assert.match(failedStepRows({ run_id: 1, job_count: 3, jobs: [] }, PAGES)[0].unresolved, /^no job failed/);
  assert.equal(failedStepNote({ steps: none }),
    'No job ran, which is how GitHub fails a run whose workflow file it cannot use.');
});

test('a trimmed door keeps `dir`, the key Atlas writes, and its unresolved checks', () => {
  const t = trimAtlasDoor({
    file: '.github/workflows/pages.yml',
    commands: [{ job: 'build', step: 'Install site dependencies', dir: 'site', programs: ['npm'] }],
    unresolvedChecks: [{ rule: 'D2', job: 'build', step: 'Install site dependencies', why: 'self-hosted' }],
  });
  assert.deepEqual(t.commands, [{ job: 'build', step: 'Install site dependencies', programs: ['npm'], dir: 'site' }]);
  assert.equal(t.unresolvedChecks[0].why, 'self-hosted');
});

// ---------------------------------------------------------------- the note --

const D2 = { rule: 'D2', job: 'build', step: 'Install site dependencies', tool: 'npm ci', lock: 'site/package-lock.json',
  platforms: ['linux-x64'], packages: ['esbuild', 'rollup', 'sharp', 'lightningcss'] };
const STEP = { api_job: 'build', api_step: 'Install site dependencies', job: 'build', step: 'Install site dependencies' };
const CMDS = [{ job: 'build', step: 'Install site dependencies', programs: 'npm', directory: 'site' }];

test('the note names the step, the command it ran, and a door finding at that step', () => {
  const n = failedStepNote({ steps: [STEP], commands: CMDS, doorFindings: [D2] });
  assert.equal(n, 'It broke at job "build", step "Install site dependencies" (runs npm in site/). '
    + 'The Atlas map flagged that step before it ran: D2: npm ci runs on linux-x64 from site/package-lock.json, '
    + "which lacks that platform's build of esbuild, rollup, sharp and 1 more.");
});

test('a door finding at a different step is not cited as the cause', () => {
  const n = failedStepNote({ steps: [{ ...STEP, api_step: 'Build', step: 'Build' }], commands: CMDS, doorFindings: [D2] });
  assert.equal(n, 'It broke at job "build", step "Build".');
});

test('an unresolved step is reported with its reason, and an unread run says nothing', () => {
  assert.equal(failedStepNote({ steps: [{ api_job: 'deploy', api_step: 'Set up job', job: 'deploy', step: null,
    unresolved: 'the runner\'s own step "Set up job", not one the workflow declares' }] }),
    'It broke at job "deploy", step "Set up job" (the runner\'s own step "Set up job", not one the workflow declares).');
  assert.equal(failedStepNote({ steps: [] }), '');
});

test('a job that no longer exists in the file keeps its reason; one that failed outside a step does not repeat it', () => {
  assert.equal(failedStepNote({ steps: [{ api_job: 'Code Quality', api_step: null, job: null, step: null,
    unresolved: 'no job of this file displays as that name; the workflow may have changed since the run' }] }),
    'It broke at job "Code Quality", outside any step (no job of this file displays as that name; the workflow may have changed since the run).');
  assert.equal(failedStepNote({ steps: [{ api_job: 'deploy', api_step: null, job: 'deploy', step: null,
    unresolved: 'the job failed outside any step' }] }),
    'It broke at job "deploy", outside any step.');
});

// ------------------------------------------------------------- end to end --

function sweep({ failedSteps, doors }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const snap = {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [{ name: 'repo-a', id: 'R_1', description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', pushedAt: new Date().toISOString(),
      defaultBranchRef: { name: 'main' }, atlasMap: { oid: 'b10b', byteSize: 1 },
      wfTree: { entries: [{ name: 'pages.yml', type: 'blob' }] } }],
    workflow_files: { 'repo-a': [{ path: '.github/workflows/pages.yml', name: 'pages.yml', text: PAGES, byteSize: PAGES.length }] },
    workflow_runs: [{ repo: 'repo-a', workflow_name: 'Pages', path: '.github/workflows/pages.yml', run_id: 41, run_number: 7,
      event: 'push', status: 'completed', conclusion: 'failure', branch: 'main',
      created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:05:00Z', url: 'https://example.invalid/run/41' }],
    atlas_maps: { ok: true, fleet_version: { version: '1.24.0' },
      repos: { 'repo-a': { blob: 'b10b', size: 1, engine: '1.24.0', commit: 'c', doors } } },
  };
  if (failedSteps) snap.failed_steps = { ok: true, runs: failedSteps };
  const sid = loadSnapshot(db, snap);
  analyze(db, sid, { metaRepos: [] });
  return db.prepare("SELECT message FROM finding WHERE code = 'CI_RUN_FAILING'").get()?.message;
}

const DOOR = trimAtlasDoor({
  file: '.github/workflows/pages.yml', name: 'Pages',
  commands: [{ job: 'build', step: 'Install site dependencies', dir: 'site', programs: ['npm'] }],
  findings: [D2],
});
const failedAt = step => [{ repo: 'repo-a', run_id: 41, path: '.github/workflows/pages.yml',
  jobs: [{ name: 'build', conclusion: 'failure', steps: [{ number: 4, name: step, conclusion: 'failure' }] }] }];

test('end to end: a red run that broke where the map predicted cites the prediction', () => {
  const m = sweep({ failedSteps: failedAt('Install site dependencies'), doors: [DOOR] });
  assert.match(m, /^Latest main run of "Pages" concluded failure \(push\)\. It broke at job "build", step "Install site dependencies" \(runs npm in site\/\)\./);
  assert.match(m, /The Atlas map flagged that step before it ran: D2: npm ci runs on linux-x64/);
});

test('end to end: a red run that broke elsewhere names the step and cites nothing', () => {
  const m = sweep({ failedSteps: failedAt('Run npm run build'), doors: [DOOR] });
  assert.equal(m, 'Latest main run of "Pages" concluded failure (push). It broke at job "build", step "Run npm run build".');
});

test('end to end: a snapshot from before the pass keeps the old message exactly', () => {
  assert.equal(sweep({ failedSteps: null, doors: [DOOR] }), 'Latest main run of "Pages" concluded failure (push).');
});
