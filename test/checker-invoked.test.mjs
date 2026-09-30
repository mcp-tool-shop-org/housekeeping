// PKG_CHECKER_NEVER_RUN — a checker declared in package.json that no script runs.
//
// Both false positives below were real, found on the first pass over the org and
// only caught by checking the findings against the repos by hand. They are the
// reason this file exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uninvokedCheckers } from '../src/analyze.mjs';

const names = (list) => list.map(c => c.dep).sort();

test('flags typescript when no script invokes a typechecker', () => {
  // A real shape: tsup builds and tsx runs, both esbuild, which strips types
  // without checking them. Real type errors were hiding behind it.
  const out = uninvokedCheckers(
    ['tsup src/cli.ts --format esm', 'tsx src/cli.ts', 'vitest run'],
    ['typescript', 'tsup', 'vitest'],
  );
  assert.deepEqual(names(out), ['typescript']);
});

test('does not flag when a script actually runs tsc', () => {
  const out = uninvokedCheckers(['tsc --noEmit', 'vitest run'], ['typescript']);
  assert.deepEqual(out, []);
});

test('counts the alternative typecheckers, not just bare tsc', () => {
  for (const cmd of ['vue-tsc --noEmit', 'svelte-check', 'astro check', 'tsgo --noEmit']) {
    assert.deepEqual(uninvokedCheckers([cmd], ['typescript']), [],
      `"${cmd}" should count as typechecking`);
  }
});

test('a workspace-delegating root is not judged at all', () => {
  // FALSE POSITIVE #1. A root running `pnpm -r typecheck` and one running
  // `turbo run typecheck` both DO typecheck — in sub-package manifests this
  // collector never fetches. Silence beats a confident wrong finding.
  for (const cmd of ['pnpm -r typecheck', 'turbo run typecheck', 'nx run-many -t lint',
    'lerna run build', 'npm -w packages/core run build', 'yarn workspaces run test']) {
    assert.deepEqual(uninvokedCheckers([cmd], ['typescript', 'eslint']), [],
      `"${cmd}" delegates; the root cannot be judged`);
  }
});

test('bare `turbo build` delegates just as much as `turbo run build`', () => {
  // FALSE POSITIVE #2. Matching only "turbo run" let a root through, because
  // turbo accepts the task name directly.
  assert.deepEqual(uninvokedCheckers(['turbo build', 'turbo test'], ['typescript']), []);
});

test('says nothing about a repo with no scripts', () => {
  assert.deepEqual(uninvokedCheckers([], ['typescript', 'eslint']), []);
});

test('says nothing about a checker that is not declared', () => {
  assert.deepEqual(uninvokedCheckers(['node index.js'], ['tsup']), []);
});

test('flags each declared checker independently', () => {
  const out = uninvokedCheckers(['node build.js'], ['typescript', 'eslint', 'oxlint']);
  assert.deepEqual(names(out), ['eslint', 'oxlint', 'typescript']);
});

test('a linted repo that never typechecks is still flagged for typescript', () => {
  const out = uninvokedCheckers(['eslint .', 'tsup src'], ['typescript', 'eslint']);
  assert.deepEqual(names(out), ['typescript']);
});
