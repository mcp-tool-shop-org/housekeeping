// Thin transport over the already-authenticated `gh` CLI.
// Deliberately NOT a new MCP server: `gh` already holds the org-scoped token,
// so sourcing it avoids minting/storing any new credential in this repo.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verbose } from './log.mjs';

const pexec = promisify(execFile);
const TMP = mkdtempSync(join(tmpdir(), 'hk-'));
let GH = null;

export function resolveGh() {
  if (GH) return GH;
  if (process.env.GH_PATH) return (GH = process.env.GH_PATH);
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['gh'], {
      encoding: 'utf8', shell: true,
    });
    GH = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  } catch { GH = 'gh'; }
  return GH;
}

const MAX_BUF = 64 * 1024 * 1024;
let seq = 0;

// ---- rate limiting ------------------------------------------------------
//
// GitHub enforces two limits and they fail very differently.
//
//   PRIMARY   a per-account hourly quota. Visible in `rate_limit`, resets on a
//             known clock. Waiting it out can mean an hour, so we surface it
//             rather than sleep.
//   SECONDARY burst/concurrency. NOT visible in `rate_limit` -- on 2026-09-17 a
//             sweep took a hard 403 "API rate limit exceeded" while that
//             endpoint still reported core 5000/5000. Short-lived, so we back
//             off and retry.
//
// The message text does not reliably distinguish them: the secondary limit also
// says "API rate limit exceeded". So the quota is what disambiguates -- if the
// quota is healthy and we were refused anyway, it was secondary.
//
// The failure that actually costs you is neither of these: it is a throttled
// call being read as an empty result. A 403 misread as "this repo has no
// dependabot.yml" inverts a finding. Every path here THROWS rather than
// returning a value a caller could mistake for data.

const RATE_LIMIT_TEXT = /rate limit|abuse detection|secondary rate|too many requests/i;
const RETRY_AFTER = /retry-after:\s*(\d+)/i;

export class RateLimitError extends Error {
  constructor(kind, waitMs, detail) {
    super(`GitHub ${kind} rate limit hit${waitMs ? `; retry in ${Math.ceil(waitMs / 1000)}s` : ''}${detail ? ` -- ${detail}` : ''}`);
    this.name = 'RateLimitError';
    this.kind = kind;          // 'primary' | 'secondary'
    this.waitMs = waitMs;
    this.isRateLimit = true;
  }
}

/** Does this failure look like throttling? Pure, so it is unit-testable. */
export function looksRateLimited(text) {
  return RATE_LIMIT_TEXT.test(String(text ?? ''));
}

// A gateway error is GitHub failing, not GitHub answering: nothing was read, so
// a retry cannot double-count anything, and every call here is a read. Two
// sweeps on 2026-09-30 each died on a lone "gh: HTTP 502" at a different page,
// and a third on "unexpected end of JSON input" -- gh's wording for a body cut
// off mid-stream, the same server-side timeout arriving by a different road.
const TRANSIENT_TEXT = /HTTP 50[234]\b|unexpected end of JSON input/;

/** Does this failure look like a transient gateway error? Pure. */
export function looksTransient(text) {
  return TRANSIENT_TEXT.test(String(text ?? ''));
}

/** Exponential backoff with jitter. Pure. */
export function backoffMs(attempt, base = 2000, cap = 60000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Current quota. `rate_limit` is explicitly exempt, so this is free to call. */
export async function budget() {
  const { stdout } = await pexec(resolveGh(), ['api', 'rate_limit'], {
    maxBuffer: 1 << 20, windowsHide: true,
  });
  const d = JSON.parse(stdout).resources;
  return { core: d.core, graphql: d.graphql, checkedAt: Date.now() };
}

/**
 * Refuse to start a sweep that the remaining quota cannot finish.
 * A full collect costs roughly 90 GraphQL points and 80+ REST calls; running it
 * at low headroom produces a half-collected snapshot, which is worse than none
 * because `load.mjs` will happily store it.
 */
export async function preflight({ rest: needRest = 200, graphql: needGraphql = 200 } = {}) {
  const b = await budget().catch(() => null);
  if (!b) return { ok: true, unknown: true };      // never block on an unreadable probe

  const quotaOk = b.core.remaining >= needRest && b.graphql.remaining >= needGraphql;
  const out = {
    ok: quotaOk,
    unknown: false,
    limit: quotaOk ? null : 'primary',
    core: b.core.remaining,
    graphql: b.graphql.remaining,
    resetsInS: Math.max(0, Math.round(b.core.reset - Date.now() / 1000)),
  };
  if (!quotaOk) return out;

  // The quota says nothing about the SECONDARY limit, which is the one that
  // actually stops a sweep. Verified live on 2026-09-17: this function returned
  // core 5000/5000 while the very next real request came back 403 "API rate
  // limit exceeded". A quota check alone would have waved the sweep into a wall.
  //
  // Only a real request can detect it, so spend exactly one. `rate_limit` is
  // exempt and therefore useless as a canary; `user` is the cheapest endpoint
  // that is not.
  try {
    await pexec(resolveGh(), ['api', 'user', '--jq', '.login'], {
      maxBuffer: 1 << 20, windowsHide: true,
    });
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
    if (looksRateLimited(text)) {
      return { ...out, ok: false, limit: 'secondary' };
    }
    // Anything else (auth, network) is not ours to judge -- let the sweep try
    // and fail with its own error rather than blocking on a guess.
  }
  return out;
}

/**
 * Run `gh` with retry on throttling. Primary exhaustion throws immediately
 * (waiting could be an hour); secondary backs off and retries.
 */
async function ghExec(args, { retries = 4, maxBuffer = MAX_BUF } = {}) {
  // The subcommand and its target only. A GraphQL body lives in a temp file
  // and is never echoed; `gh` holds the token, so no argument here can be one.
  verbose('[gh]', args.slice(0, 2).join(' '));
  for (let attempt = 0; ; attempt++) {
    try {
      return await pexec(resolveGh(), args, { maxBuffer, windowsHide: true });
    } catch (e) {
      const text = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
      if (looksTransient(text) && attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!looksRateLimited(text)) throw e;

      const b = await budget().catch(() => null);
      if (b && b.core.remaining < 50) {
        const waitMs = Math.max(0, b.core.reset * 1000 - Date.now());
        throw new RateLimitError('primary', waitMs, `core ${b.core.remaining}/${b.core.limit}`);
      }
      if (attempt >= retries) {
        throw new RateLimitError('secondary', 0, `gave up after ${retries + 1} attempts`);
      }
      const hinted = RETRY_AFTER.exec(text);
      await sleep(hinted ? Number(hinted[1]) * 1000 : backoffMs(attempt));
    }
  }
}


/** POST a GraphQL document. Body goes through a temp file so query size is unbounded. */
export async function graphql(query, variables = {}) {
  const file = join(TMP, `q${seq++}.json`);
  writeFileSync(file, JSON.stringify({ query, variables }));
  const { stdout } = await ghExec(['api', 'graphql', '--input', file]);
  const body = JSON.parse(stdout);
  // GraphQL returns 200 with partial data + errors. Surface them, keep the data.
  if (body.errors?.length) {
    const fatal = !body.data;
    const msg = body.errors.map(e => e.message).join('; ');
    if (fatal) throw new Error(`GraphQL: ${msg}`);
    body._softErrors = msg;
  }
  return body;
}

export async function rest(path) {
  const { stdout } = await ghExec(['api', path, '--cache', '0']);
  return JSON.parse(stdout);
}

// Paginated GET. `gh api --paginate` merges top-level JSON arrays, which is
// what every endpoint we page over returns. Read-only, like rest().
export async function restPaged(path) {
  const { stdout } = await ghExec(['api', path, '--paginate', '--cache', '0']);
  return JSON.parse(stdout);
}

// Some GitHub endpoints answer with a bare 204 or 404 and no body, so neither
// rest() nor restPaged() can read them: JSON.parse('') throws either way, which
// makes "enabled" and "disabled" indistinguishable. Return the status instead.
export async function restStatus(path) {
  try {
    const { stdout } = await ghExec(['api', path, '-i', '--cache', '0']);
    const m = /^HTTP\/[\d.]+ (\d{3})/m.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch (e) {
    // A throttled probe is NOT a 404. Returning null here would tell the caller
    // "this endpoint says disabled", which is how a rate limit becomes a wrong
    // finding. Let it propagate.
    if (e.isRateLimit) throw e;
    const m = /^HTTP\/[\d.]+ (\d{3})/m.exec(String(e.stdout ?? '') + String(e.stderr ?? ''));
    return m ? Number(m[1]) : null;
  }
}

/**
 * Split `gh api -i` output into its status and its JSON body. Pure.
 *
 * `-i` prints the status line, the headers, a blank line, then the body; on a
 * non-2xx answer gh also appends its own "gh: Not Found (HTTP 404)" line after
 * the body, which is not part of the JSON. The body is parsed up to its last
 * closing brace or bracket so that line is dropped. A body that does not parse
 * comes back as null beside its status: the status is still an answer.
 */
export function parseIncluded(text) {
  const s = String(text ?? '');
  const m = /^HTTP\/[\d.]+ (\d{3})/m.exec(s);
  if (!m) return { status: null, body: null };
  const split = /\r?\n\r?\n/.exec(s.slice(m.index));
  let body = null;
  if (split) {
    const rest = s.slice(m.index + split.index + split[0].length);
    const end = Math.max(rest.lastIndexOf('}'), rest.lastIndexOf(']'));
    if (end >= 0) {
      try { body = JSON.parse(rest.slice(0, end + 1)); } catch { body = null; }
    }
  }
  return { status: Number(m[1]), body };
}

/**
 * GET that answers with its status and body instead of throwing on a non-2xx.
 *
 * Needed where a 404 IS the observation: `repos/{r}/pages` answers 404 when
 * Pages is off, which rest() cannot tell from a missing repository or a
 * permissions problem. The caller decides what each status means; a status of
 * null (no HTTP answer at all) must be read as unknown. Throttling still throws,
 * for the reason restStatus() gives.
 */
export async function restWithStatus(path) {
  try {
    const { stdout } = await ghExec(['api', path, '-i', '--cache', '0']);
    return parseIncluded(stdout);
  } catch (e) {
    if (e.isRateLimit) throw e;
    return parseIncluded(String(e.stdout ?? '') + String(e.stderr ?? ''));
  }
}

export function whoami() {
  try {
    return execFileSync(resolveGh(), ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

/** Bounded-concurrency map that never rejects: failures come back as {error}. */
export async function pMap(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = { ok: true, value: await fn(items[idx], idx) }; }
      catch (e) { out[idx] = { ok: false, error: e.message?.slice(0, 400) ?? String(e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}
