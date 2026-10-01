// WF_SCHEDULED against rules/github-actions.md, "Scheduled workflows" (the org
// rule was amended 2026-09-08). Each shape is one measured on 2026-09-30 across the org's 19 scheduled workflows: the
// rule used to fire on all 19, including the six that meet every condition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow } from '../src/load.mjs';
import { cronFiresPerYear } from '../src/workflow-risks.mjs';

const gaps = yaml => {
  const g = inspectWorkflow(yaml, '.github/workflows/x.yml').schedule_gaps;
  return g == null ? null : g.split('\n').filter(Boolean);
};

test('cron frequency: weekly, monthly, daily, several a week, every six hours', () => {
  assert.equal(cronFiresPerYear('0 7 * * 1'), 52);
  assert.equal(cronFiresPerYear('0 0 1 * *'), 12);
  assert.equal(cronFiresPerYear('0 6 * * *'), 365);
  assert.equal(cronFiresPerYear('0 9 * * 1,3,5'), 156);
  assert.equal(cronFiresPerYear('0 */6 * * *'), 1460);
  assert.equal(cronFiresPerYear('17 6 * * MON'), 52);
  assert.equal(cronFiresPerYear('not a cron'), null);
});

test('a workflow with no schedule has no gaps to report (null, not empty)', () => {
  assert.equal(gaps('on: { push: { paths: [src/**] } }\njobs:\n  a: { runs-on: ubuntu-latest }\n'), null);
});

test('a weekly, bounded, branch-and-PR workflow with dispatch meets the rule', () => {
  // The shape of a weekly pin bump: push a branch it created, then open a PR.
  assert.deepEqual(gaps(`
on:
  schedule: [{ cron: '0 7 * * 1' }]
  workflow_dispatch:
concurrency: { group: bump, cancel-in-progress: false }
jobs:
  bump:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: |
          git checkout -B "$BRANCH"
          git commit -am bump
          git push -f origin "$BRANCH"
          gh pr create --fill
`), []);
});

test('a read-only weekly check with no push and no PR meets the rule', () => {
  // CodeQL or a smoke run changes nothing, so there is nothing to review.
  assert.deepEqual(gaps(`
on:
  schedule: [{ cron: '0 9 * * 0' }]
  workflow_dispatch:
concurrency: { group: q, cancel-in-progress: true }
jobs:
  analyze: { runs-on: ubuntu-latest, timeout-minutes: 30, steps: [{ uses: github/codeql-action/analyze@v3 }] }
`), []);
});

test('a daily job that commits straight to the checked-out branch fails four ways', () => {
  assert.deepEqual(gaps(`
on:
  schedule: [{ cron: '0 12 * * *' }]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: git diff --staged --quiet || (git commit -m sync && git push)
`), [
    'runs more often than weekly (daily, which needs a stated reason)',
    'no timeout-minutes on sync',
    'no concurrency block',
    'pushes to the branch it checked out instead of opening a PR (sync)',
    'no workflow_dispatch',
  ]);
});

test('an auto-commit action with no branch input pushes the checked-out branch', () => {
  const g = gaps(`
on: { schedule: [{ cron: '0 7 * * 1' }], workflow_dispatch: {} }
concurrency: c
jobs:
  a: { runs-on: ubuntu-latest, timeout-minutes: 5, steps: [{ uses: stefanzweifel/git-auto-commit-action@v5 }] }
`);
  assert.deepEqual(g, ['pushes to the branch it checked out instead of opening a PR (a)']);
});

test('a matrix that reaches Windows is not bounded to Linux', () => {
  const g = gaps(`
on: { schedule: [{ cron: '0 6 * * 1' }], workflow_dispatch: {} }
concurrency: c
jobs:
  test:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 20
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
`);
  assert.deepEqual(g, ['runs off Linux (windows-latest)']);
});

test('an unresolved runner expression is not a violation', () => {
  const g = gaps(`
on: { schedule: [{ cron: '0 6 * * 1' }], workflow_dispatch: {} }
concurrency: c
jobs:
  a: { runs-on: '\${{ inputs.runner }}', timeout-minutes: 5 }
`);
  assert.deepEqual(g, []);
});

test('a job calling a reusable workflow is not asked for timeout-minutes', () => {
  const g = gaps(`
on: { schedule: [{ cron: '0 6 * * 1' }], workflow_dispatch: {} }
concurrency: c
jobs:
  call: { uses: org/repo/.github/workflows/x.yml@main }
`);
  assert.deepEqual(g, []);
});

test('job-level concurrency on every job counts as bounded', () => {
  const g = gaps(`
on: { schedule: [{ cron: '0 6 * * 1' }], workflow_dispatch: {} }
jobs:
  a: { runs-on: ubuntu-latest, timeout-minutes: 5, concurrency: a }
  b: { runs-on: ubuntu-latest, timeout-minutes: 5, concurrency: b }
`);
  assert.deepEqual(g, []);
});
