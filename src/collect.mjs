#!/usr/bin/env node
// Collect a full operational snapshot of a GitHub org into data/snapshots/<ts>.json
// Raw JSON is the source of truth (diffable, replayable); the SQLite DB is derived.
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { graphql, rest, restPaged, restStatus, restWithStatus, pMap, whoami, looksTransient } from './gh.mjs';
import { resolveOrg } from './config.mjs';
import { packageMapFromLockfile, advisoriesFromBulk, countBySeverity, lockfilePathsFromTree, devOnlyPackages } from './lockfile.mjs';
import { priceRun, ratesFromUsage, withFallback, runnerClass } from './cost.mjs';
import { pagesDeployJobs, jobEnvironment } from './workflow-risks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COLLECTOR_VERSION = '1.3.0';

const REPO_FIELDS = `
  id name description url homepageUrl
  isPrivate isArchived isFork isTemplate isEmpty
  createdAt updatedAt pushedAt diskUsage
  stargazerCount forkCount
  watchers { totalCount }
  hasIssuesEnabled hasWikiEnabled hasDiscussionsEnabled
  primaryLanguage { name }
  licenseInfo { spdxId }
  repositoryTopics(first:25) { nodes { topic { name } } }
  languages(first:10, orderBy:{field:SIZE, direction:DESC}) { totalSize edges { size node { name } } }
  openIssues:     issues(states:OPEN)         { totalCount }
  closedIssues:   issues(states:CLOSED)       { totalCount }
  openPRsCount:   pullRequests(states:OPEN)   { totalCount }
  mergedPRsCount: pullRequests(states:MERGED) { totalCount }
  closedPRsCount: pullRequests(states:CLOSED) { totalCount }
  issueList: issues(states:OPEN, first:30, orderBy:{field:CREATED_AT, direction:ASC}) {
    nodes { number title createdAt updatedAt url
            comments { totalCount } author { login }
            labels(first:10) { nodes { name } } }
  }
  prList: pullRequests(states:OPEN, first:50, orderBy:{field:CREATED_AT, direction:ASC}) {
    nodes { number title createdAt updatedAt url isDraft mergeable reviewDecision
            additions deletions changedFiles headRefName baseRefName
            author { login } labels(first:10) { nodes { name } }
            # The head commit's rollup. Required contexts absent HERE but
            # present on the default branch are the paths-gated case: the job
            # exists and runs, just not for this PR's file set.
            commits(last:1) { nodes { commit { statusCheckRollup {
              state
              contexts(first:100) { totalCount nodes {
                __typename
                ... on CheckRun      { name conclusion }
                ... on StatusContext { context state }
              } }
            } } } } }
  }
  releases(first:10, orderBy:{field:CREATED_AT, direction:DESC}) {
    totalCount nodes { tagName name publishedAt isLatest isDraft isPrerelease }
  }
  tags: refs(refPrefix:"refs/tags/", first:30, orderBy:{field:TAG_COMMIT_DATE, direction:DESC}) {
    totalCount
    nodes { name target { __typename ... on Commit { committedDate } ... on Tag { tagger { date } } } }
  }
  # requiredStatusCheckContexts is the list branch protection GATES on; the
  # rollup beneath it is what CI actually REPORTED on that same commit. A
  # context in the first list and in neither rollup is a gate nothing can
  # satisfy: every per-run view still reads green, and every PR is BLOCKED
  # forever. Both sides come from this one query, so the pairing is free.
  defaultBranchRef {
    name
    branchProtectionRule {
      requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts
    }
    target { ... on Commit { oid committedDate statusCheckRollup {
      state
      contexts(first:100) { totalCount nodes {
        __typename
        ... on CheckRun      { name conclusion }
        ... on StatusContext { context state }
      } }
    } } }
  }
  rootTree: object(expression:"HEAD:")                  { ... on Tree { entries { name type } } }
  wfTree:   object(expression:"HEAD:.github/workflows") { ... on Tree { entries { name type } } }
  ghTree:   object(expression:"HEAD:.github")           { ... on Tree { entries { name type } } }
  pkg:      object(expression:"HEAD:package.json")      { ... on Blob { text byteSize isTruncated } }
  # Read, don't just count: pnpm 11 writes pnpm-workspace.yaml into
  # single-package repos to hold settings, so only a packages: key proves a
  # workspace. Sibling fields in the same query -- no extra round trip. Both
  # spellings are fetched because both are in WORKSPACE_MARKERS.
  # (No backticks in here: this fragment is a JS template literal.)
  pnpmWs:    object(expression:"HEAD:pnpm-workspace.yaml") { ... on Blob { text } }
  pnpmWsYml: object(expression:"HEAD:pnpm-workspace.yml")  { ... on Blob { text } }
  # The handbook site's sidebar shape and the Starlight version it is declared
  # against. Both are needed because neither is a defect alone: Starlight 0.39
  # removed the top-level autogenerate key on a labelled group and added the
  # nested items form, so each shape is correct for exactly one side of that
  # boundary and wrong for the other. Sibling fields in the same query.
  # (No backticks in here: this fragment is a JS template literal.)
  siteAstroCfg: object(expression:"HEAD:site/astro.config.mjs") { ... on Blob { text byteSize isTruncated } }
  sitePkg:      object(expression:"HEAD:site/package.json")     { ... on Blob { text } }
  # The committed Atlas map, by id only: maps run to megabytes, so its content
  # is fetched in the atlas pass and only when this id is not already cached.
  # null here means no such file on the default branch.
  atlasMap: object(expression:"HEAD:atlas/structure.json") { ... on Blob { oid byteSize } }
`;

const PAGE_QUERY = `
query($owner:String!, $n:Int!, $cursor:String) {
  rateLimit { remaining cost resetAt }
  organization(login:$owner) {
    repositories(first:$n, after:$cursor, orderBy:{field:NAME, direction:ASC}, ownerAffiliations:OWNER) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes { ${REPO_FIELDS} }
    }
  }
}`;

const log = (...a) => console.error('[collect]', ...a);

export function safeJson(t) {
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

// Fields that differ on every sweep no matter what the org did. They are
// excluded from the content fingerprint ONLY -- the snapshot itself always
// carries them. `collector_version` and `gh_login` are deliberately NOT here:
// a different collector, or a different token's visibility, produces a
// genuinely different observation even when the bytes look similar.
const VOLATILE_FIELDS = new Set(['taken_at', 'duration_ms', 'rate_limit_remaining']);

/**
 * Serialise with object keys sorted recursively, arrays left in order.
 *
 * Needed because key order in the snapshot is not stable across sweeps. The
 * lockfile pass builds its result as an object keyed by repo and fills it from
 * `pMap` at concurrency 6, so keys land in COMPLETION order -- two sweeps that
 * observed exactly the same org can serialise the same data in a different
 * order. Hashing raw `JSON.stringify` output would then report every sweep as
 * changed and the dedupe guard would never fire. Array order is left alone: it
 * is meaningful everywhere it appears here, and reordering would hide real
 * drift.
 *
 * `undefined` is handled the way JSON.stringify does -- dropped from objects,
 * rendered as null in arrays -- so the fingerprint matches what gets written.
 */
export function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalJson(v) ?? 'null').join(',') + ']';
  }
  const parts = [];
  for (const k of Object.keys(value).sort()) {
    const v = canonicalJson(value[k]);
    if (v !== undefined) parts.push(JSON.stringify(k) + ':' + v);
  }
  return '{' + parts.join(',') + '}';
}

/** Content identity of a snapshot: everything the sweep observed, nothing about when. */
export function snapshotFingerprint(snapshot) {
  const stable = {};
  for (const [k, v] of Object.entries(snapshot ?? {})) {
    if (!VOLATILE_FIELDS.has(k)) stable[k] = v;
  }
  return createHash('sha256').update(canonicalJson(stable) ?? 'null').digest('hex');
}

/** Newest snapshot already on disk, or null. Filenames are ISO-derived, so they sort. */
function latestSnapshotOnDisk(dir) {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    return files.length ? join(dir, files.at(-1)) : null;
  } catch { return null; }
}

// Every sweep appends one line here whether or not it produced a snapshot. This
// is what keeps the append-only rule honest while skipping a duplicate write:
// the 9 MB payload is dropped, the fact that we looked is not.
const SWEEP_LOG = join(ROOT, 'data', 'sweeps.jsonl');

function recordSweep(entry) {
  try { appendFileSync(SWEEP_LOG, JSON.stringify(entry) + '\n'); }
  catch (e) { log(`WARNING could not append to sweeps.jsonl: ${e.message}`); }
}

// A failing gh call's message opens with the command line ("Command failed:
// ...gh.exe api graphql --input <temp file>") and says why only on its last
// line ("gh: HTTP 502"). Keep the line that says why.
export function failureReason(e) {
  const lines = String(e?.message ?? e ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const why = /^Command failed:/.test(lines[0] ?? '') && lines.length > 1 ? lines.at(-1) : lines[0];
  return (why ?? 'unknown error').slice(0, 300);
}

/**
 * Run a sweep so that dying is recorded too. Three sweeps on 2026-09-30 threw
 * before a snapshot existed and left no line at all, which broke "every sweep
 * appends one line" exactly when the log mattered: a sweep that failed is the
 * one you most want to know was attempted. The error is rethrown untouched --
 * recording a failure must never turn it into a success.
 */
export async function recordingFailure(ctx, fn, record = recordSweep) {
  try {
    return await fn();
  } catch (e) {
    record({
      at: ctx.takenAt, result: 'failed', stage: ctx.stage, error: failureReason(e),
      duration_ms: Date.now() - ctx.started, collector_version: COLLECTOR_VERSION,
      ...(ctx.login ? { gh_login: ctx.login } : {}),
    });
    throw e;
  }
}

/** Pass 1 - every repo's metadata, open issues, open PRs, releases, trees, package.json. */
async function collectRepos(org, pageSize = 8) {
  const repos = [];
  let cursor = null, page = 0, total = null, rl = null;
  // for(;;), not do/while: `continue` in a do/while re-tests `cursor`, which is
  // null on page 1, so a retry of the first page would end the sweep empty.
  for (;;) {
    // A page that keeps timing out server-side is too heavy, not unlucky: the
    // transport has already retried it. Halve and re-ask from the same cursor,
    // so no repo is skipped. Only the first page's size is fixed by the caller.
    let body;
    try {
      body = await graphql(PAGE_QUERY, { owner: org, n: pageSize, cursor });
    } catch (e) {
      if (!looksTransient(e.message) || pageSize === 1) throw e;
      pageSize = Math.max(1, pageSize >> 1);
      log(`  page timed out; retrying at ${pageSize} repos/page`);
      continue;
    }
    const conn = body.data?.organization?.repositories;
    if (!conn) throw new Error(`no repositories visible for org ${org}`);
    rl = body.data.rateLimit;
    if (total === null) total = conn.totalCount;
    repos.push(...conn.nodes.filter(Boolean));
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    log(`page ${++page}: ${repos.length}/${total} repos (rateLimit ${rl.remaining} left)`);
    if (body._softErrors) log('  soft errors:', body._softErrors);
    if (!cursor) break;
  }
  return { repos, total, rateLimit: rl };
}

/** Pass 2 - raw YAML for every workflow file, batched via aliased GraphQL (no per-file REST). */
async function collectWorkflowFiles(org, repos, batchSize = 6) {
  const targets = repos
    .map(r => ({
      name: r.name,
      files: (r.wfTree?.entries ?? [])
        .filter(e => e.type === 'blob' && /\.ya?ml$/i.test(e.name))
        .map(e => e.name),
    }))
    .filter(t => t.files.length);

  const out = new Map();
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const parts = batch.map((t, ri) => {
      const files = t.files.slice(0, 12).map((f, fi) =>
        `f${fi}: object(expression:"HEAD:.github/workflows/${f}") { ... on Blob { text byteSize } }`
      ).join('\n      ');
      return `r${ri}: repository(owner:$owner, name:${JSON.stringify(t.name)}) {\n      ${files}\n    }`;
    });
    const body = await graphql(`query($owner:String!){\n  ${parts.join('\n  ')}\n}`, { owner: org });
    batch.forEach((t, ri) => {
      const node = body.data?.[`r${ri}`];
      if (!node) return;
      const files = t.files.slice(0, 12).map((f, fi) => ({
        path: `.github/workflows/${f}`,
        name: f,
        text: node[`f${fi}`]?.text ?? null,
        byteSize: node[`f${fi}`]?.byteSize ?? 0,
      })).filter(f => f.text);
      out.set(t.name, files);
    });
    log(`workflow files: ${Math.min(i + batchSize, targets.length)}/${targets.length} repos`);
  }
  return out;
}

const shape = (repo, w) => ({
  repo,
  workflow_name: w.name,
  path: w.path,
  run_id: w.id,
  run_number: w.run_number,
  event: w.event,
  status: w.status,
  conclusion: w.conclusion,
  branch: w.head_branch,
  created_at: w.created_at,
  updated_at: w.updated_at,
  url: w.html_url,
});

/**
 * The 30-run window is the N most recent runs across ALL of a repo's workflows,
 * so a workflow that broke and was then abandoned falls out of it entirely and
 * its redness becomes invisible. A repo was reported CI-clean while two of its
 * workflows had been failing on main for seven months -- caught by
 * test/verify-findings.mjs.
 *
 * Fill only the holes: one targeted call per workflow the window did not observe
 * on the default branch. A repo with chatty CI costs nothing extra, and the
 * default-branch claim stops depending on how busy its neighbours were.
 */
async function backfillDefaultBranchRuns(org, repo, branch, wfFiles, seenPaths, cap = 12) {
  const gaps = wfFiles.filter(f => !seenPaths.has(f)).slice(0, cap);
  const found = [];
  for (const file of gaps) {
    try {
      const data = await rest(
        `repos/${org}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs`
        + `?branch=${encodeURIComponent(branch)}&per_page=1`);
      const w = (data.workflow_runs ?? [])[0];
      if (w) found.push(shape(repo, w));
    } catch { /* workflow never registered, or deleted upstream: nothing to claim */ }
  }
  return found;
}

/** Pass 3 - recent Actions runs. GraphQL has no Actions surface, so REST is the only path. */
async function collectRuns(org, repos, concurrency = 10) {
  const live = repos.filter(r => !r.isEmpty && (r.wfTree?.entries?.length ?? 0) > 0);
  const results = await pMap(live, async r => {
    const data = await rest(`repos/${org}/${r.name}/actions/runs?per_page=30`);
    const window = (data.workflow_runs ?? []).map(w => shape(r.name, w));
    const branch = r.defaultBranchRef?.name;
    if (!branch) return window;
    const wfFiles = (r.wfTree?.entries ?? [])
      .filter(e => e.type === 'blob' && /\.ya?ml$/i.test(e.name)).map(e => e.name);
    const seen = new Set(window
      .filter(x => x.branch === branch)
      .map(x => (x.path ?? '').split('/').pop()));
    const extra = await backfillDefaultBranchRuns(org, r.name, branch, wfFiles, seen);
    return window.concat(extra);
  }, concurrency);
  log(`actions runs: ${results.filter(r => r.ok).length}/${live.length} repos ok`);
  const runs = [], errors = [];
  results.forEach((res, i) => {
    if (res.ok) runs.push(...res.value);
    else errors.push({ repo: live[i].name, stage: 'actions_runs', message: res.error });
  });
  return { runs, errors };
}

/**
 * What a repo's workflows need from its settings, read from the workflow text
 * the sweep already holds. Pure. Parse failures are skipped: a file GitHub
 * cannot parse deploys nothing, and WF_PARSE_ERROR already reports it.
 */
export function deployNeeds(files) {
  let pages = false;
  const envs = new Map();                       // lower-cased -> as written
  for (const f of files ?? []) {
    let doc;
    try { doc = parseYaml(f.text, { logLevel: 'silent' }); } catch { continue; }
    if (!doc || typeof doc !== 'object') continue;
    const jobs = doc.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs)
      ? Object.entries(doc.jobs) : [];
    if (pagesDeployJobs(jobs).length) pages = true;
    for (const [, job] of jobs) {
      const name = jobEnvironment(job);
      // GitHub treats environment names case-insensitively.
      if (name && !envs.has(name.toLowerCase())) envs.set(name.toLowerCase(), name);
    }
  }
  return { pages, environments: [...envs.values()] };
}

/**
 * Pass 3b - the repository settings a deploy depends on.
 *
 * A red default branch can be caused by settings, not code: Pages switched off
 * under a workflow that deploys to
 * it, and an environment whose branch policy still named the old default
 * branch. Neither is visible in a workflow file or a run list, so they are read
 * here, and only where a workflow needs them -- a repo with no deploy-pages step
 * is not asked about Pages, and a repo whose jobs name no environment is not
 * asked about environments. That keeps the REST cost to the repos it concerns.
 *
 * Every answer is stored as the HTTP status plus the few fields a rule reads.
 * The status is kept rather than a verdict because only two statuses mean
 * anything to `repos/{r}/pages` (200 on, 404 off); a 403 or a gateway error must
 * reach the loader as unknown, never as "off". The same holds for every call
 * below, and a throttled call throws to pMap, which records the repo as errored.
 *
 * The default branch's protection is asked only for an environment restricted
 * to "protected branches", because that is the only policy whose answer depends
 * on it. GitHub also lets every branch deploy to such an environment when no
 * branch in the repo is protected, so that is asked too, and a ruleset on the
 * default branch is counted because this cannot tell whether GitHub treats a
 * ruleset as protection for this purpose -- the rule reads a non-zero count as
 * unknown.
 */
export async function collectDeploySettings(org, repos, workflowFiles, { get = restWithStatus, concurrency = 8 } = {}) {
  const targets = repos
    .filter(r => !r.isArchived && !r.isEmpty)
    .map(r => ({ r, need: deployNeeds(workflowFiles.get(r.name)) }))
    .filter(t => t.need.pages || t.need.environments.length);

  let calls = 0;
  const ask = path => { calls++; return get(path); };
  const out = {};

  const results = await pMap(targets, async ({ r, need }) => {
    const base = `repos/${org}/${r.name}`;
    const rec = {};
    if (need.pages) {
      const { status, body } = await ask(`${base}/pages`);
      rec.pages = {
        status,
        build_type: status === 200 ? (body?.build_type ?? null) : null,
        source_branch: status === 200 ? (body?.source?.branch ?? null) : null,
      };
    }
    if (need.environments.length) {
      const named = new Set(need.environments.map(n => n.toLowerCase()));
      const { status, body } = await ask(`${base}/environments?per_page=100`);
      rec.environments = { status, named: need.environments, total_count: null, list: null };
      let wantProtection = false;
      if (status === 200 && Array.isArray(body?.environments)) {
        rec.environments.total_count = body.total_count ?? null;
        rec.environments.list = [];
        for (const e of body.environments) {
          const policy = e.deployment_branch_policy ?? null;
          const row = {
            name: e.name,
            // null is GitHub's "all branches"; an object carries the two flags.
            deployment_branch_policy: policy && {
              protected_branches: policy.protected_branches === true,
              custom_branch_policies: policy.custom_branch_policies === true,
            },
          };
          if (named.has(String(e.name).toLowerCase()) && policy) {
            if (policy.custom_branch_policies === true) {
              const bp = await ask(`${base}/environments/${encodeURIComponent(e.name)}/deployment-branch-policies?per_page=100`);
              row.branch_policies = {
                status: bp.status,
                total_count: bp.status === 200 ? (bp.body?.total_count ?? null) : null,
                list: bp.status === 200 && Array.isArray(bp.body?.branch_policies)
                  ? bp.body.branch_policies.map(p => ({ name: p.name, type: p.type ?? null }))
                  : null,
              };
            }
            if (policy.protected_branches === true) wantProtection = true;
          }
          rec.environments.list.push(row);
        }
      }
      const branch = r.defaultBranchRef?.name;
      if (wantProtection && branch) {
        const b = await ask(`${base}/branches/${encodeURIComponent(branch)}`);
        const db = { name: branch, status: b.status,
          protected: b.status === 200 && typeof b.body?.protected === 'boolean' ? b.body.protected : null,
          any_protected: null, ruleset_rules: null };
        if (db.protected === false) {
          const any = await ask(`${base}/branches?protected=true&per_page=1`);
          db.any_protected = any.status === 200 && Array.isArray(any.body) ? any.body.length > 0 : null;
          if (db.any_protected === true) {
            const rs = await ask(`${base}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
            db.ruleset_rules = rs.status === 200 && Array.isArray(rs.body) ? rs.body.length : null;
          }
        }
        rec.default_branch = db;
      }
    }
    return rec;
  }, concurrency);

  const errors = [];
  results.forEach((res, i) => {
    const name = targets[i].r.name;
    if (res.ok) out[name] = res.value;
    else {
      // Recorded, and left out of `repos`: the loader then has no row for it,
      // which the rules read as not measured.
      errors.push({ repo: name, stage: 'deploy_settings', message: res.error });
    }
  });
  const pagesOff = Object.values(out).filter(x => x.pages?.status === 404).length;
  log(`deploy settings: ${Object.keys(out).length}/${targets.length} repos read in ${calls} REST calls ` +
      `(${pagesOff} with Pages off, ${errors.length} errors)`);
  return { ok: true, calls, repos: out, errors };
}

// ---------------------------------------------------------------------------
// The committed Atlas map (rules/atlas-map.md). A map runs from tens of KB to
// over a megabyte, almost all of it lists no org-level question needs: the
// landings, reach and edges that let Atlas answer about one repository. What
// the org view reads is the map's identity (blob, engine, the commit it was
// made from) and each door's outline, so that is all the snapshot keeps.
//
// Bump when the trimmed shape changes: a cached record trimmed by an older
// version is then fetched again rather than served in the old shape.
export const ATLAS_TRIM_VERSION = 1;
const ATLAS_CACHE = join(ROOT, 'data', 'atlas-map-cache.json');
const ATLAS_PACKAGE = '@dogfood-lab/atlas';

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
};

/**
 * One door without its long lists. Pure.
 *
 * Kept: what the door is (file, name, kind), what starts it (triggers), what
 * each command runs (job, step, programs, and the directory once maps record
 * it), what it sends, and its counts. `jobs` and `findings` are kept whole
 * whenever a door carries them -- Atlas 1.25.0 adds both -- so the slices that
 * read them need no collector change. Dropped: landings, reach, runs, readers,
 * mentions and the other per-file lists; each is recoverable from the map at
 * the commit the record names.
 */
export function trimAtlasDoor(door) {
  if (!door || typeof door !== 'object') return null;
  const out = pick(door, ['file', 'name', 'kind', 'triggers', 'sends']);
  out.commands = Array.isArray(door.commands)
    ? door.commands.map(c => pick(c, ['job', 'step', 'programs', 'directory']))
    : [];
  const counts = {};
  for (const [k, v] of Object.entries(door)) if (/Count$/.test(k) && typeof v === 'number') counts[k] = v;
  out.counts = counts;
  if (door.jobs !== undefined) out.jobs = door.jobs;
  if (door.findings !== undefined) out.findings = door.findings;
  return out;
}

/** A whole map reduced to the record the snapshot keeps. Pure. */
export function trimAtlasMap(map) {
  return {
    // Maps made before Atlas 1.23.0 carry no engine field; null says so.
    engine: typeof map?.engine === 'string' ? map.engine : null,
    commit: map?.generatedFrom?.commit ?? null,
    doors: Array.isArray(map?.doors) ? map.doors.map(trimAtlasDoor).filter(Boolean) : [],
  };
}

function readAtlasCache() {
  try { return existsSync(ATLAS_CACHE) ? JSON.parse(readFileSync(ATLAS_CACHE, 'utf8')) : {}; } catch { return {}; }
}

/**
 * The engine version the fleet is measured against: the latest published
 * @dogfood-lab/atlas. One registry request, not GitHub. A failure is stored as
 * an error with no version, so the engine-behind check stays silent rather
 * than measuring against nothing.
 */
async function atlasFleetVersion(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${ATLAS_PACKAGE.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { version: null, source: 'npm dist-tags latest', error: `http_${res.status}` };
    const j = await res.json();
    return { version: j['dist-tags']?.latest ?? null, source: 'npm dist-tags latest' };
  } catch (e) {
    return { version: null, source: 'npm dist-tags latest', error: String(e.message ?? e).slice(0, 160) };
  }
}

/**
 * Pass 6b - each repository's committed map, by blob id.
 *
 * The id rides the repo pass (`atlasMap` in REPO_FIELDS, no extra GraphQL
 * cost). The blob is fetched only when its id is not in data/atlas-map-cache.json,
 * the lockfile pass's pattern: a blob id names its content, so a cached record
 * for that id is correct forever. The cache holds trimmed records only, and it
 * is never the only holder -- the snapshot carries every record it used, which
 * is what lets `npm run rebuild` work offline.
 *
 * Archived repositories are exempt from the map rule and are not fetched.
 * A fetch or parse failure is recorded against the repo with its blob id, and
 * the loader stores it as a map that exists but could not be read.
 */
export async function collectAtlasMaps(org, repos, { get = rest, fetchImpl = fetch, cache = readAtlasCache(), writeCache = true } = {}) {
  const nextCache = {};
  const out = {};
  let fetched = 0, cached = 0, errored = 0;
  const targets = repos.filter(r => !r.isArchived && r.atlasMap?.oid);

  await pMap(targets, async r => {
    const oid = r.atlasMap.oid;
    const size = r.atlasMap.byteSize ?? null;
    const hit = cache[oid];
    if (hit && hit.trim === ATLAS_TRIM_VERSION && hit.record) {
      cached++;
      nextCache[oid] = hit;
      out[r.name] = { blob: oid, size, ...hit.record };
      return;
    }
    try {
      const blob = await get(`repos/${org}/${r.name}/git/blobs/${oid}`);
      const text = Buffer.from(String(blob?.content ?? ''), blob?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      const record = trimAtlasMap(JSON.parse(text));
      fetched++;
      nextCache[oid] = { trim: ATLAS_TRIM_VERSION, record };
      out[r.name] = { blob: oid, size, ...record };
    } catch (e) {
      errored++;
      out[r.name] = { blob: oid, size, error: String(e.message ?? e).slice(0, 160) };
    }
  }, 6);

  if (writeCache) {
    try { writeFileSync(ATLAS_CACHE, JSON.stringify(nextCache)); } catch { /* cache is a convenience */ }
  }
  const fleet = await atlasFleetVersion(fetchImpl);
  log(`atlas maps: ${targets.length} committed (${fetched} fetched, ${cached} from cache, ${errored} errors); ` +
      `fleet engine ${fleet.version ?? `unknown (${fleet.error})`}`);
  return { ok: true, fleet_version: fleet, fetched, cached, repos: out };
}

/** Pass 4 - npm dist-tags, to catch repo-version vs published-version drift. */
async function collectNpm(repos, concurrency = 12) {
  const named = repos
    .map(r => ({ repo: r.name, pkg: safeJson(r.pkg?.text) }))
    .filter(x => x.pkg && x.pkg.name && !x.pkg.private);

  const results = await pMap(named, async x => {
    const res = await fetch(`https://registry.npmjs.org/${x.pkg.name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (res.status === 404) return { repo: x.repo, pkg_name: x.pkg.name, status: 'unpublished' };
    if (!res.ok) return { repo: x.repo, pkg_name: x.pkg.name, status: `http_${res.status}` };
    const j = await res.json();
    const latest = j['dist-tags']?.latest ?? null;
    return {
      repo: x.repo,
      pkg_name: x.pkg.name,
      status: 'published',
      latest,
      published_at: j.time?.[latest] ?? j.modified ?? null,
    };
  }, concurrency);

  log(`npm: ${results.filter(r => r.ok).length}/${named.length} packages checked`);
  return results.map((r, i) => r.ok
    ? r.value
    : { repo: named[i].repo, pkg_name: named[i].pkg.name, status: 'error', error: r.error });
}

/**
 * Pass 1b - GitHub computes `mergeable` asynchronously: the first query only
 * triggers the computation and returns UNKNOWN. Re-query those PRs so conflict
 * counts are real. Skipping this undercounted conflicts sevenfold on one sweep.
 */
async function refreshMergeable(org, repos, batchSize = 8) {
  const pending = [];
  for (const r of repos) {
    for (const p of r.prList?.nodes ?? []) {
      if (p.mergeable === 'UNKNOWN') pending.push({ repo: r.name, number: p.number });
    }
  }
  if (!pending.length) return 0;
  log(`mergeable: ${pending.length} PRs returned UNKNOWN, re-querying`);
  await new Promise(res => setTimeout(res, 3000));   // let GitHub finish computing

  const byRepo = new Map();
  for (const r of repos) {
    byRepo.set(r.name, new Map((r.prList?.nodes ?? []).map(p => [p.number, p])));
  }

  let resolved = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    // GraphQL is whitespace-insensitive; joining with spaces keeps this readable.
    const parts = batch.map((t, k) =>
      `p${k}: repository(owner:$owner, name:${JSON.stringify(t.repo)}) { pullRequest(number:${t.number}) { number mergeable } }`);
    let body;
    try {
      body = await graphql(`query($owner:String!){ ${parts.join(' ')} }`, { owner: org });
    } catch (e) {
      log(`  mergeable batch failed: ${e.message?.slice(0, 120)}`);
      continue;
    }
    batch.forEach((t, k) => {
      const pr = body.data?.[`p${k}`]?.pullRequest;
      if (!pr || pr.mergeable === 'UNKNOWN') return;
      const node = byRepo.get(t.repo)?.get(pr.number);
      if (node) { node.mergeable = pr.mergeable; resolved++; }
    });
  }
  log(`mergeable: resolved ${resolved}/${pending.length}`);
  return resolved;
}

// Open Dependabot alerts, plus whether the repo is allowed to fix them.
//
// Both are read-only GETs. The org endpoint returns every open alert across the
// org in one paginated call, so this costs one request plus one per repo -- far
// cheaper than asking each repo for its alerts.
//
// The pairing is the point. An alert count alone says "this repo is exposed";
// automated-security-fixes says whether anything is coming to fix it. A repo
// with alerts and the setting OFF will never receive a Dependabot PR, which is
// how alerts reach seven months old unnoticed.
async function collectSecurity(org, repos, concurrency = 10) {
  let alerts = [];
  let alertsOk = true;
  try {
    const raw = await restPaged(`/orgs/${org}/dependabot/alerts?state=open&per_page=100`);
    alerts = raw.map(a => ({
      repo: a.repository?.name ?? null,
      number: a.number ?? null,
      severity: a.security_advisory?.severity ?? null,
      ecosystem: a.dependency?.package?.ecosystem ?? null,
      package: a.dependency?.package?.name ?? null,
      manifest: a.dependency?.manifest_path ?? null,
      ghsa: a.security_advisory?.ghsa_id ?? null,
      summary: (a.security_advisory?.summary ?? '').slice(0, 200),
      created_at: a.created_at ?? null,
      // Null when the advisory has no patched release: those cannot be fixed by
      // a version bump and should not be counted as actionable.
      fixed_version: a.security_vulnerability?.first_patched_version?.identifier ?? null,
      url: a.html_url ?? null,
    }));
  } catch (e) {
    alertsOk = false;
    log(`security: org alert sweep failed (${String(e.message ?? e).slice(0, 80)})`);
  }

  const fixes = {};
  const scanned = {};
  await pMap(repos, async r => {
    // Whether the repo is scanned AT ALL. Without this, an unscanned repo
    // reports zero alerts and is indistinguishable from a clean one -- which
    // is how a repo sits unscanned while the sweep calls it healthy.
    // 204 = enabled, 404 = disabled; the endpoint has no body either way.
    const st = await restStatus(`repos/${org}/${r.name}/vulnerability-alerts`);
    scanned[r.name] = st === 204 ? 1 : st === 404 ? 0 : null;
    try {
      const d = await rest(`repos/${org}/${r.name}/automated-security-fixes`);
      fixes[r.name] = d?.enabled === true ? 1 : 0;
    } catch {
      fixes[r.name] = null;   // no permission, or alerts are off entirely
    }
  }, concurrency);

  log(`security: ${alerts.length} open alerts, ${Object.values(fixes).filter(v => v === 0).length} repos with auto-fixes off, ${Object.values(scanned).filter(v => v === 0).length} not scanned at all`);
  return { ok: alertsOk, alerts, auto_security_fixes: fixes, vulnerability_alerts: scanned };
}

// ---------------------------------------------------------------------------
// Committed lockfiles, audited by the warehouse itself. See lockfile.mjs for
// why GitHub's own count cannot be trusted per manifest.
//
// Cost: one recursive tree call per repo (REST), plus one blob fetch per
// lockfile whose SHA changed since the last sweep. The parsed package map is
// cached by blob SHA in data/lockfile-cache.json (gitignored, rebuildable), so
// steady state is ~99 REST calls. The advisory lookup itself goes to the npm
// registry, not GitHub, and is re-run EVERY sweep on purpose: an audit verdict
// is a function of (lockfile, wall-clock), and caching it by SHA would let a
// newly published advisory hide behind an unchanged file -- the exact trap
// that made a green PR go red with no commit on 2026-09-17.
const NPM_BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const CACHE_FILE = join(ROOT, 'data', 'lockfile-cache.json');

function readPackageMapCache() {
  try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}; } catch { return {}; }
}

async function auditPackageMap(map) {
  if (!Object.keys(map).length) return {};
  const res = await fetch(NPM_BULK, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(map),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`npm bulk advisory ${res.status}`);
  return res.json();
}

async function collectLockfiles(org, repos, concurrency = 6) {
  const cache = readPackageMapCache();      // { blobSha: { version, packages: {name:[v]} } }
  const nextCache = {};
  const out = {};                           // { repo: [ {path, sha, size, ...} ] }
  let fetched = 0, cached = 0, audited = 0, errored = 0;

  await pMap(repos.filter(r => !r.isArchived), async r => {
    let tree;
    try {
      tree = await rest(`repos/${org}/${r.name}/git/trees/${r.defaultBranch ?? 'main'}?recursive=1`);
    } catch (e) {
      out[r.name] = [{ path: null, error: `tree: ${String(e.message ?? e).slice(0, 120)}` }];
      errored++; return;
    }
    const files = lockfilePathsFromTree(tree?.tree);
    out[r.name] = [];
    for (const f of files) {
      const row = { path: f.path, sha: f.sha, size: f.size, truncated_tree: tree?.truncated === true };
      try {
        let entry = cache[f.sha];
        if (!entry) {
          const blob = await rest(`repos/${org}/${r.name}/git/blobs/${f.sha}`);
          const text = Buffer.from(String(blob?.content ?? ''), blob?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
          const lock = JSON.parse(text);
          entry = { version: lock.lockfileVersion ?? null, packages: packageMapFromLockfile(lock), dev: devOnlyPackages(lock) };
          fetched++;
        } else {
          cached++;
        }
        nextCache[f.sha] = entry;
        const bulk = await auditPackageMap(entry.packages);
        const advisories = advisoriesFromBulk(entry.packages, bulk, entry.dev ?? []);
        audited++;
        Object.assign(row, {
          lockfile_version: entry.version,
          packages: Object.keys(entry.packages).length,
          counts: countBySeverity(advisories),
          advisories,
        });
      } catch (e) {
        // UNKNOWN, never clean: the loader writes `error` and the analyzer
        // skips the row rather than reading it as zero exposure.
        row.error = String(e.message ?? e).slice(0, 160);
        errored++;
      }
      out[r.name].push(row);
    }
  }, concurrency);

  try { writeFileSync(CACHE_FILE, JSON.stringify(nextCache)); } catch { /* cache is a convenience */ }
  const total = Object.values(out).flat().filter(x => x.path).length;
  log(`lockfiles: ${total} audited across ${Object.keys(out).length} repos (${fetched} fetched, ${cached} from cache, ${audited} registry lookups, ${errored} errors)`);
  return out;
}

/**
 * Pass 7 - the Actions invoice.
 *
 * ONE REST call for the whole org. The enhanced billing endpoint returns a line
 * per (day, product, SKU, repository) with gross, discount and net, which is
 * the only authoritative statement of what Actions cost. Everything downstream
 * treats this as truth and the per-job arithmetic as an attribution of it.
 *
 * Returns `{ ok:false }` rather than throwing. The endpoint needs a scope the
 * collector does not otherwise require, and a missing scope must degrade to "no
 * cost data" -- never to a zero that reads as "this org spends nothing".
 */
async function collectBilling(org, when = new Date()) {
  const year = when.getUTCFullYear(), month = when.getUTCMonth() + 1;
  try {
    const data = await rest(
      `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`);
    const items = (data.usageItems ?? []).map(i => ({
      date: i.date, product: i.product, sku: i.sku,
      unit_type: i.unitType, quantity: i.quantity, price_per_unit: i.pricePerUnit,
      gross: i.grossAmount, discount: i.discountAmount, net: i.netAmount,
      repo: i.repositoryName || null,
    }));
    const gross = items.reduce((a, i) => a + (i.gross ?? 0), 0);
    const net = items.reduce((a, i) => a + (i.net ?? 0), 0);
    log(`billing: ${items.length} line items for ${year}-${String(month).padStart(2, '0')} ` +
        `(gross $${gross.toFixed(2)}, net $${net.toFixed(2)})`);
    return { ok: true, year, month, items };
  } catch (e) {
    // 403 here is the ordinary case on a token without the billing scope.
    log(`billing: UNAVAILABLE (${e.message?.slice(0, 120)})`);
    return { ok: false, year, month, items: [], error: e.message?.slice(0, 300) ?? String(e) };
  }
}

const RUN_COST_CACHE = join(ROOT, 'data', 'run-cost-cache.json');

// How many repos get the per-job drill-down, and the ceiling on job fetches per
// sweep. Both exist because this pass is the only expensive thing the collector
// does: a job list is one REST call per run, and an org can produce thousands
// of runs a month. The billing pass already tells us which repos carry the cost,
// so the drill follows that ranking instead of sweeping everything -- ~1 call
// per run in the top repos on a cold cache, near zero afterwards.
const DRILL_REPOS = Number(process.env.HK_COST_REPOS ?? 12);
export const DRILL_BUDGET = Number(process.env.HK_COST_BUDGET ?? 1500);

function readRunCostCache() {
  try { return existsSync(RUN_COST_CACHE) ? JSON.parse(readFileSync(RUN_COST_CACHE, 'utf8')) : {}; }
  catch { return {}; }
}

/**
 * Pass 8 - per-run cost attribution for the repos that carry the spend.
 *
 * The invoice says which repo. Only the jobs say which WORKFLOW, which matrix
 * cell and which runner, and GitHub's own /timing endpoints return zeros for
 * all of it (verified 2026-09-21: workflow timing returns `{"billable":{}}` and
 * run timing returns total_ms 0 on runs that plainly billed minutes). So the
 * durations are read per job and priced here.
 *
 * Caching is keyed by run id and holds ONLY completed runs. A finished run is
 * immutable, so its billable minutes are a pure function of the run -- the
 * condition that makes a cache correct. An in-progress run is deliberately
 * never cached and never priced: its cost is still moving, and freezing a
 * partial duration would under-report it permanently. This is the same reason
 * the lockfile pass caches parsed package maps by blob SHA but refuses to cache
 * advisory verdicts.
 *
 * The window is the billing month, so the result is directly comparable with
 * the invoice. Repos outside the drill get NO rows rather than empty ones --
 * the analyzer reads absence as "not measured", never as "costs nothing".
 */
async function collectRunCosts(org, repos, billing, concurrency = 8) {
  if (!billing.ok) { log('run costs: skipped (no billing data to rank repos by)'); return { ok: false, repos: [], runs: [] }; }

  const { rates, estimated, unmapped } = ratesFromUsage(billing.items);
  const priced = withFallback(rates);
  if (estimated) log('run costs: WARNING billing revealed no rates; using published list prices');
  if (unmapped.length) log(`run costs: unmapped SKUs (left unpriced): ${unmapped.join(', ')}`);

  const spend = new Map();
  for (const i of billing.items) {
    if (i.product !== 'actions' || i.sku === 'Actions storage' || !i.repo) continue;
    spend.set(i.repo, (spend.get(i.repo) ?? 0) + (i.gross ?? 0));
  }
  const live = new Set(repos.filter(r => !r.isEmpty).map(r => r.name));
  const targets = [...spend.entries()]
    .filter(([name]) => live.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, DRILL_REPOS)
    .map(([name, gross]) => ({ name, gross }));

  const since = `${billing.year}-${String(billing.month).padStart(2, '0')}-01`;
  const cache = readRunCostCache();
  const nextCache = {};
  let fetched = 0, cachedHits = 0, skippedLive = 0, budgetHit = false;

  const results = await pMap(targets, async t => {
    const runs = [];
    for (let page = 1; page <= 10; page++) {
      const data = await rest(`repos/${org}/${t.name}/actions/runs`
        + `?per_page=100&page=${page}&created=%3E%3D${since}`);
      const batch = data.workflow_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    const out = [];
    for (const run of runs) {
      if (run.status !== 'completed') { skippedLive++; continue; }
      const key = String(run.id);
      let jobs = cache[key];
      if (jobs) { cachedHits++; }
      else {
        if (fetched >= DRILL_BUDGET) { budgetHit = true; continue; }
        fetched++;
        const collected = [];
        for (let page = 1; page <= 5; page++) {
          const d = await rest(`repos/${org}/${t.name}/actions/runs/${run.id}/jobs`
            + `?per_page=100&page=${page}&filter=all`);
          const batch = d.jobs ?? [];
          // Only the three fields pricing needs. Storing whole job objects would
          // grow the cache by two orders of magnitude for no extra answer.
          collected.push(...batch.map(j => ({
            name: j.name, labels: j.labels ?? [],
            started_at: j.started_at, completed_at: j.completed_at,
            conclusion: j.conclusion,
          })));
          if (batch.length < 100) break;
        }
        jobs = collected;
      }
      nextCache[key] = jobs;
      const p = priceRun(jobs, priced);
      out.push({
        repo: t.name, run_id: run.id, workflow_name: run.name,
        path: run.path ?? null, event: run.event, conclusion: run.conclusion,
        created_at: run.created_at,
        ...p,
        jobs: jobs.map(j => {
          const one = priceRun([j], priced);
          return {
            name: j.name,
            runner_labels: (j.labels ?? []).join(','),
            // Classified once, here, so no downstream query has to guess from
            // the label string.
            runner_class: runnerClass(j.labels ?? []),
            conclusion: j.conclusion,
            minutes: one.billable_minutes + one.self_hosted_minutes + one.unpriced_minutes,
            cost_usd: one.cost_usd,
          };
        }),
      });
    }
    return out;
  }, concurrency);

  try { writeFileSync(RUN_COST_CACHE, JSON.stringify(nextCache)); }
  catch { /* cache is a convenience, never a correctness requirement */ }

  const runs = [], errors = [];
  results.forEach((res, i) => {
    if (res.ok) runs.push(...res.value);
    else errors.push({ repo: targets[i].name, stage: 'run_costs', message: res.error });
  });
  const total = runs.reduce((a, r) => a + r.cost_usd, 0);
  log(`run costs: ${runs.length} runs priced across ${targets.length} repos ` +
      `($${total.toFixed(2)} attributed; ${fetched} fetched, ${cachedHits} cached, ` +
      `${skippedLive} still running)${budgetHit ? ` -- BUDGET ${DRILL_BUDGET} HIT, attribution INCOMPLETE` : ''}`);

  return {
    ok: true, since, rates: priced, rates_estimated: estimated, unmapped_skus: unmapped,
    budget_hit: budgetHit, drilled: targets.map(t => t.name),
    repos: targets, runs, errors,
  };
}

export async function collect(org) {
  const ctx = { started: Date.now(), takenAt: new Date().toISOString(), stage: 'start', login: null };
  return recordingFailure(ctx, () => sweep(org, ctx));
}

// ctx.stage names the pass in flight, so a failed line says where it died.
async function sweep(org, ctx) {
  const { started, takenAt } = ctx;
  const login = ctx.login = whoami();
  log(`org=${org} collector=${COLLECTOR_VERSION} as=${login}`);

  ctx.stage = 'repos';          const { repos, total, rateLimit } = await collectRepos(org);
  ctx.stage = 'mergeable';      const mergeableResolved = await refreshMergeable(org, repos);
  ctx.stage = 'workflow_files'; const workflowFiles = await collectWorkflowFiles(org, repos);
  ctx.stage = 'runs';           const { runs, errors } = await collectRuns(org, repos);
  ctx.stage = 'deploy_settings'; const deploySettings = await collectDeploySettings(org, repos, workflowFiles);
  ctx.stage = 'npm';            const npm = await collectNpm(repos);
  ctx.stage = 'security';       const security = await collectSecurity(org, repos);
  ctx.stage = 'lockfiles';      const lockfiles = await collectLockfiles(org, repos);
  ctx.stage = 'atlas_maps';     const atlasMaps = await collectAtlasMaps(org, repos);
  ctx.stage = 'billing';        const billing = await collectBilling(org);
  ctx.stage = 'run_costs';      const runCosts = await collectRunCosts(org, repos, billing);
  ctx.stage = 'write';

  const snapshot = {
    schema: 1,
    taken_at: takenAt,
    org,
    collector_version: COLLECTOR_VERSION,
    gh_login: login,
    repo_count: repos.length,
    declared_total: total,
    duration_ms: Date.now() - started,
    rate_limit_remaining: rateLimit?.remaining ?? null,
    mergeable_resolved: mergeableResolved,
    repos,
    workflow_files: Object.fromEntries(workflowFiles),
    workflow_runs: runs,
    deploy_settings: { ok: deploySettings.ok, calls: deploySettings.calls, repos: deploySettings.repos },
    npm,
    security,
    lockfiles,
    // fetched/cached counts are left out: they describe this machine's cache,
    // not the org, and would make two identical observations look different.
    atlas_maps: { ok: atlasMaps.ok, fleet_version: atlasMaps.fleet_version, repos: atlasMaps.repos },
    billing,
    run_costs: runCosts,
    errors: errors.concat(deploySettings.errors ?? [], runCosts.errors ?? []),
  };

  const dir = join(ROOT, 'data', 'snapshots');
  mkdirSync(dir, { recursive: true });
  const fingerprint = snapshotFingerprint(snapshot);

  // Skip writing a snapshot that observed exactly what the previous one did.
  // Ten sweeps landed inside two hours on 2026-09-08 and two of them
  // (00-02-37, 00-04-27) were byte-identical apart from the timestamp -- 9 MB
  // of working tree recording zero drift. Drift between snapshots is the whole
  // point of keeping them, and an identical snapshot contains none.
  //
  // This is NOT a deletion and does not soften the append-only rule: nothing on
  // disk is touched, and the sweep is still recorded in data/sweeps.jsonl. We
  // drop the payload, not the fact that we looked.
  //
  // Only the immediately previous snapshot is compared. A sweep that matches an
  // OLDER one after something moved and moved back is a real change and must be
  // written. Any doubt resolves toward writing: an unreadable previous snapshot
  // is treated as different, never as a match.
  const prevFile = latestSnapshotOnDisk(dir);
  let prevSnap = null;
  if (prevFile) {
    try { prevSnap = JSON.parse(readFileSync(prevFile, 'utf8')); }
    catch (e) { log(`previous snapshot unreadable (${e.message}); writing this one`); }
  }
  if (prevSnap && snapshotFingerprint(prevSnap) === fingerprint) {
    recordSweep({
      at: takenAt, result: 'duplicate', identical_to: basename(prevFile),
      content_hash: fingerprint, duration_ms: snapshot.duration_ms,
      repo_count: snapshot.repo_count, collector_version: COLLECTOR_VERSION,
    });
    log(`identical to ${basename(prevFile)} - no snapshot written, sweep recorded in data/sweeps.jsonl`);
    // Return the snapshot that EXISTS on disk, so a caller loading this result
    // puts a row in the database that `npm run rebuild` can reproduce.
    return { snapshot: prevSnap, file: prevFile, duplicate: true, fingerprint };
  }

  const file = join(dir, `${takenAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 1));
  recordSweep({
    at: takenAt, result: 'written', file: basename(file),
    content_hash: fingerprint, duration_ms: snapshot.duration_ms,
    repo_count: snapshot.repo_count, collector_version: COLLECTOR_VERSION,
  });
  log(`wrote ${file} (${(JSON.stringify(snapshot).length / 1e6).toFixed(2)} MB) in ${snapshot.duration_ms}ms`);
  return { snapshot, file, duplicate: false, fingerprint };
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  Promise.resolve().then(() => collect(resolveOrg(process.argv[2])))
    .catch(e => { console.error('FATAL', e); process.exit(1); });
}
