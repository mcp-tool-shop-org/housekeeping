import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow } from '../src/load.mjs';

const wf = (yaml) => inspectWorkflow(yaml, '.github/workflows/ci.yml');

test('detects a fully compliant workflow', () => {
  const w = wf(`
name: CI
on:
  push:
    paths: ['src/**', '.github/workflows/**']
  workflow_dispatch:
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v4 }]
`);
  assert.equal(w.state, 'ok');
  assert.equal(w.has_paths_filter, 1);
  assert.equal(w.has_concurrency, 1);
  assert.equal(w.has_workflow_dispatch, 1);
  assert.equal(w.uses_macos, 0);
  assert.equal(w.job_count, 1);
  assert.equal(w.runners, 'ubuntu-latest');
});

test('flags an ungated push trigger', () => {
  const w = wf(`
on:
  push:
    branches: [main]
jobs:
  t: { runs-on: ubuntu-latest }
`);
  assert.equal(w.has_paths_filter, 0, 'branches filter is not a paths filter');
  assert.equal(w.has_concurrency, 0);
  assert.equal(w.has_workflow_dispatch, 0);
});

test('bare `on: push` counts as ungated', () => {
  const w = wf('on: push\njobs:\n  t: { runs-on: ubuntu-latest }\n');
  assert.equal(w.has_paths_filter, 0);
  assert.equal(w.on_triggers, 'push');
});

test('release-only workflows are not treated as ungated', () => {
  const w = wf(`
on:
  release:
    types: [published]
jobs:
  publish: { runs-on: ubuntu-latest }
`);
  assert.equal(w.has_paths_filter, 1, 'no push/PR trigger means nothing to gate');
  assert.equal(w.on_triggers, 'release');
});

test('resolves runners hidden behind a matrix', () => {
  const w = wf(`
on: { push: { paths: ['src/**'] } }
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
`);
  assert.equal(w.has_matrix, 1);
  assert.equal(w.uses_macos, 1);
  assert.equal(w.uses_windows, 1);
  assert.ok(w.runners.includes('macos-latest'));
});

test('detects schedule triggers', () => {
  const w = wf(`
on:
  schedule: [{ cron: '0 8 * * 1' }]
jobs:
  sync: { runs-on: ubuntu-latest }
`);
  assert.ok(w.on_triggers.includes('schedule'));
});

test('survives YAML that parses `on` as a boolean key', () => {
  // YAML 1.1 turns `on:` into true. The inspector must read either spelling.
  const w = inspectWorkflow('true:\n  push:\n    paths: [src/**]\njobs:\n  a: { runs-on: ubuntu-latest }\n', 'x.yml');
  assert.equal(w.has_paths_filter, 1);
});

test('reports unparseable YAML instead of throwing', () => {
  assert.equal(wf('a: *undefined_alias\n').state, 'parse_error');
});

test('a non-mapping document is a parse_error, not a crash', () => {
  assert.equal(wf('').state, 'parse_error');
  assert.equal(wf('just a scalar string').state, 'parse_error');
});

test('never throws on odd-but-tolerated YAML', () => {
  // The parser is lenient (tabs, unterminated quotes, stray keys all survive).
  // What matters is that inspection degrades to defaults rather than exploding.
  for (const bad of ['a: b\n\tc: d\n', 'name: "unterminated\njobs: {}\n', 'name: [unclosed\n  : :\n']) {
    const w = wf(bad);
    assert.equal(typeof w.state, 'string');
    assert.equal(typeof w.job_count, 'number');
  }
});

// --- statically decidable failures that only surface on a schedule ----------

test('flags a job that edits a workflow file and then pushes', () => {
  // GITHUB_TOKEN cannot modify anything under .github/workflows/ under any
  // permission setting -- there is no `workflows: write` scope. Such a job is
  // dead on arrival and only discovers it on its cron.
  const w = wf([
    'on: { schedule: [{ cron: "0 8 * * 1" }] }',
    'jobs:',
    '  bump:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: |',
    '          sed -i s/old/new/ .github/workflows/ci.yml',
    '          git commit -am bump',
    '          git push',
  ].join('\n'));
  assert.equal(w.edits_workflow_files, 1);
});

test('does not flag a job that merely reads a workflow path', () => {
  const w = wf([
    'on: { push: { paths: ["src/**"] } }',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: actionlint .github/workflows/ci.yml',
  ].join('\n'));
  assert.equal(w.edits_workflow_files, 0, 'reading is not writing');
});

test('flags gh pr create authenticated with the default token', () => {
  // Fails unless the org enables "Allow GitHub Actions to create and approve
  // pull requests", which is off by default.
  const w = wf([
    'on: { workflow_dispatch: }',
    'jobs:',
    '  propose:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: gh pr create --title x --body y',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  ].join('\n'));
  assert.equal(w.pr_create_default_token, 1);
});

test('does not flag gh pr create with a supplied PAT', () => {
  const w = wf([
    'on: { workflow_dispatch: }',
    'jobs:',
    '  propose:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: gh pr create --title x --body y',
    '        env:',
    '          GH_TOKEN: ${{ secrets.RELEASE_PAT }}',
  ].join('\n'));
  assert.equal(w.pr_create_default_token, 0);
});

test('inherits token env from the workflow and job level', () => {
  const w = wf([
    'on: { workflow_dispatch: }',
    'env:',
    '  GH_TOKEN: ${{ github.token }}',
    'jobs:',
    '  propose:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: gh pr create --fill',
  ].join('\n'));
  assert.equal(w.pr_create_default_token, 1, 'workflow-level env counts');
});

// ---- job_names -----------------------------------------------------------
// Feeds classifyRequiredChecks: it is how a required context whose job was
// DELETED is told from one whose job is alive and simply did not run. A wrong
// name here produces a confident "this gate is dead" about a working gate.

const jobNames = (yaml) => wf(yaml).job_names.split('\n').filter(Boolean).sort();

test('records job ids, which is the check name when a job has no name:', () => {
  // `test` with a node matrix publishes `test (22.x)` / `test (24.x)`,
  // so the id is the base name the classifier strips the cell off to reach.
  assert.deepEqual(jobNames([
    'on: { pull_request: }',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    strategy: { matrix: { node-version: [22.x, 24.x] } }',
    '  lint:',
    '    runs-on: ubuntu-latest',
  ].join('\n')), ['lint', 'test']);
});

test('records a literal name: alongside the id, since either can be required', () => {
  // Protection can require "pytest-xdist parallel path (Linux 3.12)" — the
  // job's name:, not its id `parallel-xdist`. Storing only ids would read that
  // context as unsatisfiable.
  assert.deepEqual(jobNames([
    'on: { pull_request: }',
    'jobs:',
    '  parallel-xdist:',
    '    name: pytest-xdist parallel path (Linux 3.12)',
    '    runs-on: ubuntu-latest',
  ].join('\n')), ['parallel-xdist', 'pytest-xdist parallel path (Linux 3.12)']);
});

test('drops a name: holding an expression rather than storing it half-resolved', () => {
  // For example `Python ${{ matrix.python-version }} on ${{ matrix.os }}`.
  // What GitHub finally calls that check is not knowable from the file, and a
  // template stored as a name would never match any real context. The id
  // survives; the unresolved template does not.
  const names = jobNames([
    'on: { pull_request: }',
    'jobs:',
    '  test:',
    '    name: Python ${{ matrix.python-version }} on ${{ matrix.os }}',
    '    runs-on: ${{ matrix.os }}',
    '    strategy: { matrix: { os: [ubuntu-latest], python-version: ["3.12"] } }',
  ].join('\n'));
  assert.deepEqual(names, ['test']);
});

test('a workflow with no jobs yields an empty list, not a phantom name', () => {
  assert.deepEqual(jobNames('on: { workflow_dispatch: }\n'), []);
});

test('a document that is not a mapping yields no job names', () => {
  // The `yaml` parser is lenient enough that most malformed workflows still
  // come back as an object; the branch that actually fires in practice is a
  // file whose top level is not a mapping at all.
  const w = wf('just a string');
  assert.equal(w.state, 'parse_error');
  assert.equal(w.job_names, '');
});

test('a jobs: block that is not a mapping yields no job names', () => {
  const w = wf('on: { pull_request: }\njobs:\n  - build\n  - test\n');
  assert.equal(w.job_names, '', 'a list of jobs has no ids to read');
});

// ---- deploy doors ----------------------------------------------------------
// Feed CI_PAGES_NOT_ENABLED and CI_ENVIRONMENT_EXCLUDES_DEFAULT. The job that
// deploys is the one with the deploy-pages step, not the one that uploads the
// artifact, and an environment is recorded with whether its job can run on the
// default branch -- the rule is only about jobs that can.

test('records the deploy-pages job and its environment on the fleet pages shape', () => {
  const w = inspectWorkflow([
    'on:',
    '  push: { branches: [main], paths: ["site/**"] }',
    '  workflow_dispatch:',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps: [{ uses: actions/upload-pages-artifact@v3 }]',
    '  deploy:',
    '    needs: build',
    '    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }',
    '    runs-on: ubuntu-latest',
    '    steps: [{ id: deployment, uses: actions/deploy-pages@v4 }]',
  ].join('\n'), '.github/workflows/pages.yml', 'main');
  assert.equal(w.pages_deploy_jobs, 'deploy');
  assert.deepEqual(w.environments, [{ job: 'deploy', environment: 'github-pages', runs_on_default: 1, source: 'workflow', parsed: 'github-pages' }]);
});

test('a release-only environment job is recorded as not running on the default branch', () => {
  const w = inspectWorkflow([
    'on: { release: { types: [published] }, workflow_dispatch: }',
    'jobs:',
    '  publish: { environment: pypi, runs-on: ubuntu-latest }',
  ].join('\n'), '.github/workflows/publish.yml', 'main');
  assert.equal(w.pages_deploy_jobs, '');
  assert.deepEqual(w.environments, [{ job: 'publish', environment: 'pypi', runs_on_default: 0, source: 'workflow', parsed: 'pypi' }]);
});

// ---- atlas check -----------------------------------------------------------
// Feeds ATLAS_CHECK_NOT_IN_CI and ATLAS_ENGINE_BEHIND. The pin is what the
// engine check compares, and a call without one is recorded as such.

test('records the pin of each atlas check a run step issues', () => {
  const w = wf([
    'on: { push: { paths: ["src/**"] } }',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
    '      - run: npx --yes @dogfood-lab/atlas@1.20.0 check',
    '  map:',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: "npx @dogfood-lab/atlas check --json" }]',
  ].join('\n'));
  assert.equal(w.atlas_check, '1.20.0\nunpinned');
});

test('an atlas command that is not check, or a mention outside run:, is not a check', () => {
  const w = wf([
    'on: { push: { paths: ["src/**"] } }',
    'jobs:',
    '  a:',
    '    name: runs @dogfood-lab/atlas@1.20.0 check',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: "npx --yes @dogfood-lab/atlas@1.20.0 map" }]',
  ].join('\n'));
  assert.equal(w.atlas_check, '');
});

test('an unparseable workflow records no deploy door', () => {
  const w = inspectWorkflow('just a string', '.github/workflows/x.yml', 'main');
  assert.equal(w.pages_deploy_jobs, '');
  assert.deepEqual(w.environments, []);
});
