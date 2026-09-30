// A dependency scanner that cannot fail its job renders the same green check as
// a clean one. These tests exist because the first version of this rule reported
// ZERO findings across every audit step in a whole org and read as "nothing to
// fix" -- the pattern had been built with new RegExp(['\\b...'].join('|')), and
// '\b' inside a JS string is the BACKSPACE character, so it was hunting for a
// 0x08 byte. A wrong regex does not throw. It matches nothing, and nothing looks
// exactly like clean.
//
// The false-positive cases below are real steps from the org, kept as tests
// because each one is a defensible engineering pattern that an over-eager rule
// would have called a defect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { auditSteps } from '../src/workflow-risks.mjs';

const run = (yaml) => {
  const doc = parseYaml(yaml, { logLevel: 'silent' });
  return auditSteps(doc, Object.values(doc.jobs ?? {}));
};

const wrap = (steps) => `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

test('a plain audit step is an enforcing gate', () => {
  // This is the backspace-regex regression guard: under the broken pattern this
  // returned {enforcing: [], defanged: []} and every downstream count read zero.
  const { enforcing, defanged } = run(wrap('      - run: npm audit --audit-level=high'));
  assert.equal(enforcing.length, 1);
  assert.equal(defanged.length, 0);
});

test('every scanner the org actually uses is recognised', () => {
  // Each of these was seen in a real workflow. A scanner
  // the pattern does not know is a repo silently exempt from the rule.
  for (const cmd of [
    'npm audit', 'pnpm audit --prod', 'yarn audit', 'bun audit',
    'pip-audit --strict', 'cargo audit --deny warnings', 'osv-scanner -r .',
    'govulncheck ./...', 'safety check', 'trivy fs .',
  ]) {
    const { enforcing } = run(wrap(`      - run: ${cmd}`));
    assert.equal(enforcing.length, 1, `not recognised as a scanner: ${cmd}`);
  }
});

test('|| true makes a step defanged', () => {
  const { enforcing, defanged } = run(wrap('      - run: npm audit --omit=dev || true'));
  assert.equal(enforcing.length, 0);
  assert.deepEqual(defanged, ['npm audit --omit=dev || true']);
});

test('continue-on-error on the step makes it defanged', () => {
  const { enforcing, defanged } = run(wrap(
    '      - name: Run pip-audit on full dependencies\n'
    + '        continue-on-error: true\n'
    + '        run: pip-audit'));
  assert.equal(enforcing.length, 0);
  assert.deepEqual(defanged, ['Run pip-audit on full dependencies']);
});

test('continue-on-error on the job is inherited by its steps', () => {
  // Same green check, a completely different-looking YAML. Catching only the
  // inline form would leave the job-level version invisible.
  const { defanged } = run(`
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - name: Dependency audit
        run: npm audit --audit-level=high
`);
  assert.deepEqual(defanged, ['Dependency audit']);
});

test('a step that says it is advisory is neither enforcing nor a defect', () => {
  // A repo can name its step "npm audit (advisory - does not fail the
  // build)". Nobody reading the Checks tab is misled, so flagging it would
  // manufacture noise -- a finding that is confident, plausible and wrong.
  const { enforcing, defanged } = run(wrap(
    '      - name: npm audit (advisory - does not fail the build)\n'
    + '        run: npm audit --audit-level=moderate || true'));
  assert.equal(defanged.length, 0, 'a disclosed advisory step is not a defect');
  assert.equal(enforcing.length, 0, 'but it is still not a gate');
});

test('a threshold gate that swallows the exit and then exits 1 is enforcing', () => {
  // A "pip-audit (CRITICAL floor)" step: `|| true` exists so the JSON
  // report is written, then a parser fails the step on any CRITICAL. Swallowing
  // the exit is the normal way to build this; the step can still fail.
  const { enforcing, defanged } = run(wrap(
    '      - name: pip-audit (CRITICAL floor)\n'
    + '        run: |\n'
    + '          pip-audit --format json --output a.json --strict || true\n'
    + '          python3 -c "import sys; sys.exit(1)"'));
  assert.deepEqual(defanged, []);
  assert.deepEqual(enforcing, ['pip-audit (CRITICAL floor)']);
});

test('an audit read into a variable is reporting, not gating', () => {
  // A workflow renders `npm audit --json` into its job summary. That step is not
  // a gate at all -- the real gate is a separate blocking step -- so
  // counting it would flag a repo that is correctly gated.
  const { enforcing, defanged } = run(wrap(
    '      - name: CI summary\n'
    + '        run: |\n'
    + '          AUDIT_JSON=$(npm audit --json 2>/dev/null || echo \'{}\')\n'
    + '          echo "$AUDIT_JSON" >> $GITHUB_STEP_SUMMARY'));
  assert.deepEqual(defanged, [], 'a summary step is not a defanged gate');
  assert.deepEqual(enforcing, [], 'nor an enforcing one');
});

test('npm audit signatures is a different control and is ignored', () => {
  // Provenance verification, not advisory scanning. Different remediation, so
  // counting it as a dependency gate would misname the finding.
  const { enforcing, defanged } = run(wrap(
    '      - name: npm audit signatures\n        run: npm audit signatures'));
  assert.equal(enforcing.length, 0);
  assert.equal(defanged.length, 0);
});

test('one gated and one ungated invocation in a step leaves it enforcing', () => {
  // The step as a whole can still fail, and the step is the unit GitHub reports.
  const { enforcing, defanged } = run(wrap(
    '      - name: Audit\n'
    + '        run: |\n'
    + '          npm audit --omit=dev || true\n'
    + '          npm audit --audit-level=critical'));
  assert.deepEqual(defanged, []);
  assert.deepEqual(enforcing, ['Audit']);
});

test('a workflow with no scanner at all returns two empty lists', () => {
  const { enforcing, defanged } = run(wrap('      - run: npm test'));
  assert.deepEqual(enforcing, []);
  assert.deepEqual(defanged, []);
});
