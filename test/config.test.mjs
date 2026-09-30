// The config file: which org a checkout audits and which repos are exempt from
// product-hygiene rules.
//
// `metaRepos` SUPPRESSES findings, so the dangerous direction is a config that
// looks set and is silently ignored. Every malformed shape must throw; only a
// missing file is the defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig, loadConfig, resolveOrg } from '../src/config.mjs';
import { loadSnapshot } from '../src/load.mjs';
import { analyze } from '../src/analyze.mjs';

test('a full config is read as written', () => {
  const c = parseConfig('{ "org": "example-org", "metaRepos": [".github", "design-assets"] }');
  assert.deepEqual(c, { org: 'example-org', metaRepos: ['.github', 'design-assets'] });
});

test('an empty object is the defaults: no org, only .github exempt', () => {
  assert.deepEqual(parseConfig('{}'), { org: null, metaRepos: ['.github'] });
});

test('an explicitly empty metaRepos exempts nothing -- that is a choice, not a typo', () => {
  assert.deepEqual(parseConfig('{ "metaRepos": [] }').metaRepos, []);
});

test('a missing file is the defaults; it is not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hk-config-'));
  assert.deepEqual(loadConfig(join(dir, 'absent.json')), { org: null, metaRepos: ['.github'] });
});

test('a file that exists is parsed, not defaulted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hk-config-'));
  const p = join(dir, 'housekeeping.config.json');
  writeFileSync(p, '{ "org": "example-org" }');
  assert.deepEqual(loadConfig(p), { org: 'example-org', metaRepos: ['.github'] });
});

test('every malformed shape throws rather than falling back', () => {
  const bad = [
    ['{ "org": "example-org", ',            /not valid JSON/],      // truncated
    ['[]',                                   /must be a JSON object/],
    ['null',                                 /must be a JSON object/],
    ['{ "metaRepo": [".github"] }',          /unknown key\(s\): metaRepo/],   // the typo that looks configured
    ['{ "org": "" }',                        /"org" must be/],
    ['{ "org": 7 }',                         /"org" must be/],
    ['{ "metaRepos": ".github" }',           /"metaRepos" must be/],
    ['{ "metaRepos": [".github", 3] }',      /"metaRepos" must be/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseConfig(text), re, text);
});

test('a malformed file throws through loadConfig too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hk-config-'));
  const p = join(dir, 'housekeeping.config.json');
  writeFileSync(p, '{ "metaRepo": [] }');
  assert.throws(() => loadConfig(p), /unknown key/);
});

test('the org comes from the argument first, then the config, and is never guessed', () => {
  const cfg = { org: 'configured-org', metaRepos: [] };
  assert.equal(resolveOrg('given-org', cfg), 'given-org');
  assert.equal(resolveOrg(undefined, cfg), 'configured-org');
  assert.throws(() => resolveOrg(undefined, { org: null, metaRepos: [] }), /no org given/);
});

// ---- the exemption, end to end -------------------------------------------
// A small snapshot through the real loader and the real analyzer: the same
// repo with no README is a finding when it is a product and silent when the
// config calls it a meta repo. Both directions, or the option could be dead.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8');

function noReadme(metaRepos) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const repo = name => ({
    name, id: 'R_' + name, description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    pushedAt: new Date().toISOString(), defaultBranchRef: { name: 'main' },
  });
  const sid = loadSnapshot(db, {
    taken_at: '2026-09-30T00:00:00Z', org: 'org', collector_version: 'test', repo_count: 2, duration_ms: 1,
    repos: [repo('product'), repo('org-defaults')], workflow_files: {}, workflow_runs: [],
  });
  analyze(db, sid, { metaRepos });
  return db.prepare("SELECT repo FROM finding WHERE code = 'NO_README' ORDER BY repo").all().map(r => r.repo);
}

test('a repo named in metaRepos is exempt from hygiene findings; its neighbour is not', () => {
  assert.deepEqual(noReadme(['org-defaults']), ['product']);
});

test('with nothing exempt, the same repo is a finding', () => {
  assert.deepEqual(noReadme([]), ['org-defaults', 'product']);
});
