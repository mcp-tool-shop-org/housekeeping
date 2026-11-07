// The branch pass: what the collector records, how the loader names each
// branch's state, and what `hk watch` is built on.
//
// The hazard is a branch called deletable that is not. Two shapes looked
// deletable and were not when this was first done by hand: a merged branch
// whose tip moved after the merge (its new commits exist nowhere else), and a
// merged branch that an open stacked PR uses as its base. Each case below
// pins the neighbouring shape too, so a rule that over-reaches shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { collectBranches } from '../src/collect.mjs';
import { branchRows, loadSnapshot } from '../src/load.mjs';

const pr = (number, state, head_oid) => ({ number, state, head_oid });
const br = (name, oid, prs = [], committed_at = '2026-10-01T00:00:00Z') => ({ name, oid, committed_at, prs });
const states = (rec, opts) => Object.fromEntries(branchRows(rec, opts).map(b => [b.name, [b.state, b.pr_number]]));

// ------------------------------------------------------------------ states --

test('a merged branch whose tip is the merged head is merged', () => {
  const rec = { branches: [br('feat-a', 'aaa', [pr(4, 'MERGED', 'aaa')])] };
  assert.deepEqual(states(rec), { 'feat-a': ['merged', 4] });
});

test('a merged branch pushed to after the merge is merged_moved, not merged', () => {
  const rec = { branches: [br('feat-a', 'bbb', [pr(4, 'MERGED', 'aaa')])] };
  assert.deepEqual(states(rec), { 'feat-a': ['merged_moved', 4] });
});

test('a merged PR with no recorded head oid is never read as an exact match', () => {
  const rec = { branches: [br('feat-a', 'aaa', [pr(4, 'MERGED', null)])] };
  assert.deepEqual(states(rec), { 'feat-a': ['merged_moved', 4] });
});

test('any of several merged PRs matching the tip makes it merged', () => {
  const rec = { branches: [br('reused', 'ccc', [pr(9, 'MERGED', 'bbb'), pr(3, 'MERGED', 'ccc')])] };
  assert.deepEqual(states(rec), { reused: ['merged', 3] });
});

test('an open PR beats a merged one on the same branch', () => {
  const rec = { branches: [br('reused', 'ccc', [pr(9, 'OPEN', 'ccc'), pr(3, 'MERGED', 'aaa')])] };
  assert.deepEqual(states(rec), { reused: ['open_pr', 9] });
});

test('the base of an open stacked PR is open_base even when its own PR merged', () => {
  const rec = { branches: [br('stack-base', 'aaa', [pr(4, 'MERGED', 'aaa')])] };
  assert.deepEqual(states(rec, { openBases: ['stack-base'] }), { 'stack-base': ['open_base', null] });
  assert.deepEqual(states(rec, { openBases: ['other'] }), { 'stack-base': ['merged', 4] });
});

test('closed-only is closed, and no PR at all is no_pr', () => {
  const rec = { branches: [br('dropped', 'aaa', [pr(5, 'CLOSED', 'aaa')]), br('scratch', 'bbb')] };
  assert.deepEqual(states(rec), { dropped: ['closed', 5], scratch: ['no_pr', null] });
});

test('the default branch is never a row', () => {
  const rec = { branches: [br('main', 'aaa', [pr(1, 'MERGED', 'aaa')]), br('feat-a', 'bbb')] };
  assert.deepEqual(Object.keys(states(rec, { defaultBranch: 'main' })), ['feat-a']);
});

// --------------------------------------------------------------- collector --

const page = (nodes, { next = null, total = nodes.length, del = false } = {}) => ({ data: { repository: {
  deleteBranchOnMerge: del,
  refs: { totalCount: total, pageInfo: { hasNextPage: !!next, endCursor: next }, nodes },
} } });
const node = (name, oid, prs = []) => ({ name, target: { oid, committedDate: '2026-10-01T00:00:00Z' },
  associatedPullRequests: { nodes: prs.map(([number, state, headRefOid]) => ({ number, state, headRefOid })) } });

test('collectBranches follows the cursor and skips archived and empty repos', async () => {
  const asked = [];
  const query = async (_q, v) => {
    asked.push(`${v.name}:${v.cursor}`);
    if (v.cursor === null) {
      return page([node('main', 'm'), node('feat-a', 'a', [[2, 'MERGED', 'a']])], { next: 'c1', total: 3, del: true });
    }
    return page([node('feat-b', 'b')], { total: 3, del: true });
  };
  const repos = [{ name: 'repo-a' }, { name: 'repo-old', isArchived: true }, { name: 'repo-new', isEmpty: true }];
  const res = await collectBranches('org-x', repos, { query });
  assert.deepEqual(asked, ['repo-a:null', 'repo-a:c1']);
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.repos), ['repo-a']);
  assert.equal(res.repos['repo-a'].delete_branch_on_merge, true);
  assert.equal(res.repos['repo-a'].total, 3);
  assert.deepEqual(res.repos['repo-a'].branches.map(b => b.name), ['main', 'feat-a', 'feat-b']);
  assert.deepEqual(res.repos['repo-a'].branches[1].prs, [{ number: 2, state: 'MERGED', head_oid: 'a' }]);
});

test('an unreadable repo gets an error and no record, never an empty one', async () => {
  const query = async (_q, v) => {
    if (v.name === 'repo-b') throw new Error('HTTP 502');
    return page([node('main', 'm')]);
  };
  const res = await collectBranches('org-x', [{ name: 'repo-a' }, { name: 'repo-b' }], { query });
  assert.equal(res.ok, false);
  assert.deepEqual(Object.keys(res.repos), ['repo-a']);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].repo, 'repo-b');
  assert.equal(res.errors[0].stage, 'branches');
});

// ------------------------------------------------------------------ loader --

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');

function load(snapExtra) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const repo = name => ({
    name, id: 'R_' + name, description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    pushedAt: '2026-10-01T00:00:00Z', defaultBranchRef: { name: 'main' },
    prList: { nodes: name === 'repo-a'
      ? [{ number: 7, title: 't', url: 'u', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
           baseRefName: 'stack-base', headRefName: 'stack-top' }]
      : [] },
  });
  const sid = loadSnapshot(db, {
    taken_at: '2026-10-11T00:00:00Z', org: 'org-x', collector_version: 'test', repo_count: 2,
    duration_ms: 0, repos: [repo('repo-a'), repo('repo-b')], workflow_files: {}, workflow_runs: [], ...snapExtra,
  });
  return { db, sid };
}

test('the loader stores states per repo and leaves an unread repo with no rows', () => {
  const { db, sid } = load({ branches: { ok: true, repos: { 'repo-a': {
    delete_branch_on_merge: false, total: 4, branches: [
      br('main', 'm'), br('stack-base', 'a', [pr(2, 'MERGED', 'a')]),
      br('stack-top', 't', [pr(7, 'OPEN', 't')]), br('old', 'o', [pr(1, 'MERGED', 'x')]),
    ] } } } });
  const rows = db.prepare('SELECT repo, name, state FROM branch WHERE snapshot_id=? ORDER BY name').all(sid)
    .map(r => [r.repo, r.name, r.state]);
  assert.deepEqual(rows, [
    ['repo-a', 'old', 'merged_moved'], ['repo-a', 'stack-base', 'open_base'], ['repo-a', 'stack-top', 'open_pr'],
  ]);
  const set = db.prepare('SELECT repo, delete_on_merge, branch_count FROM repo_branches WHERE snapshot_id=?').all(sid)
    .map(r => [r.repo, r.delete_on_merge, r.branch_count]);
  assert.deepEqual(set, [['repo-a', 0, 4]]);
});

test('a snapshot from before the branch pass loads with no branch rows at all', () => {
  const { db, sid } = load({});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch WHERE snapshot_id=?').get(sid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM repo_branches WHERE snapshot_id=?').get(sid).n, 0);
});
