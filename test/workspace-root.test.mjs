// MONOREPO_ROOT — is this repo a workspace root whose version ships nothing?
//
// The distinction was keyed on npm's `workspaces` field alone, which missed
// more than half of one org's workspace roots. Every one it missed declares
// itself with pnpm-workspace.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspaceRoot, WORKSPACE_MARKERS } from '../src/load.mjs';

test('npm workspaces field still counts', () => {
  assert.equal(isWorkspaceRoot({ workspaces: ['packages/*'] }, []), true);
  assert.equal(isWorkspaceRoot({ workspaces: { packages: ['a'] } }, []), true);
});

test('pnpm-workspace.yaml counts — this is the case that was being missed', () => {
  // Roots declared this way look like plain packages by the npm field alone.
  const declares = 'packages:\n  - "packages/*"\n';
  assert.equal(isWorkspaceRoot({}, ['package.json', 'pnpm-workspace.yaml'], declares), true);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yml'], declares), true);
});

test('pnpm-workspace.yaml WITHOUT packages: is settings, not a workspace', () => {
  // pnpm 11 moved settings out of package.json's `pnpm` field and into this
  // file, and writes it into single-package repos. This is the verbatim content
  // one `pnpm install` produced in a repo that is not a workspace.
  const settingsOnly = [
    'allowBuilds:',
    '  better-sqlite3: set this to true or false',
    '  esbuild: set this to true or false',
    '',
  ].join('\n');
  assert.equal(isWorkspaceRoot({}, ['package.json', 'pnpm-workspace.yaml'], settingsOnly), false);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yml'], settingsOnly), false);

  // An npm workspaces field still wins outright — the file is not consulted.
  assert.equal(
    isWorkspaceRoot({ workspaces: ['packages/*'] }, ['pnpm-workspace.yaml'], settingsOnly), true);
});

test('packages: is matched as a key, not as a substring', () => {
  // A settings file that merely mentions the word must not pass.
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'],
    'allowBuilds:\n  # do not list packages: here\n'), false);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'],
    'onlyBuiltDependencies:\n  - my-packages:thing\n'), false);
  // ...but real files pass in their normal shapes.
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'], 'packages:\n  - apps/*\n'), true);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'],
    'allowBuilds:\n  esbuild: true\npackages:\n  - packages/*\n'), true);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'], 'packages :\n  - a\n'), true);
});

test('the three values of the content argument mean three different things', () => {
  // undefined — the field was never collected. Every snapshot written before
  // this check existed is in this state, and they meant presence at the time.
  // Reading them any other way would make `npm run rebuild` on historical data
  // lose all 16 workspace roots and invent version drift for them.
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'], undefined), true);
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml']), true);

  // null — collected, but no readable text for a file that is in the tree. No
  // evidence of a workspace, so take the direction that errs loudly:
  // MONOREPO_ROOT SUPPRESSES drift findings, so a false positive hides a real
  // problem while a false negative only emits noise someone will dismiss.
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml'], null), false);

  // lerna/rush are unaffected either way — their presence still proves it.
  assert.equal(isWorkspaceRoot({}, ['lerna.json'], null), true);
  assert.equal(isWorkspaceRoot({}, ['rush.json'], null), true);
});

test('lerna and rush roots count', () => {
  assert.equal(isWorkspaceRoot({}, ['lerna.json']), true);
  assert.equal(isWorkspaceRoot({}, ['rush.json']), true);
});

test('turbo.json and nx.json do NOT count on their own', () => {
  // Deliberate. Both appear in single-package repos that use those tools purely
  // for task running. Treating them as proof of a workspace would trade this
  // rule's under-reporting for the over-reporting it exists to prevent —
  // exactly the mistake that produced the original false version-drift counts.
  assert.equal(isWorkspaceRoot({}, ['turbo.json']), false);
  assert.equal(isWorkspaceRoot({}, ['nx.json']), false);
  // ...but a real workspace that also uses turbo is still caught, by the marker
  // that actually declares the workspace.
  assert.equal(isWorkspaceRoot({}, ['turbo.json', 'pnpm-workspace.yaml']), true);
});

test('a plain package is not a workspace root', () => {
  assert.equal(isWorkspaceRoot({ name: 'x', version: '1.0.0' }, ['package.json', 'README.md']), false);
  assert.equal(isWorkspaceRoot({}, []), false);
});

test('survives a missing or malformed package.json', () => {
  assert.equal(isWorkspaceRoot(null, ['pnpm-workspace.yaml']), true);
  assert.equal(isWorkspaceRoot(undefined, []), false);
  assert.equal(isWorkspaceRoot(null, []), false);
});

test('marker matching is case-insensitive and tolerates odd entries', () => {
  assert.equal(isWorkspaceRoot({}, ['PNPM-Workspace.YAML']), true);
  assert.equal(isWorkspaceRoot({}, [null, undefined, 42, 'pnpm-workspace.yaml']), true);
});

test('a marker in a subdirectory name does not count', () => {
  // Only root entries are passed in, but be explicit that a partial match on a
  // longer name is not a marker.
  assert.equal(isWorkspaceRoot({}, ['pnpm-workspace.yaml.bak', 'my-lerna.json']), false);
});

test('the marker set stays deliberately small', () => {
  // If this grows, the reason belongs in load.mjs next to the list: every entry
  // must exist ONLY to declare a workspace.
  assert.deepEqual([...WORKSPACE_MARKERS].sort(),
    ['lerna.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'rush.json']);
});
