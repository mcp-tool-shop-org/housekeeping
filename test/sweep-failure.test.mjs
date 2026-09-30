// A sweep that dies is still a sweep: data/sweeps.jsonl gets a line for it.
//
// On 2026-09-30 three sweeps threw before a snapshot existed -- two on a lone
// "gh: HTTP 502", one on "unexpected end of JSON input" -- and the log, which
// promises one line per sweep, recorded none of them. These drive the real
// wrapper with a fake pass and a fake writer, so no network and no real log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingFailure, failureReason } from '../src/collect.mjs';

const ctx = () => ({ started: Date.now() - 1000, takenAt: '2026-09-30T14:02:43.000Z',
  stage: 'start', login: 'example-user' });

test('a sweep that throws is recorded as failed, at the pass it died in, and still throws', async () => {
  const lines = [];
  const c = ctx();
  const boom = new Error('Command failed: C:\\Program Files\\GitHub CLI\\gh.exe api graphql '
    + '--input C:\\Temp\\hk-x\\q8.json\ngh: HTTP 502');
  await assert.rejects(
    recordingFailure(c, async () => { c.stage = 'repos'; throw boom; }, l => lines.push(l)),
    e => e === boom);   // the SAME error: recording must not swallow or rewrap it
  assert.equal(lines.length, 1);
  const [l] = lines;
  assert.equal(l.result, 'failed');
  assert.equal(l.stage, 'repos');
  assert.equal(l.error, 'gh: HTTP 502');
  assert.equal(l.at, c.takenAt);
  assert.equal(l.gh_login, 'example-user');
  assert.ok(l.duration_ms >= 1000);
});

test('a sweep that succeeds adds no line of its own', async () => {
  // The success lines ('written', 'duplicate') are written inside the sweep;
  // the wrapper must not add a second one.
  const lines = [];
  const out = await recordingFailure(ctx(), async () => 'snapshot', l => lines.push(l));
  assert.equal(out, 'snapshot');
  assert.deepEqual(lines, []);
});

test('failureReason keeps the line that says why', () => {
  assert.equal(failureReason(new Error('Command failed: gh api graphql --input q0.json\n'
    + 'unexpected end of JSON input')), 'unexpected end of JSON input');
  // A single-line message is its own reason, "Command failed" or not.
  assert.equal(failureReason(new Error('GitHub secondary rate limit hit -- gave up after 5 attempts')),
    'GitHub secondary rate limit hit -- gave up after 5 attempts');
  assert.equal(failureReason(new Error('Command failed: gh api user')), 'Command failed: gh api user');
  assert.equal(failureReason('no repositories visible for org x'), 'no repositories visible for org x');
  assert.equal(failureReason(undefined), 'unknown error');
  assert.equal(failureReason(new Error('x'.repeat(500))).length, 300);
});
