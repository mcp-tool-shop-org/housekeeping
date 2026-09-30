// CI_PAGES_NOT_ENABLED and CI_ENVIRONMENT_EXCLUDES_DEFAULT, end to end: a small
// snapshot goes through the real loader into an in-memory warehouse, and the
// real analyzer runs over it.
//
// Every case is paired with its neighbour. A rule that has never been seen to
// fire, and one that fires on the repo it should have left alone, look the
// same in source; the only defence is asserting both directions. The shapes
// come from the fleet: Pages switched off under a deploy-pages workflow (whose
// deploy then failed "Ensure GitHub Pages has been enabled"), and a `release`
// environment that admits only `v*` tags, which is correct because the jobs
// that use it run on a release tag, never on main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/load.mjs';
import { analyze, deploymentPatternMatches, environmentAdmitsBranch } from '../src/analyze.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');
const lines = (...l) => l.join('\n');

const PAGES = lines(
  'on:',
  '  push: { branches: [main], paths: ["site/**"] }',
  '  workflow_dispatch:',
  'concurrency: { group: pages, cancel-in-progress: true }',
  'jobs:',
  '  deploy:',
  '    environment: { name: github-pages }',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/deploy-pages@v4',
);
const RELEASE = lines(
  'on:',
  '  release: { types: [published] }',
  '  workflow_dispatch:',
  'jobs:',
  '  pypi:',
  '    environment: release',
  '    runs-on: ubuntu-latest',
  '    steps: [{ run: echo publish }]',
);
const NIGHTLY = lines(
  'on:',
  '  schedule: [{ cron: "0 3 * * *" }]',
  'jobs:',
  '  ship:',
  '    environment: nightly',
  '    runs-on: ubuntu-latest',
  '    steps: [{ run: echo ship }]',
);

/**
 * One repo, loaded through loadSnapshot and analyzed. `deploy` is the repo's
 * record in `deploy_settings.repos`; omit it for a snapshot without the pass.
 */
function run({ files = [PAGES], deploy, withPass = true, branch = 'main' }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const snap = {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [{
      name: 'r', id: 'R_1', description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
      pushedAt: new Date().toISOString(), defaultBranchRef: { name: branch },
      wfTree: { entries: files.map((_, i) => ({ name: `w${i}.yml`, type: 'blob' })) },
    }],
    workflow_files: { r: files.map((text, i) => ({ path: `.github/workflows/w${i}.yml`, name: `w${i}.yml`, text, byteSize: text.length })) },
    workflow_runs: [],
  };
  if (withPass) snap.deploy_settings = { ok: true, calls: 0, repos: deploy === undefined ? {} : { r: deploy } };
  const sid = loadSnapshot(db, snap);
  analyze(db, sid);
  return db.prepare("SELECT code, severity, message, evidence FROM finding WHERE code LIKE 'CI_PAGES%' OR code LIKE 'CI_ENVIRONMENT%'").all();
}
const codes = f => f.map(x => x.code);
const env = (name, policy, branchPolicies) => ({
  name,
  deployment_branch_policy: policy === 'all' ? null
    : { protected_branches: policy === 'protected', custom_branch_policies: policy === 'custom' },
  ...(branchPolicies ? { branch_policies: { status: 200, total_count: branchPolicies.length,
    list: branchPolicies.map(p => { const [type, n] = p.split(':'); return { type, name: n }; }) } } : {}),
});
const envs = (...list) => ({ status: 200, total_count: list.length, list });
const PAGES_ON = { status: 200, build_type: 'workflow', source_branch: 'main' };

// ------------------------------------------------------------------ Pages ---

test('Pages off under a deploy-pages workflow fires, high, citing the rule', () => {
  const f = run({ deploy: { pages: { status: 404, build_type: null, source_branch: null } } });
  assert.deepEqual(codes(f), ['CI_PAGES_NOT_ENABLED']);
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].evidence, /repos\/<repo>\/pages: 404/);
  assert.match(f[0].evidence, /\.github\/workflows\/w0\.yml \(deploy\)/);
  assert.match(f[0].evidence, /shipcheck-product-standards\.md: "Never leave a repo with failing CI"/);
});

test('Pages on is silent', () => {
  assert.deepEqual(codes(run({ deploy: { pages: PAGES_ON } })), []);
});

test('a status the rule cannot interpret is silent: 403 and a gateway error are not "off"', () => {
  for (const status of [403, 502, null]) {
    assert.deepEqual(codes(run({ deploy: { pages: { status, build_type: null, source_branch: null } } })), [], String(status));
  }
});

test('Pages off with no deploy-pages workflow is not this defect', () => {
  // A repo that builds its site some other way (or not at all) is not failing.
  const f = run({ files: [RELEASE], deploy: { pages: { status: 404 } } });
  assert.ok(!codes(f).includes('CI_PAGES_NOT_ENABLED'));
});

test('a snapshot from before the pass never fires, and neither does a repo it did not ask', () => {
  assert.deepEqual(codes(run({ withPass: false })), []);
  assert.deepEqual(codes(run({ deploy: undefined })), []);
});

// ----------------------------------------------------------- environments ---

test('a custom policy that names only the old default branch fires', () => {
  // The triage's shape: the repo moved to main, the environment still says master.
  const f = run({ deploy: { pages: PAGES_ON, environments: envs(env('github-pages', 'custom', ['branch:master'])) } });
  assert.deepEqual(codes(f), ['CI_ENVIRONMENT_EXCLUDES_DEFAULT']);
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].message, /Environment "github-pages" admits only branch:master/);
  assert.match(f[0].evidence, /w0\.yml: deploy/);
  assert.match(f[0].evidence, /Never leave a repo with failing CI/);
});

test('a custom policy that names the default branch is silent', () => {
  const f = run({ deploy: { pages: PAGES_ON, environments: envs(env('github-pages', 'custom', ['branch:gh-pages', 'branch:main'])) } });
  assert.deepEqual(codes(f), []);
});

test('a tag-only policy on a release-only job is correct, not a finding', () => {
  // The fleet's release shape: `release` admits tag:v* and its jobs run on a release tag.
  const f = run({ files: [RELEASE], deploy: { environments: envs(env('release', 'custom', ['tag:v*'])) } });
  assert.deepEqual(codes(f), []);
});

test('the same tag-only policy on a job that runs on main does fire', () => {
  const f = run({ files: [NIGHTLY], deploy: { environments: envs(env('nightly', 'custom', ['tag:v*'])) } });
  assert.deepEqual(codes(f), ['CI_ENVIRONMENT_EXCLUDES_DEFAULT']);
});

test('a pattern the rule cannot evaluate is unknown, not a finding', () => {
  const f = run({ deploy: { pages: PAGES_ON, environments: envs(env('github-pages', 'custom', ['branch:[mM]ain'])) } });
  assert.deepEqual(codes(f), []);
});

test('unreadable branch policies are unknown, not an empty list', () => {
  const e = env('github-pages', 'custom');
  e.branch_policies = { status: 403, total_count: null, list: null };
  assert.deepEqual(codes(run({ deploy: { pages: PAGES_ON, environments: envs(e) } })), []);
});

test('an unreadable environment list is silent', () => {
  assert.deepEqual(codes(run({ deploy: { pages: PAGES_ON, environments: { status: 403, list: null } } })), []);
});

test('an environment named in a workflow but absent from the repo is created open, so silent', () => {
  assert.deepEqual(codes(run({ deploy: { pages: PAGES_ON, environments: envs(env('other', 'custom', ['branch:x'])) } })), []);
});

test('"protected branches only" fires when main is unprotected and another branch is', () => {
  const f = run({ deploy: {
    pages: PAGES_ON, environments: envs(env('github-pages', 'protected')),
    default_branch: { name: 'main', status: 200, protected: false, any_protected: true, ruleset_rules: 0 },
  } });
  assert.deepEqual(codes(f), ['CI_ENVIRONMENT_EXCLUDES_DEFAULT']);
  assert.match(f[0].message, /protected branches only, and "main" is not protected/);
});

test('"protected branches only" is silent when main is protected, when no branch is, or when it cannot tell', () => {
  const base = { pages: PAGES_ON, environments: envs(env('github-pages', 'protected')) };
  const shapes = [
    { name: 'main', status: 200, protected: true, any_protected: null, ruleset_rules: null },
    // GitHub lets every branch deploy when no branch in the repo is protected.
    { name: 'main', status: 200, protected: false, any_protected: false, ruleset_rules: null },
    // A ruleset may count as protection here; not verified, so unknown.
    { name: 'main', status: 200, protected: false, any_protected: true, ruleset_rules: 2 },
    { name: 'main', status: 403, protected: null, any_protected: null, ruleset_rules: null },
  ];
  for (const db of shapes) assert.deepEqual(codes(run({ deploy: { ...base, default_branch: db } })), [], JSON.stringify(db));
});

// ---------------------------------------------------------- pure deciders ---

test('deploymentPatternMatches: fnmatch as GitHub documents it, and what it declines', () => {
  assert.equal(deploymentPatternMatches('main', 'main'), 1);
  assert.equal(deploymentPatternMatches('master', 'main'), 0);
  assert.equal(deploymentPatternMatches('ma?n', 'main'), 1);
  assert.equal(deploymentPatternMatches('release/*', 'release/1/2'), 0);
  assert.equal(deploymentPatternMatches('*', 'main'), 1);
  assert.equal(deploymentPatternMatches('**', 'main'), 1);
  assert.equal(deploymentPatternMatches('**', 'feature/x'), null);
  assert.equal(deploymentPatternMatches('{main,dev}', 'main'), null);
  assert.equal(deploymentPatternMatches('m.in', 'main'), 0, 'a dot is literal');
});

test('environmentAdmitsBranch: all admits, unknown policy is unknown', () => {
  assert.equal(environmentAdmitsBranch({ policy: 'all' }, null, 'main'), 1);
  assert.equal(environmentAdmitsBranch({ policy: null }, null, 'main'), null);
  assert.equal(environmentAdmitsBranch({ policy: 'custom', policies_readable: 1, branch_policies: 'tag:v*' }, null, 'main'), 0);
  assert.equal(environmentAdmitsBranch({ policy: 'protected' },
    { default_branch: 'master', default_protected: 0, any_branch_protected: 1, default_ruleset_rules: 0 }, 'main'), null,
    'protection read for a different branch says nothing about this one');
});
