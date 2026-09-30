// CI_FAILING reads the default branch head's own checks, not only GitHub's
// rollup. The rollup counts a CANCELLED check run as a failure, so the same
// commit pushed twice -- two runs, the first cancelled by the concurrency
// rule, the second green -- reads FAILURE forever. Measured 2026-09-30 on two
// repositories, every non-green check CANCELLED beside a SUCCESS of the same
// name, while a third repository's rollup was red for a real FAILURE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/load.mjs';
import { analyze, failingHeadChecks, HEAD_CHECKS_RED } from '../src/analyze.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');
const ctx = (name, state) => ({ name, state });

// ------------------------------------------------------------ the decision --

test('a cancelled run replaced by a green run of the same check is not a failure', () => {
  assert.deepEqual(failingHeadChecks([ctx('test (22)', 'CANCELLED'), ctx('test (22)', 'SUCCESS'),
    ctx('audit', 'CANCELLED'), ctx('audit', 'SUCCESS'), ctx('site-build', 'SKIPPED')]), []);
});

test('a check that failed with no green run beside it is a failure', () => {
  assert.deepEqual(failingHeadChecks([ctx('deploy', 'FAILURE'), ctx('build', 'SUCCESS')]),
    [{ name: 'deploy', states: ['FAILURE'] }]);
  for (const s of ['ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']) {
    assert.equal(failingHeadChecks([ctx('x', s)]).length, 1, s);
  }
  assert.deepEqual(failingHeadChecks([ctx('test', 'CANCELLED'), ctx('test', 'FAILURE')]),
    [{ name: 'test', states: ['CANCELLED', 'FAILURE'] }], 'cancelled then failed is still failed');
});

test('a check only ever cancelled, skipped, neutral or running is not a failure', () => {
  assert.deepEqual(failingHeadChecks([ctx('a', 'CANCELLED'), ctx('b', 'SKIPPED'), ctx('c', 'NEUTRAL'), ctx('d', null)]), []);
});

test('no head checks at all is not measured, and the caller falls back to the rollup', () => {
  assert.equal(failingHeadChecks([]), null);
  assert.equal(failingHeadChecks(undefined), null);
});

// ------------------------------------------------------------ end to end --

function sweep(repos) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const node = (c) => (c.status ? { __typename: 'StatusContext', context: c.name, state: c.state } : { __typename: 'CheckRun', name: c.name, conclusion: c.state });
  const sid = loadSnapshot(db, {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: repos.length, duration_ms: 1,
    repos: repos.map(({ name, rollup, checks }, i) => ({
      name, id: `R_${i}`, description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', pushedAt: new Date().toISOString(),
      defaultBranchRef: { name: 'main', target: { oid: 'abc1234def', statusCheckRollup: rollup
        ? { state: rollup, contexts: { totalCount: checks.length, nodes: checks.map(node) } } : null } },
    })),
    workflow_files: {}, workflow_runs: [],
  });
  analyze(db, sid, { metaRepos: [] });
  return {
    findings: db.prepare("SELECT repo, message FROM finding WHERE code='CI_FAILING' ORDER BY repo").all(),
    red: db.prepare(`SELECT r.name FROM repo r WHERE r.snapshot_id=? AND ${HEAD_CHECKS_RED} ORDER BY r.name`).all(sid).map(x => x.name),
  };
}

test('end to end: only the head with a real failure is red, in the finding and in the red-main query', () => {
  const r = sweep([
    { name: 'repo-a', rollup: 'FAILURE', checks: [{ name: 'test (22)', state: 'CANCELLED' }, { name: 'test (22)', state: 'SUCCESS' }] },
    { name: 'repo-b', rollup: 'FAILURE', checks: [{ name: 'deploy', state: 'FAILURE' }, { name: 'build', state: 'SUCCESS' }] },
    { name: 'repo-c', rollup: 'FAILURE', checks: [{ name: 'ci/legacy', state: 'ERROR', status: true }] },
    { name: 'repo-d', rollup: 'SUCCESS', checks: [{ name: 'test', state: 'SUCCESS' }] },
  ]);
  assert.deepEqual(r.findings.map(f => f.repo), ['repo-b', 'repo-c']);
  assert.equal(r.findings[0].message, 'Default-branch checks failing: deploy (FAILURE).');
  assert.match(r.findings[1].message, /ci\/legacy \(ERROR\)/, 'a legacy commit status counts too');
  assert.deepEqual(r.red, ['repo-b', 'repo-c'], 'hk ci, the MCP server and the report read the same decision');
});

test('end to end: a red rollup with no check rows keeps today\'s finding, not silence', () => {
  const r = sweep([{ name: 'repo-a', rollup: 'ERROR', checks: [] }]);
  assert.deepEqual(r.findings.map(f => [f.repo, f.message]), [['repo-a', 'Default-branch check rollup is ERROR.']]);
});
