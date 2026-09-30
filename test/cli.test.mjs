// The CLI from the outside: what it prints, where, and the code it exits with.
//
// Each case spawns the real `src/cli.mjs` against a throwaway database (HK_DB)
// and a config path that does not exist (HK_CONFIG), so nothing here touches
// the network, the repository's data, or its config. `refresh` is reached only
// through paths that fail before the first GitHub call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

/** A fresh sandbox: its own database path and an absent config. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hk-cli-'));
  const env = { ...process.env, HK_DB: join(dir, 'hk.db'), HK_CONFIG: join(dir, 'absent.json'), NODE_NO_WARNINGS: '1' };
  delete env.HK_LOG;
  const hk = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, db: env.HK_DB, hk };
}

/** The smallest snapshot the loader accepts: one public repo with no README. */
function tinySnapshot(dir) {
  const file = join(dir, 'tiny.json');
  writeFileSync(file, JSON.stringify({
    taken_at: '2026-09-30T00:00:00Z', org: 'example-org', collector_version: 'test', repo_count: 1, duration_ms: 1,
    repos: [{
      name: 'repo-a', id: 'R_1', description: 'x', isPrivate: false, isArchived: false, isEmpty: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
      pushedAt: '2026-09-29T00:00:00Z', defaultBranchRef: { name: 'main' },
    }],
    workflow_files: {}, workflow_runs: [],
  }));
  return file;
}

const commandsIn = help => [...help.matchAll(/^ {2}hk ([a-z-]+)/gm)].map(m => m[1]);

test('help prints to stdout, exits 0, and does not create a database', () => {
  const s = sandbox();
  const r = s.hk(['help']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.out, /^housekeeping - /);
  assert.match(r.out, /Exit codes: 0 ok, 1 user error, 2 runtime error, 3 partial/);
  assert.equal(existsSync(s.db), false);
});

test('--help and -h are the same text, on any command', () => {
  const s = sandbox();
  const help = s.hk(['help']).out;
  assert.equal(s.hk(['--help']).out, help);
  assert.equal(s.hk(['-h']).out, help);
  assert.equal(s.hk(['findings', '--help']).out, help);
});

test('every command the help lists exists, and every flag it lists is accepted', () => {
  const s = sandbox();
  const names = commandsIn(s.hk(['help']).out);
  assert.ok(names.length >= 19, `help lists ${names.length} commands`);
  // Arguments chosen so that no command reaches the network or the repo's data:
  // with no org configured `refresh` stops at NO_ORG, and `load` is given a
  // file that does not exist.
  const safeArgs = { load: ['no-such-snapshot.json'], sql: ['SELECT 1 AS one'], repo: ['repo-a'] };
  for (const name of names) {
    const r = s.hk([name, ...(safeArgs[name] ?? [])]);
    assert.doesNotMatch(r.err, /unknown command/, `hk ${name} is in the help but does not dispatch`);
    assert.ok([0, 1].includes(r.code), `hk ${name} exited ${r.code}: ${r.err}`);
  }
  for (const flag of ['--quiet', '--verbose', '--debug']) {
    assert.equal(s.hk(['sql', 'SELECT 1 AS one', flag]).code, 0, flag);
  }
});

test('an unknown command is a user error: exit 1, a code, a hint, no stack', () => {
  const r = sandbox().hk(['frobnicate']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err.trim(), 'error [USAGE] unknown command "frobnicate"\nhint: `hk help` lists the commands');
});

test('querying before any snapshot is loaded is a user error with the fix in the hint', () => {
  const s = sandbox();
  for (const cmd of ['summary', 'ci', 'findings', 'report']) {
    const r = s.hk([cmd]);
    assert.equal(r.code, 1, cmd);
    assert.match(r.err, /^error \[NO_SNAPSHOT\] /, cmd);
    assert.match(r.err, /hint: run `hk refresh`/, cmd);
  }
  assert.equal(s.hk([]).code, 1, 'no command means summary');
});

test('refresh with no org refuses before any network call', () => {
  const r = sandbox().hk(['refresh']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error \[NO_ORG\] no org given\nhint: pass one/);
});

test('a malformed config is a user error, not a silent default', () => {
  const s = sandbox();
  const cfg = join(s.dir, 'bad.json');
  writeFileSync(cfg, '{ "metaRepo": [] }');
  const r = s.hk(['refresh'], { HK_CONFIG: cfg });
  assert.equal(r.code, 1);
  assert.match(r.err, /^error \[CONFIG_INVALID\] .*unknown key\(s\): metaRepo/);
});

test('a mistyped HK_LOG is reported before any work starts', () => {
  const r = sandbox().hk(['--help'], { HK_LOG: 'loud' });
  assert.equal(r.code, 0, '--help never reads the level, so it still works');
  const q = sandbox().hk(['snapshots'], { HK_LOG: 'loud' });
  assert.equal(q.code, 1);
  assert.match(q.err, /^error \[CONFIG_INVALID\] unknown log level "loud"/);
});

test('sql runs one read-only statement and refuses anything that writes', () => {
  const s = sandbox();
  const ok = s.hk(['sql', 'SELECT 1 AS one']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^one\n-+\n1\s*\n$/);
  for (const q of ['DELETE FROM finding', 'DROP TABLE repo', 'SELECT 1; DELETE FROM finding']) {
    const r = s.hk(['sql', q]);
    assert.equal(r.code, 1, q);
    assert.match(r.err, /^error \[SQL_REFUSED\] /, q);
  }
  const bad = s.hk(['sql', 'SELECT nope FROM nowhere']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^error \[SQL_FAILED\] /);
  assert.equal(s.hk(['sql']).code, 1, 'no query at all');
});

test('a database built against a different schema is a runtime error: exit 2, with the repair', () => {
  const s = sandbox();
  assert.equal(s.hk(['snapshots']).code, 0);              // creates the database
  const db = new DatabaseSync(s.db);
  db.prepare("UPDATE meta SET value = 'stale' WHERE key = 'schema_fingerprint'").run();
  db.close();
  const r = s.hk(['snapshots']);
  assert.equal(r.code, 2);
  assert.match(r.err, /^error \[SCHEMA_CHANGED\] /);
  assert.match(r.err, /hint: .*npm run rebuild/);
});

test('a stack trace appears only with --debug', () => {
  const s = sandbox();
  assert.doesNotMatch(s.hk(['frobnicate']).err, /\n\s+at /);
  assert.match(s.hk(['frobnicate', '--debug']).err, /\n\s+at /);
});

test('with a snapshot loaded, the query commands work and print to stdout', () => {
  const s = sandbox();
  const load = s.hk(['load', tinySnapshot(s.dir)]);
  assert.equal(load.code, 0, load.err);
  assert.match(load.err, /\[load\] snapshot 1 <- /);
  assert.equal(load.out, '');

  const summary = s.hk(['summary']);
  assert.equal(summary.code, 0);
  assert.match(summary.out, /org=example-org/);

  const findings = s.hk(['findings']);
  assert.match(findings.out, /NO_README/, 'the loaded repo has no README and is not a meta repo');

  assert.equal(s.hk(['repo', 'repo-a']).code, 0);
  const noName = s.hk(['repo']);
  assert.equal(noName.code, 1);
  assert.match(noName.err, /^error \[USAGE\] `hk repo` needs a repository name/);
});

test('--quiet silences progress lines and never the result', () => {
  const s = sandbox();
  const quiet = s.hk(['load', tinySnapshot(s.dir), '--quiet']);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.err, '');
  assert.match(s.hk(['summary', '--quiet']).out, /org=example-org/);
});

test('a snapshot file that cannot be read is a user error naming the file', () => {
  const s = sandbox();
  const r = s.hk(['load', join(s.dir, 'missing.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error \[SNAPSHOT_UNREADABLE\] cannot read a snapshot from .*missing\.json/);
});
