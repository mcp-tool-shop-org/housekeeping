// CI_REQUIRED_CHECK_STALE / CI_REQUIRED_CHECK_GATED — a required status check
// context that nothing reports.
//
// Every case below is a repo shape measured on 2026-09-17, and the three marked
// FALSE POSITIVE were all produced by earlier versions of this rule. They are
// the reason the rule takes `declaredJobs` and a time-bounded `observedNames`
// instead of just diffing protection against the latest checks: each one looked
// completely plausible in aggregate and pointed at the wrong repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequiredChecks } from '../src/analyze.mjs';

test('a dropped matrix cell is stale when a sibling cell still reports', () => {
  // Protection requires node 20, the matrix is [22, 24]. The job runs
  // and is green; that one cell is gone. Node 20 went EOL in April 2026.
  const { stale, live } = classifyRequiredChecks({
    required: ['build-and-test (20)', 'build-and-test (22)'],
    observedNames: ['build-and-test (22)', 'build-and-test (24)'],
    declaredJobs: ['build-and-test', 'docker-smoke'],
  });
  assert.deepEqual(stale, ['build-and-test (20)']);
  assert.deepEqual(live, ['build-and-test (22)']);
});

test('a renamed job leaves every context that named it stale', () => {
  // One `test` job with a package matrix was split into `python` and `nodejs`.
  // All six required contexts were orphaned at once and every PR in the repo
  // became unmergeable.
  const { stale } = classifyRequiredChecks({
    required: ['test (a11y-lint)', 'test (a11y-ci)', 'test (a11y-demo-site)'],
    observedNames: ['python (a11y-lint)', 'python (a11y-ci)', 'nodejs (a11y-mcp-tools)'],
    declaredJobs: ['python', 'nodejs', 'a11y-gate', 'test-a11y-action-pass'],
  });
  assert.deepEqual(stale, ['test (a11y-lint)', 'test (a11y-ci)', 'test (a11y-demo-site)']);
});

test('a job id that merely prefixes the context does not rescue it', () => {
  // `test-a11y-action-pass` starts with "test" but is not the job behind
  // "test (a11y-lint)". Matching on prefix instead of on the full base name
  // would have called all six of the above live.
  const { stale } = classifyRequiredChecks({
    required: ['test (a11y-lint)'],
    observedNames: ['python (a11y-lint)'],
    declaredJobs: ['test-a11y-action-pass', 'python'],
  });
  assert.deepEqual(stale, ['test (a11y-lint)']);
});

test('FALSE POSITIVE #1: a live job in a pull_request-only workflow is not stale', () => {
  // `validate-ledger` lives in ledger-ci.yml, which has no `push`
  // trigger at all, so the default branch can NEVER report it, and no open
  // Dependabot PR touches its paths. Absent everywhere we can see — but the job
  // exists and runs. The STALE repair is "drop the context", which would have
  // retired a working gate.
  const { stale, live } = classifyRequiredChecks({
    required: ['validate-ledger'],
    observedNames: ['anchor', 'attest-and-check', 'Dependabot'],
    declaredJobs: ['validate-ledger', 'anchor', 'attest-and-check', 'build-and-deploy'],
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(live, ['validate-ledger']);
});

test('FALSE POSITIVE #2: a live cell is not stale just because no sibling ran', () => {
  // The matrix really is ["3.11","3.12","3.13"], but the last
  // commit on main only touched site files, so pages.yml ran and ci.yml did not:
  // main reports `build`/`deploy` and no `test (...)` at all. With no sibling
  // observed and a declared `test` job, the honest answer is "did not run here".
  const { stale, live } = classifyRequiredChecks({
    required: ['test (3.11)', 'test (3.12)', 'test (3.13)'],
    observedNames: ['build', 'deploy'],
    declaredJobs: ['test', 'build', 'deploy'],
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(live, ['test (3.11)', 'test (3.12)', 'test (3.13)']);
});

test('FALSE POSITIVE #3: evidence from a stale PR head must not count as live', () => {
  // Python 3.11 was deleted from the matrix months ago. Two PRs opened before
  // that still carry a green
  // "Python 3.11 on ubuntu-latest" check, because check runs are frozen on the
  // commit they ran against. Passing those names in as `observedNames` reads a
  // dead cell as alive; the caller time-bounds the window, and this asserts the
  // classification each window produces.
  const required = ['Python 3.11 on ubuntu-latest', 'Python 3.12 on ubuntu-latest'];
  const declaredJobs = ['test', 'lint', 'npm-wrapper', 'nightly-fuzz'];

  const contaminated = classifyRequiredChecks({
    required,
    observedNames: ['Python 3.11 on ubuntu-latest', 'Python 3.12 on ubuntu-latest'],
    declaredJobs,
  });
  assert.deepEqual(contaminated.stale, [], 'an unbounded window sees the June cell as alive');

  const bounded = classifyRequiredChecks({
    required,
    observedNames: ['Python 3.12 on ubuntu-latest', 'Org URL sanity check'],
    declaredJobs,
  });
  assert.deepEqual(bounded.stale, ['Python 3.11 on ubuntu-latest']);
});

test('an interpolated job name is judged on the context text, not the template', () => {
  // A workflow names its matrix job `Python ${{ matrix.python-version }} on
  // ${{ matrix.os }}`. inspectWorkflow refuses to store a name holding an
  // expression, so `declaredJobs` cannot contain it and the context has no
  // parenthesised suffix to strip. "Docker Build" is the same shape: the job
  // that publishes images is named `Publish <stage> to GHCR`.
  const { stale } = classifyRequiredChecks({
    required: ['Docker Build'],
    observedNames: ['Docker production', 'Docker mcp-gateway', 'Integration Tests'],
    declaredJobs: ['docker', 'build', 'publish-pypi', 'Build package'],
  });
  assert.deepEqual(stale, ['Docker Build']);
});

test('a context satisfied by a commit status, not a job, is live', () => {
  // Required contexts can be answered by the legacy commit-status API — an
  // external integration with no job anywhere in .github/workflows. Reading
  // only CheckRun names would report every such gate as unsatisfiable.
  const { stale } = classifyRequiredChecks({
    required: ['codecov/project', 'test (22.x)'],
    observedNames: ['codecov/project', 'test (22.x)'],
    declaredJobs: ['test'],
  });
  assert.deepEqual(stale, []);
});

test('a fully satisfied gate produces neither finding', () => {
  const { stale, live } = classifyRequiredChecks({
    required: ['lint', 'test (22.x)', 'test (24.x)'],
    observedNames: ['lint', 'test (22.x)', 'test (24.x)'],
    declaredJobs: ['lint', 'test'],
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(live, ['lint', 'test (22.x)', 'test (24.x)']);
});

test('nested parentheses in a cell value do not confuse the base name', () => {
  // Cells can be spelled `test (20, macos-latest)`. Only the trailing
  // group is the matrix; a job whose literal name itself ends in parentheses
  // must not be shortened past it.
  const { stale } = classifyRequiredChecks({
    required: ['test (20, macos-latest)', 'Build & Test (.NET 10.0.x)'],
    observedNames: ['test (20, ubuntu-latest)', 'Build & Test (.NET 10.0.x)'],
    declaredJobs: ['test', 'build'],
  });
  assert.deepEqual(stale, ['test (20, macos-latest)']);
});
