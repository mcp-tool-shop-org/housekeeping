// The error shape, the exit codes, the read-only query guard and the log levels.
//
// These are the contracts a caller scripts against: an exit code is the only
// thing a shell `&&` reads, and a hint is the only part of an error that says
// what to do. Each is asserted in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT, HkError, userError, structured, exitCodeFor, formatError, readOnlyQuery, sweepGaps,
} from '../src/errors.mjs';
import { LEVELS, parseLevel, levelFromFlags } from '../src/log.mjs';
import { RateLimitError } from '../src/gh.mjs';

test('a classified error carries code, message, hint and retryable, and nothing leaks beside them', () => {
  const e = new HkError('SCHEMA_CHANGED', 'schema changed', { hint: 'run rebuild', retryable: false });
  assert.deepEqual(structured(e), { code: 'SCHEMA_CHANGED', message: 'schema changed', hint: 'run rebuild', retryable: false });
});

test('a cause is carried as text, never as an object with a stack', () => {
  const e = new HkError('X', 'outer', { cause: new Error('inner detail') });
  assert.equal(structured(e).cause, 'inner detail');
});

test('throttling from the transport is classified, retryable, and says which limit', () => {
  const primary = structured(new RateLimitError('primary', 60000, 'core 3/5000'));
  assert.equal(primary.code, 'RATE_LIMITED');
  assert.equal(primary.retryable, true);
  assert.match(primary.hint, /quota/);
  assert.match(structured(new RateLimitError('secondary', 0)).hint, /burst/);
});

test('an unclassified error is UNEXPECTED, not retryable, and points at --debug', () => {
  const s = structured(new TypeError('x is not a function'));
  assert.deepEqual(s, { code: 'UNEXPECTED', message: 'x is not a function', hint: 're-run with --debug for the stack trace', retryable: false });
  assert.equal(structured('a thrown string').message, 'a thrown string');
});

test('exit codes: a user error is 1, everything else that throws is 2', () => {
  assert.equal(exitCodeFor(userError('USAGE', 'bad')), EXIT.USER);
  assert.equal(exitCodeFor(new HkError('SCHEMA_CHANGED', 'x')), EXIT.RUNTIME);
  assert.equal(exitCodeFor(new Error('boom')), EXIT.RUNTIME);
  assert.equal(exitCodeFor(new RateLimitError('secondary', 0)), EXIT.RUNTIME);
  assert.deepEqual([EXIT.OK, EXIT.USER, EXIT.RUNTIME, EXIT.PARTIAL], [0, 1, 2, 3]);
});

test('the printed error has no stack unless debug asks for one', () => {
  const e = userError('USAGE', 'unknown command "x"', '`hk help` lists the commands');
  assert.equal(formatError(e), 'error [USAGE] unknown command "x"\nhint: `hk help` lists the commands');
  assert.doesNotMatch(formatError(new Error('boom')), /\n\s+at /);
  assert.match(formatError(new Error('boom'), { debug: true }), /\n\s+at /);
});

test('the read-only guard admits one SELECT or WITH and returns it without its semicolon', () => {
  assert.equal(readOnlyQuery('  SELECT 1;  '), 'SELECT 1');
  assert.equal(readOnlyQuery('with t as (select 1) select * from t'), 'with t as (select 1) select * from t');
});

test('the read-only guard refuses everything else', () => {
  const refused = ['DELETE FROM finding', 'UPDATE repo SET name = 1', 'DROP TABLE repo', 'PRAGMA writable_schema = 1',
    'INSERT INTO meta VALUES (1, 2)', 'ATTACH DATABASE "x" AS y', 'selectx', 'SELECT 1; DELETE FROM finding'];
  for (const q of refused) {
    assert.throws(() => readOnlyQuery(q), e => e.code === 'SQL_REFUSED' && e.exit === EXIT.USER, q);
  }
  assert.throws(() => readOnlyQuery('   '), e => e.code === 'USAGE');
});

test('a sweep with nothing missing has no gaps', () => {
  assert.deepEqual(sweepGaps({ errors: [], run_costs: { budget_hit: false } }), []);
  assert.deepEqual(sweepGaps({}), [], 'an older snapshot with neither field');
});

test('a sweep with collection errors or an exhausted cost budget is partial, and says why', () => {
  assert.match(sweepGaps({ errors: [{ repo: 'r', stage: 'runs' }] })[0], /1 collection error/);
  assert.match(sweepGaps({ errors: [], run_costs: { budget_hit: true } })[0], /ran out of budget/);
  assert.equal(sweepGaps({ errors: [{}, {}], run_costs: { budget_hit: true } }).length, 2);
});

test('log levels: the default is normal, and an unknown name is an error, not a default', () => {
  assert.deepEqual(LEVELS, ['silent', 'normal', 'verbose', 'debug']);
  assert.equal(parseLevel(undefined), 'normal');
  assert.equal(parseLevel(''), 'normal');
  assert.equal(parseLevel('DEBUG'), 'debug');
  assert.throws(() => parseLevel('loud'), e => e.code === 'CONFIG_INVALID' && /silent, normal, verbose, debug/.test(e.hint));
});

test('log flags: the loudest wins, and no flag means no override', () => {
  assert.equal(levelFromFlags(new Set()), null);
  assert.equal(levelFromFlags(new Set(['--quiet'])), 'silent');
  assert.equal(levelFromFlags(new Set(['--verbose'])), 'verbose');
  assert.equal(levelFromFlags(new Set(['--quiet', '--debug'])), 'debug');
});
