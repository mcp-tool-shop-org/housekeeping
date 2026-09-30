// The settings a deploy depends on: what the collector asks, what the loader
// makes of each answer, and the workflow readers both of them lean on.
//
// The recurring hazard here is a status read as a verdict. `repos/{r}/pages`
// answers 404 when Pages is off -- and a 403 or a gateway error is not "off",
// it is "not known". Each case below pins which statuses mean something and
// that everything else stays NULL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { parseIncluded } from '../src/gh.mjs';
import { deployNeeds, collectDeploySettings } from '../src/collect.mjs';
import {
  pagesDeployJobs, jobEnvironment, filterMatches, pushAdmitsBranch, jobRunsOnDefaultBranch,
} from '../src/workflow-risks.mjs';
import { pagesEnabled, environmentPolicy, deploySettingsRows } from '../src/load.mjs';

const lines = (...l) => l.join('\n');

// ---------------------------------------------------------------- transport --

test('parseIncluded reads the status and the JSON body of a 200', () => {
  const text = lines('HTTP/2.0 200 OK', 'Content-Type: application/json', '',
    '{"build_type":"workflow","source":{"branch":"main"}}');
  assert.deepEqual(parseIncluded(text), {
    status: 200, body: { build_type: 'workflow', source: { branch: 'main' } },
  });
});

test('parseIncluded drops the trailing gh line after a 404 body', () => {
  const text = lines('HTTP/2.0 404 Not Found', 'X-A: b', '',
    '{"message":"Not Found","status":"404"}gh: Not Found (HTTP 404)');
  const r = parseIncluded(text);
  assert.equal(r.status, 404);
  assert.equal(r.body.message, 'Not Found');
});

test('parseIncluded with no HTTP answer is an unknown status, not a 404', () => {
  assert.deepEqual(parseIncluded('error connecting to api.github.com'), { status: null, body: null });
  assert.deepEqual(parseIncluded(''), { status: null, body: null });
});

// ----------------------------------------------------------- workflow reads --

const PAGES = lines(
  'name: Deploy site',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths: ["site/**"]',
  '  workflow_dispatch:',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/upload-pages-artifact@v3',
  '  deploy:',
  '    needs: build',
  '    environment:',
  '      name: github-pages',
  '      url: ${{ steps.deployment.outputs.page_url }}',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - id: deployment',
  '        uses: actions/deploy-pages@v4',
);

const RELEASE = lines(
  'on:',
  '  release:',
  '    types: [published]',
  '  workflow_dispatch:',
  'jobs:',
  '  publish:',
  '    environment: pypi',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: pypa/gh-action-pypi-publish@release/v1',
);

const doc = t => parse(t);
const entries = t => Object.entries(doc(t).jobs);

test('pagesDeployJobs names the job that uses actions/deploy-pages, not the one that uploads', () => {
  assert.deepEqual(pagesDeployJobs(entries(PAGES)), ['deploy']);
  assert.deepEqual(pagesDeployJobs(entries(RELEASE)), []);
});

test('pagesDeployJobs ignores a mention of deploy-pages outside a uses: key', () => {
  const t = lines('on: push', 'jobs:', '  x:', '    runs-on: ubuntu-latest', '    steps:',
    '      - run: echo "we used to call actions/deploy-pages@v4 here"');
  assert.deepEqual(pagesDeployJobs(entries(t)), []);
});

test('jobEnvironment reads both spellings and refuses an expression', () => {
  assert.equal(jobEnvironment({ environment: 'pypi' }), 'pypi');
  assert.equal(jobEnvironment({ environment: { name: 'github-pages', url: 'x' } }), 'github-pages');
  assert.equal(jobEnvironment({ environment: '${{ inputs.target }}' }), null);
  assert.equal(jobEnvironment({ environment: { name: 'prod-${{ matrix.region }}' } }), null);
  assert.equal(jobEnvironment({ 'runs-on': 'ubuntu-latest' }), null);
});

test('filterMatches: literal, star, and the syntax it declines to evaluate', () => {
  assert.equal(filterMatches(['main'], 'main'), 1);
  assert.equal(filterMatches(['master'], 'main'), 0);
  assert.equal(filterMatches(['ma*'], 'main'), 1);
  assert.equal(filterMatches(['release/*'], 'release/a/b'), 0, '* does not cross /');
  assert.equal(filterMatches(['release/**'], 'release/a/b'), 1);
  assert.equal(filterMatches(['!dev', 'dev*'], 'main'), null, 'negation depends on order');
  assert.equal(filterMatches(['[mM]ain'], 'main'), null);
  assert.equal(filterMatches(['[mM]ain', 'main'], 'main'), 1, 'an outright match still counts');
});

test('pushAdmitsBranch: a tags-only push never runs on a branch', () => {
  assert.equal(pushAdmitsBranch(null, 'main'), 1, 'bare push: every branch');
  assert.equal(pushAdmitsBranch({ paths: ['src/**'] }, 'main'), 1);
  assert.equal(pushAdmitsBranch({ branches: ['main'] }, 'main'), 1);
  assert.equal(pushAdmitsBranch({ branches: ['master'] }, 'main'), 0);
  assert.equal(pushAdmitsBranch({ tags: ['v*'] }, 'main'), 0);
  assert.equal(pushAdmitsBranch({ 'branches-ignore': ['main'] }, 'main'), 0);
  assert.equal(pushAdmitsBranch({ 'branches-ignore': ['dependabot/**'] }, 'main'), 1);
});

test('jobRunsOnDefaultBranch: the fleet pages door runs on main', () => {
  const d = doc(PAGES);
  assert.equal(jobRunsOnDefaultBranch(d, d.jobs.deploy, 'main'), 1);
});

test('jobRunsOnDefaultBranch: a release-only publish does not', () => {
  const d = doc(RELEASE);
  assert.equal(jobRunsOnDefaultBranch(d, d.jobs.publish, 'main'), 0,
    'release runs on a tag and dispatch on a chosen ref');
});

test('jobRunsOnDefaultBranch: schedule and workflow_run land on the default branch', () => {
  const d = doc(lines('on:', '  schedule: [{ cron: "0 6 * * 1" }]', 'jobs:', '  x: { environment: e }'));
  assert.equal(jobRunsOnDefaultBranch(d, d.jobs.x, 'main'), 1);
  const w = doc(lines('on:', '  workflow_run: { workflows: [CI], types: [completed] }', 'jobs:', '  x: { environment: e }'));
  assert.equal(jobRunsOnDefaultBranch(w, w.jobs.x, 'main'), 1);
});

test('jobRunsOnDefaultBranch reads the fleet\'s plain if: forms', () => {
  const on = lines('on:', '  push: { branches: [main] }', '  release: { types: [published] }');
  const withIf = cond => { const d = doc(lines(on, 'jobs:', '  x:', `    if: ${cond}`, '    environment: e')); return jobRunsOnDefaultBranch(d, d.jobs.x, 'main'); };
  assert.equal(withIf("github.ref == 'refs/heads/main'"), 1);
  assert.equal(withIf("github.event_name == 'push' && github.ref == 'refs/heads/main'"), 1);
  assert.equal(withIf("github.event_name != 'pull_request'"), 1);
  assert.equal(withIf("github.event_name == 'release'"), 0);
  assert.equal(withIf("github.ref == 'refs/heads/other'"), 0);
  // A fleet shape: one readable alternative that runs on main is enough.
  assert.equal(withIf("github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')"), 1);
});

test('jobRunsOnDefaultBranch answers unknown rather than guess at grouping or context', () => {
  const on = lines('on:', '  push: { branches: [main] }', '  workflow_run: { workflows: [R], types: [completed] }');
  const withIf = cond => { const d = doc(lines(on, 'jobs:', '  x:', `    if: "${cond}"`, '    environment: e')); return jobRunsOnDefaultBranch(d, d.jobs.x, 'main'); };
  assert.equal(withIf("${{ (github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success') }}"), null);
  assert.equal(withIf("github.event.repository.private == false && github.ref == 'refs/heads/main'"), null);
  assert.equal(jobRunsOnDefaultBranch(doc(PAGES), doc(PAGES).jobs.deploy, null), null, 'no default branch known');
});

test('deployNeeds: what a repo must be asked, from its workflow text', () => {
  const files = [{ text: PAGES }, { text: RELEASE }, { text: 'a: *broken' }];
  assert.deepEqual(deployNeeds(files), { pages: true, environments: ['github-pages', 'pypi'] });
  assert.deepEqual(deployNeeds([]), { pages: false, environments: [] });
  assert.deepEqual(deployNeeds([{ text: lines('on: push', 'jobs:', '  a: { environment: Prod }', '  b: { environment: prod }') }]),
    { pages: false, environments: ['Prod'] }, 'environment names are case-insensitive');
});

// ------------------------------------------------------------------ the pass --

/** A fake transport: path -> { status, body }; records every path asked. */
function fakeGet(answers) {
  const asked = [];
  const get = async path => {
    asked.push(path);
    const hit = Object.entries(answers).find(([k]) => path.endsWith(k) || path.includes(k + '?'));
    return hit ? hit[1] : { status: 500, body: null };
  };
  return { get, asked };
}
const repo = (name, extra = {}) => ({ name, isArchived: false, isEmpty: false, defaultBranchRef: { name: 'main' }, ...extra });

test('the pass asks only what a repo\'s workflows need, and skips archived repos', async () => {
  const { get, asked } = fakeGet({
    'a/pages': { status: 200, body: { build_type: 'workflow', source: { branch: 'main' } } },
    'a/environments': { status: 200, body: { total_count: 1, environments: [
      { name: 'github-pages', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    ] } },
    'a/environments/github-pages/deployment-branch-policies': { status: 200, body: { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] } },
  });
  const wf = new Map([
    ['a', [{ text: PAGES }]],
    ['quiet', [{ text: lines('on: push', 'jobs:', '  t: { runs-on: ubuntu-latest }') }]],
    ['old', [{ text: PAGES }]],
  ]);
  const out = await collectDeploySettings('org', [repo('a'), repo('quiet'), repo('old', { isArchived: true })], wf, { get });
  assert.deepEqual(asked.sort(), [
    'repos/org/a/environments/github-pages/deployment-branch-policies?per_page=100',
    'repos/org/a/environments?per_page=100',
    'repos/org/a/pages',
  ]);
  assert.equal(out.calls, 3);
  assert.deepEqual(Object.keys(out.repos), ['a']);
  assert.equal(out.repos.a.pages.build_type, 'workflow');
  assert.deepEqual(out.repos.a.environments.list[0].branch_policies.list, [{ name: 'main', type: 'branch' }]);
});

test('a protected-branches environment asks for the default branch\'s protection, and stops when it is known', async () => {
  const envs = { status: 200, body: { total_count: 1, environments: [
    { name: 'pypi', deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
  ] } };
  const wf = new Map([['b', [{ text: lines('on: { push: { branches: [main] } }', 'jobs:', '  p: { environment: pypi }') }]]]);

  const protectedMain = fakeGet({ 'b/environments': envs, 'b/branches/main': { status: 200, body: { protected: true } } });
  const one = await collectDeploySettings('org', [repo('b')], wf, { get: protectedMain.get });
  assert.equal(one.repos.b.default_branch.protected, true);
  assert.equal(protectedMain.asked.length, 2, 'protected: nothing more to ask');

  const bare = fakeGet({
    'b/environments': envs,
    'b/branches/main': { status: 200, body: { protected: false } },
    'b/branches': { status: 200, body: [{ name: 'release' }] },
    'b/rules/branches/main': { status: 200, body: [] },
  });
  const two = await collectDeploySettings('org', [repo('b')], wf, { get: bare.get });
  assert.deepEqual(two.repos.b.default_branch,
    { name: 'main', status: 200, protected: false, any_protected: true, ruleset_rules: 0 });
});

test('a failed call is stored as its status, never turned into a verdict', async () => {
  const { get } = fakeGet({ 'c/pages': { status: 403, body: { message: 'Forbidden' } } });
  const out = await collectDeploySettings('org', [repo('c')], new Map([['c', [{ text: PAGES }]]]), { get });
  assert.equal(out.repos.c.pages.status, 403);
  assert.equal(out.repos.c.pages.build_type, null);
  assert.equal(out.repos.c.environments.status, 500);
  assert.equal(out.repos.c.environments.list, null);
});

test('a thrown call (throttling) records the repo as errored and leaves it out', async () => {
  const get = async () => { throw new Error('GitHub secondary rate limit hit'); };
  const out = await collectDeploySettings('org', [repo('d')], new Map([['d', [{ text: PAGES }]]]), { get });
  assert.deepEqual(out.repos, {});
  assert.equal(out.errors[0].stage, 'deploy_settings');
});

// ------------------------------------------------------------------ the load --

test('only 200 and 404 are answers about Pages; everything else is unknown', () => {
  assert.equal(pagesEnabled(200), 1);
  assert.equal(pagesEnabled(404), 0);
  for (const s of [403, 500, 502, null, undefined]) assert.equal(pagesEnabled(s), null, String(s));
});

test('environmentPolicy maps GitHub\'s shape, and an odd shape is unknown', () => {
  assert.equal(environmentPolicy(null), 'all');
  assert.equal(environmentPolicy({ protected_branches: true, custom_branch_policies: false }), 'protected');
  assert.equal(environmentPolicy({ protected_branches: false, custom_branch_policies: true }), 'custom');
  assert.equal(environmentPolicy({ protected_branches: true, custom_branch_policies: true }), null);
  assert.equal(environmentPolicy(undefined), null);
});

test('deploySettingsRows: a truncated environment list is unknown, not a short list', () => {
  const rows = deploySettingsRows({ environments: { status: 200, total_count: 150, list: [
    { name: 'a', deployment_branch_policy: null },
  ] } });
  assert.equal(rows.row.environments_status, null);
  assert.deepEqual(rows.environments, []);
});

test('deploySettingsRows: unread and cut-short branch policies are marked unreadable', () => {
  const rows = deploySettingsRows({ environments: { status: 200, total_count: 3, list: [
    { name: 'all', deployment_branch_policy: null },
    { name: 'custom', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: { status: 200, total_count: 1, list: [{ name: 'main', type: 'branch' }, { name: 'v*', type: 'tag' }] } },
    { name: 'denied', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: { status: 403, total_count: null, list: null } },
  ] } });
  assert.deepEqual(rows.environments.map(e => [e.name, e.policy, e.branch_policies, e.policies_readable]), [
    ['all', 'all', null, null],
    ['custom', 'custom', 'branch:main\ntag:v*', 1],
    ['denied', 'custom', null, 0],
  ]);
});

test('deploySettingsRows: nothing asked is no row at all', () => {
  assert.equal(deploySettingsRows(undefined), null);
});
