#!/usr/bin/env node
// Load a raw snapshot JSON into SQLite. The DB is derived and disposable:
// `npm run rebuild` reconstructs it from data/snapshots/*.json at any time.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  editsWorkflowFiles, prCreateWithDefaultToken, auditSteps,
  pagesDeployJobs, jobEnvironment, jobRunsOnDefaultBranch, atlasCheckPins,
  resolveFailedStep, scheduleGaps,
} from './workflow-risks.mjs';
import { safeJson } from './collect.mjs';
import { reconcileRepos } from './cost.mjs';
import { HkError, userError } from './errors.mjs';
import { DATA_DIR, PACKAGE_ROOT } from './paths.mjs';

export const DB_PATH = process.env.HK_DB || join(DATA_DIR, 'housekeeping.db');

const DAY = 86400_000;
const daysSince = iso => (iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY) : null);
const bool = v => (v ? 1 : 0);

/**
 * Flatten a statusCheckRollup into {name, state} rows.
 *
 * The two arms are not interchangeable and collapsing them loses findings: a
 * required context can be satisfied by the Checks API (a job, `CheckRun.name`)
 * OR by the legacy commit-status API (an external integration,
 * `StatusContext.context`). Reading only CheckRun would report every
 * status-only gate as unsatisfiable.
 *
 * A null rollup means the commit has no checks at all, which is a real and
 * different observation from "not collected" -- the caller writes no rows and
 * the analyzer sees an empty universe.
 */
export function rollupNames(rollup) {
  return (rollup?.contexts?.nodes ?? [])
    .map(n => (n.__typename === 'StatusContext'
      ? { name: n.context, state: n.state ?? null }
      : { name: n.name, state: n.conclusion ?? null }))
    .filter(c => c.name);
}

const TRANSLATION_RE = /^README\.[a-z]{2}(-[A-Za-z]{2,4})?\.md$/;

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** A tag is comparable to package.json only if it is plain semver. */
export function parseSemver(name) {
  const m = SEMVER_RE.exec((name ?? '').trim());
  if (!m) return null;
  return {
    major: +m[1], minor: +m[2], patch: +m[3],
    pre: m[4] ?? null,
    version: `${+m[1]}.${+m[2]}.${+m[3]}${m[4] ? '-' + m[4] : ''}`,
  };
}

/** Newest-first semver ordering; a prerelease sorts below its release. */
export function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return b[k] - a[k];
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return -1;
  if (!b.pre) return 1;
  return a.pre < b.pre ? 1 : -1;
}

export function openDb(path = DB_PATH, { fresh = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  if (fresh) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix); } catch { /* absent */ }
    }
  }
  const db = new DatabaseSync(path);
  const ddl = readFileSync(join(PACKAGE_ROOT, 'src', 'schema.sql'), 'utf8');
  db.exec(ddl);

  // CREATE TABLE IF NOT EXISTS silently does nothing when a table already
  // exists, so a column added to schema.sql never reaches an existing database
  // and the mismatch only surfaces later as an opaque INSERT arity error.
  // Fail here instead, with the fix in the message.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const fingerprint = createHash('sha256').update(ddl).digest('hex').slice(0, 16);
  const seen = db.prepare("SELECT value FROM meta WHERE key='schema_fingerprint'").get();
  if (!seen) {
    db.prepare("INSERT INTO meta VALUES ('schema_fingerprint', ?)").run(fingerprint);
  } else if (seen.value !== fingerprint) {
    throw new HkError('SCHEMA_CHANGED',
      `schema.sql changed since this database was built (${seen.value} -> ${fingerprint})`,
      { hint: 'the database is derived: run `npm run rebuild` to re-create it from data/snapshots/' });
  }
  return db;
}

/**
 * Mechanically score one workflow YAML against rules/github-actions.md.
 * Regex would misread nested keys, so this parses the document properly.
 *
 * `atlasEnv` maps a job key to the `environment` the repository's Atlas map
 * records for it (Atlas 1.24.0 and later), when the map has this file.
 * `isPrivate` is the repository's visibility, which decides whether a job
 * gated to public repositories can run at all.
 */
export function inspectWorkflow(text, path, defaultBranch = null, atlasEnv = null, isPrivate = false) {
  const out = {
    path, name: path.split('/').pop(), state: 'unknown',
    has_paths_filter: 0, has_workflow_dispatch: 0, has_concurrency: 0,
    runners: '', uses_macos: 0, uses_windows: 0,
    on_triggers: '', job_count: 0, has_matrix: 0, size_bytes: text.length, job_names: '',
    edits_workflow_files: 0, pr_create_default_token: 0,
    audit_steps_enforcing: 0, audit_steps_defanged: '',
    pages_deploy_jobs: '', environments: [], atlas_check: '', schedule_gaps: null,
  };
  let doc;
  try { doc = parseYaml(text, { logLevel: 'silent' }); } catch { out.state = 'parse_error'; return out; }
  if (!doc || typeof doc !== 'object') { out.state = 'parse_error'; return out; }

  out.state = 'ok';
  out.name = typeof doc.name === 'string' ? doc.name : out.name;

  // YAML 1.1 turns a bare `on:` key into boolean true; accept either spelling.
  const on = doc.on ?? doc[true] ?? doc['on'];
  const triggers = on == null ? []
    : typeof on === 'string' ? [on]
    : Array.isArray(on) ? on
    : Object.keys(on);
  out.on_triggers = triggers.join(',');
  out.has_workflow_dispatch = bool(triggers.includes('workflow_dispatch'));

  // "paths-gated" only means anything for push/pull_request triggers.
  if (on && typeof on === 'object' && !Array.isArray(on)) {
    const gated = ['push', 'pull_request'].filter(t => on[t] && typeof on[t] === 'object');
    const anyPushLike = ['push', 'pull_request'].some(t => t in on);
    out.has_paths_filter = bool(
      !anyPushLike || gated.some(t => on[t]['paths'] || on[t]['paths-ignore'])
    );
  } else {
    // `on: push` bare form is by definition ungated.
    out.has_paths_filter = bool(!triggers.some(t => t === 'push' || t === 'pull_request'));
  }

  out.has_concurrency = bool(Boolean(doc.concurrency));

  // Array-valued `jobs:` is malformed, and Object.entries would hand back "0",
  // "1" as job ids -- names that match nothing and would make a live required
  // context look unsatisfiable. Only a mapping has ids worth reading.
  const jobEntries = doc.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs)
    ? Object.entries(doc.jobs)
    : [];
  const jobs = jobEntries.map(([, j]) => j);
  out.job_count = jobs.length;

  // The check name GitHub publishes is the job's `name:` if it has one, else
  // the job id -- with the matrix cell appended in parentheses when `name:` is
  // absent. Both spellings are recorded because a required context can be
  // written either way. A `name:` holding a ${{ }} expression is skipped rather
  // than stored half-resolved: a wrong name here would claim a live job is
  // missing, which is the one mistake this column exists to prevent.
  const names = new Set();
  for (const [id, job] of jobEntries) {
    names.add(id);
    const n = job && typeof job === 'object' ? job.name : null;
    if (typeof n === 'string' && !n.includes('${{')) names.add(n);
  }
  out.job_names = [...names].join('\n');

  const runners = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (job.strategy?.matrix) out.has_matrix = 1;
    const ro = job['runs-on'];
    for (const r of Array.isArray(ro) ? ro : [ro]) {
      if (typeof r === 'string') runners.add(r);
    }
    // matrix-driven runners: matrix.os values are the real runner labels
    const os = job.strategy?.matrix?.os;
    if (Array.isArray(os)) os.forEach(o => typeof o === 'string' && runners.add(o));
  }
  out.runners = [...runners].join(',');
  out.uses_macos = bool([...runners].some(r => /macos/i.test(r)));
  out.uses_windows = bool([...runners].some(r => /windows/i.test(r)));

  // Platform-level failure modes live in their own module; see the notes there.
  out.edits_workflow_files = bool(editsWorkflowFiles(doc, jobs));
  out.pr_create_default_token = bool(prCreateWithDefaultToken(doc, jobs));

  const audit = auditSteps(doc, jobs);
  out.audit_steps_enforcing = audit.enforcing.length;
  out.audit_steps_defanged = audit.defanged.join('\n');

  out.atlas_check = atlasCheckPins(doc, jobs).join('\n');

  const gaps = scheduleGaps(doc, jobEntries);
  out.schedule_gaps = gaps ? gaps.join('\n') : null;

  // The deploy doors, joined in analyze.mjs to the settings they depend on.
  out.pages_deploy_jobs = pagesDeployJobs(jobEntries, { isPrivate }).join('\n');
  // The environment a job deploys to is a fact Atlas also records, so where
  // the map names one it is preferred: one definition for both tools. This
  // file's own reading is kept beside it, so a disagreement stays visible.
  // Where the map has no name (it names none, or could not resolve one) the
  // workflow's reading stands; both refuse `${{ }}` names.
  for (const [id, job] of jobEntries) {
    const parsed = jobEnvironment(job);
    const recorded = atlasEnv?.get(id)?.name;
    const fromMap = typeof recorded === 'string' && recorded.trim() ? recorded.trim() : null;
    const environment = fromMap ?? parsed;
    if (environment) {
      out.environments.push({
        job: id, environment,
        runs_on_default: jobRunsOnDefaultBranch(doc, job, defaultBranch),
        source: fromMap ? 'atlas' : 'workflow', parsed,
      });
    }
  }

  return out;
}

function filePresence(repo) {
  const root = (repo.rootTree?.entries ?? []).map(e => e.name);
  const gh = (repo.ghTree?.entries ?? []).map(e => e.name);
  const has = (list, re) => bool(list.some(n => re.test(n)));
  return {
    readme: has(root, /^README(\.md|\.rst|\.txt)?$/i),
    license: has(root, /^LICENSE(\.md|\.txt)?$/i),
    changelog: has(root, /^CHANGELOG(\.md)?$/i),
    security: bool(has(root, /^SECURITY\.md$/i) || has(gh, /^SECURITY\.md$/i)),
    contributing: bool(has(root, /^CONTRIBUTING\.md$/i) || has(gh, /^CONTRIBUTING\.md$/i)),
    code_of_conduct: bool(has(root, /^CODE_OF_CONDUCT\.md$/i) || has(gh, /^CODE_OF_CONDUCT\.md$/i)),
    codeowners: bool(has(root, /^CODEOWNERS$/i) || has(gh, /^CODEOWNERS$/i)),
    dependabot: has(gh, /^dependabot\.ya?ml$/i),
    gitignore: has(root, /^\.gitignore$/i),
    package_json: has(root, /^package\.json$/i),
    ship_gate: has(root, /^SHIP_GATE\.md$/i),
    claude_md: bool(has(root, /^CLAUDE\.md$/i) || root.includes('.claude')),
    workflows_dir: bool((repo.wfTree?.entries ?? []).length > 0),
    root_entries: root.length,
  };
}

// A workspace root is not always declared with npm's `workspaces` field.
// MONOREPO_ROOT exists to stop a root's version being read as a shipped
// version, and it was keyed on that field alone -- so roots declared by
// pnpm-workspace.yaml (with or without a turbo.json beside it) were
// workspace roots the audit did not label. A rule written to stop
// over-reporting had quietly started under-reporting.
//
// Only UNAMBIGUOUS markers count. turbo.json and nx.json are deliberately
// excluded: both appear in single-package repos that use those tools purely
// for task running, and treating them as proof of a workspace would trade
// this under-reporting for the over-reporting the distinction exists to
// prevent. Every marker below exists only to declare a workspace.
//
// ...except pnpm-workspace.yaml, which STOPPED being unambiguous at pnpm 11.
// pnpm 11 moved settings that used to live in package.json's `pnpm` field
// (onlyBuiltDependencies and friends) into pnpm-workspace.yaml, and writes the
// file into SINGLE-package repos to hold them. Observed in a repo that is not
// a workspace, after one `pnpm install`:
//
//     allowBuilds:
//       better-sqlite3: set this to true or false
//
// No `packages:` key. So presence alone would start reporting MONOREPO_ROOT for
// any repo whose maintainer ran pnpm 11 once -- turning a rule written to fix
// under-reporting into an over-reporter, which is the exact trade the comment
// above says we are avoiding. The file now has to DECLARE a workspace.
//
// Direction of error is chosen deliberately. MONOREPO_ROOT *suppresses*
// version-drift findings, so a false positive HIDES a real problem while a
// false negative only emits noise a human will check and dismiss. Where the
// content is genuinely unavailable, prefer the noisy error.
export const WORKSPACE_MARKERS = [
  'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'rush.json',
];

// The subset whose presence still proves a workspace on its own.
const PRESENCE_ONLY_MARKERS = ['lerna.json', 'rush.json'];
// The subset that must be read, not merely counted.
const CONTENT_CHECKED_MARKERS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'];
const DECLARES_PACKAGES = /^\s*packages\s*:/m;

// `pnpmWorkspaceText` is three-valued and the three values mean different things:
//   undefined  the field was never collected -- every snapshot taken before this
//              check existed. Fall back to presence, because that is what those
//              snapshots meant when they were written; doing otherwise would make
//              `npm run rebuild` on historical data silently lose all 16 of the
//              org's workspace roots and invent drift for them.
//   null       we asked and got no readable text for a file that IS in the tree.
//              We have no evidence of a workspace, so take the noisy direction.
//   string     read it.
// ---- handbook sidebar shape -------------------------------------------------
// Starlight 0.39 removed the top-level `autogenerate` on a labelled sidebar
// group and introduced the nested `items: [{ autogenerate }]` form. The two are
// mutually exclusive, not old-and-new: building the nested form against 0.37
// fails with `Expected type { label, link } | { label, items } | { label } |
// { slug } | string`, and building the labelled form against 0.42 fails with
// "Support for autogenerated sidebar groups was removed in Starlight v0.39.0".
// Verified in both directions on live sites, 2026-09-17.
//
// So the shape alone says nothing. Only shape-paired-with-declared-range does,
// which is why these are two columns read together rather than one verdict.

// Comments are stripped before matching. Several repos carry prose ABOUT this
// migration, and matching the commentary instead of the code would report the
// repos that already fixed it.
const stripJsComments = (src) =>
  String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LABELLED_AUTOGEN = [
  // `{ label: 'X', autogenerate: {...} }` and the same with the keys reversed.
  /\{[^{}]*\blabel\s*:[^{}]*\bautogenerate\s*:\s*\{[^{}]*\}[^{}]*\}/,
  /\{[^{}]*\bautogenerate\s*:\s*\{[^{}]*\}[^{}]*\blabel\s*:[^{}]*\}/,
];
const ITEMS_AUTOGEN = /items\s*:\s*\[\s*\{\s*autogenerate\s*:/;

// null  -> not measured (no site/astro.config.mjs, or a pre-collection snapshot)
// 'none'-> there is a config but it declares no sidebar at all
export function sidebarShape(astroConfigText) {
  if (typeof astroConfigText !== 'string') return null;
  const code = stripJsComments(astroConfigText);
  if (!/sidebar\s*:/.test(code)) return 'none';
  // Checked first: a config may carry both while a migration is half-done, and
  // the labelled form is the one that breaks on >=0.39.
  if (LABELLED_AUTOGEN.some(re => re.test(code))) return 'labeled-autogenerate';
  if (ITEMS_AUTOGEN.test(code)) return 'items-autogenerate';
  // A hand-written sidebar of links/slugs. Valid on every version, so it is
  // never a finding -- some repos move here deliberately.
  return 'explicit';
}

export function starlightRange(sitePkgText) {
  const pkg = safeJson(sitePkgText);
  if (!pkg) return null;
  return pkg.dependencies?.['@astrojs/starlight']
      ?? pkg.devDependencies?.['@astrojs/starlight']
      ?? null;
}

// Does the declared range admit a Starlight at or past the 0.39 break?
// A caret or tilde on a 0.x version pins the MINOR (^0.37.6 resolves to 0.37.x
// and never to 0.39), which is why a repo can carry the old shape and still be
// green. Returns null when the range is not parseable, so the caller can stay
// silent rather than guess.
export function rangeAdmits039(range) {
  if (typeof range !== 'string') return null;
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  if (maj > 0) return true;                 // 1.x+ is well past the boundary
  if (/^[\^~]/.test(range)) return min >= 39;
  return min >= 39;                          // exact pin
}

// ---- deploy settings --------------------------------------------------------
// The collector stores HTTP statuses; this is where a status becomes a fact.
// Only the statuses the endpoint documents as answers are read as answers:
// `repos/{r}/pages` is 200 when Pages is on and 404 when it is off. Anything
// else -- 403 on a token without the scope, a 5xx that outlived the retries,
// no HTTP answer at all -- is unknown, and unknown is NULL, never 0.
export function pagesEnabled(status) {
  return status === 200 ? 1 : status === 404 ? 0 : null;
}

// GitHub's deployment branch policy: null means every branch may deploy; an
// object has exactly one of its two flags set. Any other shape is unknown.
export function environmentPolicy(policy) {
  if (policy === null) return 'all';
  if (!policy || typeof policy !== 'object') return null;
  const { protected_branches: prot, custom_branch_policies: custom } = policy;
  if (prot === true && custom !== true) return 'protected';
  if (custom === true && prot !== true) return 'custom';
  return null;
}

const tri = v => (v === true ? 1 : v === false ? 0 : null);

/**
 * One repo's deploy-settings record from the snapshot, as the rows the two
 * tables hold. Pure. Returns null when the repo was not asked anything.
 */
export function deploySettingsRows(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const envs = rec.environments;
  const db = rec.default_branch;
  const row = {
    pages_status: rec.pages?.status ?? null,
    pages_enabled: rec.pages ? pagesEnabled(rec.pages.status) : null,
    pages_build_type: rec.pages?.build_type ?? null,
    pages_source_branch: rec.pages?.source_branch ?? null,
    environments_status: envs?.status ?? null,
    default_branch: db?.name ?? null,
    default_protected: tri(db?.protected),
    any_branch_protected: tri(db?.any_protected),
    default_ruleset_rules: Number.isInteger(db?.ruleset_rules) ? db.ruleset_rules : null,
  };
  // A list is only trusted when the call answered 200 and returned all of it;
  // a repo with more environments than one page holds is read as unknown.
  const listed = envs?.status === 200 && Array.isArray(envs.list)
    && (envs.total_count == null || envs.total_count <= envs.list.length);
  if (envs && !listed) row.environments_status = envs.status === 200 ? null : (envs.status ?? null);
  const environments = listed ? envs.list.map(e => {
    const bp = e.branch_policies;
    const readable = bp === undefined ? null
      : (bp?.status === 200 && Array.isArray(bp.list)
         && (bp.total_count == null || bp.total_count <= bp.list.length)) ? 1 : 0;
    return {
      name: e.name,
      policy: environmentPolicy(e.deployment_branch_policy),
      branch_policies: readable === 1
        ? bp.list.map(p => `${p.type ?? 'branch'}:${p.name}`).join('\n') : null,
      policies_readable: readable,
    };
  }) : [];
  return { row, environments };
}

// ---- the committed Atlas map ------------------------------------------------
// Three-valued, like the pnpm workspace text above: the key is absent from
// every snapshot taken before collector 1.3.0, and reading that absence as
// "no map" would file a missing-map finding against every repo in history.
//   key absent       -> NULL (not collected)
//   null             -> 0 (the default branch has no atlas/structure.json)
//   a blob with oid  -> 1
//   anything else    -> NULL (the path is not a file; nothing is known)
export function hasAtlasMap(repo) {
  if (!repo || !('atlasMap' in repo)) return null;
  if (repo.atlasMap === null) return 0;
  return typeof repo.atlasMap?.oid === 'string' ? 1 : null;
}

/**
 * The rows of run_failed_step for one collected run. Pure.
 * `record` is an entry of snapshot.failed_steps.runs; `text` is the run's
 * workflow file as the sweep read it, or null when the file is gone. A record
 * that carries an error yields nothing -- the run was not read, which is not
 * the same as a run with no failed step.
 */
export function failedStepRows(record, text) {
  if (!record || record.error || !Array.isArray(record.jobs)) return [];
  let doc = null, why = null;
  if (text == null) why = 'the workflow file is not on the default branch any more';
  else {
    try { doc = parseYaml(text, { logLevel: 'silent' }); } catch { doc = null; }
    if (!doc || typeof doc !== 'object') { doc = null; why = 'the workflow file does not parse'; }
  }
  const rows = [];
  if (!record.jobs.length) {
    const unresolved = record.job_count === 0
      ? 'no job ran, which is how GitHub fails a run whose workflow file it cannot use'
      : 'no job failed; the run itself did';
    return [{ api_job: null, api_step: null, step_number: null, job: null, step: null, phase: null, unresolved }];
  }
  for (const j of record.jobs) {
    const steps = Array.isArray(j.steps) && j.steps.length ? j.steps : [null];
    for (const s of steps) {
      const at = doc ? resolveFailedStep(doc, j.name, s?.name ?? null, s?.number ?? null) : { unresolved: why };
      rows.push({
        api_job: j.name ?? null, api_step: s?.name ?? null, step_number: s?.number ?? null,
        job: at.job ?? null, step: at.step ?? null, phase: at.phase ?? null, unresolved: at.unresolved ?? null,
      });
    }
  }
  return rows;
}

export function isWorkspaceRoot(pkg, rootEntryNames = [], pnpmWorkspaceText) {
  if (pkg?.workspaces) return true;
  const names = new Set(rootEntryNames.map(n => String(n).toLowerCase()));
  if (PRESENCE_ONLY_MARKERS.some(m => names.has(m))) return true;
  if (!CONTENT_CHECKED_MARKERS.some(m => names.has(m))) return false;
  if (pnpmWorkspaceText === undefined) return true;
  if (typeof pnpmWorkspaceText !== 'string') return false;
  return DECLARES_PACKAGES.test(pnpmWorkspaceText);
}

export function loadSnapshot(db, snap) {
  db.exec('BEGIN');
  try {
    const sid = loadSnapshotInner(db, snap);
    db.exec('COMMIT');
    return sid;
  } catch (e) {
    db.exec('ROLLBACK');   // never leave a half-written snapshot behind
    throw e;
  }
}

function loadSnapshotInner(db, snap) {
  const ins = sql => db.prepare(sql);
  const snapStmt = ins(`INSERT INTO snapshot
    (taken_at, org, collector_version, repo_count, duration_ms, gh_login, notes)
    VALUES (?,?,?,?,?,?,?)`);
  snapStmt.run(snap.taken_at, snap.org, snap.collector_version,
    snap.repo_count, snap.duration_ms, snap.gh_login ?? null, null);
  const sid = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  const npmByRepo = new Map((snap.npm ?? []).map(n => [n.repo, n]));
  const failedByRepo = new Map();
  for (const x of snap.failed_steps?.runs ?? []) {
    if (!failedByRepo.has(x.repo)) failedByRepo.set(x.repo, []);
    failedByRepo.get(x.repo).push(x);
  }
  const runsByRepo = new Map();
  for (const r of snap.workflow_runs ?? []) {
    if (!runsByRepo.has(r.repo)) runsByRepo.set(r.repo, []);
    runsByRepo.get(r.repo).push(r);
  }

  // Placeholders are derived from the live schema, so adding a column to
  // schema.sql can never silently desync the INSERTs below.
  const insertInto = table => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().length;
    return ins(`INSERT INTO ${table} VALUES (${Array(cols).fill('?').join(',')})`);
  };
  const stmts = {
    repo: insertInto('repo'),
    topic: insertInto('topic'),
    lang: insertInto('language'),
    pkgScript: insertInto('package_script'),
    pkgDep: insertInto('package_dep'),
    issue: insertInto('issue'),
    pr: insertInto('pull_request'),
    rel: insertInto('release'),
    tag: insertInto('tag'),
    wf: insertInto('workflow'),
    wfEnv: insertInto('workflow_environment'),
    atlasMap: insertInto('atlas_map'),
    atlasDoor: insertInto('atlas_door'),
    atlasCmd: insertInto('atlas_door_command'),
    atlasFleet: insertInto('atlas_fleet'),
    deploy: insertInto('deploy_settings'),
    env: insertInto('environment'),
    run: insertInto('workflow_run'),
    failedStep: insertInto('run_failed_step'),
    fp: insertInto('file_presence'),
    secAlert: insertInto('security_alert'),
    repoSec: insertInto('repo_security'),
    lock: insertInto('lockfile'),
    lockAdv: insertInto('lockfile_advisory'),
    bprot: insertInto('branch_protection'),
    ctx: insertInto('check_context'),
    bill: insertInto('billing_usage'),
    runCost: insertInto('run_cost'),
    runCostJob: insertInto('run_cost_job'),
    recon: insertInto('cost_reconciliation'),
    err: insertInto('collect_error'),
  };

  for (const r of snap.repos) {
    const pkg = safeJson(r.pkg?.text);
    const npm = npmByRepo.get(r.name);
    const latestRel = (r.releases?.nodes ?? []).find(x => x.isLatest) ?? r.releases?.nodes?.[0] ?? null;
    const wfFiles = snap.workflow_files?.[r.name] ?? [];
    const translations = (r.rootTree?.entries ?? [])
      .filter(e => TRANSLATION_RE.test(e.name)).length;

    // Tags and Releases are different objects. Track both so "tagged but never
    // released" stops masquerading as version drift.
    const releaseTags = new Set((r.releases?.nodes ?? []).map(x => x.tagName));
    const allTags = (r.tags?.nodes ?? []).map(t => ({
      name: t.name,
      at: t.target?.committedDate ?? t.target?.tagger?.date ?? null,
      sem: parseSemver(t.name),
    }));
    const semTags = allTags.filter(t => t.sem).sort((a, b) => compareSemver(a.sem, b.sem));
    const newestTag = semTags[0] ?? null;

    stmts.repo.run(
      sid, r.name, r.id, r.description ?? null, r.url ?? null, r.homepageUrl ?? null,
      bool(r.isPrivate), bool(r.isArchived), bool(r.isFork), bool(r.isTemplate), bool(r.isEmpty),
      r.createdAt, r.updatedAt, r.pushedAt, daysSince(r.pushedAt),
      r.diskUsage ?? 0, r.stargazerCount ?? 0, r.forkCount ?? 0, r.watchers?.totalCount ?? 0,
      r.primaryLanguage?.name ?? null, r.licenseInfo?.spdxId ?? null,
      bool(r.hasIssuesEnabled), bool(r.hasWikiEnabled), bool(r.hasDiscussionsEnabled), null,
      r.defaultBranchRef?.name ?? null,
      r.defaultBranchRef?.target?.oid ?? null,
      r.defaultBranchRef?.target?.committedDate ?? null,
      r.defaultBranchRef?.target?.statusCheckRollup?.state ?? 'NONE',
      r.openIssues?.totalCount ?? 0, r.closedIssues?.totalCount ?? 0,
      r.openPRsCount?.totalCount ?? 0, r.mergedPRsCount?.totalCount ?? 0, r.closedPRsCount?.totalCount ?? 0,
      r.releases?.totalCount ?? 0, latestRel?.tagName ?? null, latestRel?.publishedAt ?? null,
      r.tags?.totalCount ?? 0, newestTag?.name ?? null, newestTag?.at ?? null,
      pkg?.name ?? null, pkg?.version ?? null, bool(pkg?.private),
      npm?.latest ?? null, npm?.published_at ?? null, npm?.status ?? null,
      r.repositoryTopics?.nodes?.length ?? 0, wfFiles.length, translations,
      // The `in` check distinguishes "never collected" (older snapshot -- the
      // keys are absent) from "collected, no readable blob" (key present, null).
      // `r.pnpmWs?.text` alone collapses both to undefined and loses that.
      bool(isWorkspaceRoot(
        pkg,
        (r.rootTree?.entries ?? []).map(e => e.name),
        ('pnpmWs' in r || 'pnpmWsYml' in r)
          ? (r.pnpmWs?.text ?? r.pnpmWsYml?.text ?? null)
          : undefined,
      )),
      // Two halves of one fact, stored separately: see sidebarShape() above.
      sidebarShape(r.siteAstroCfg?.text),
      starlightRange(r.sitePkg?.text),
      hasAtlasMap(r),
      r.isFork ? (r.parent?.owner?.login ?? null) : null,
    );

    // The trimmed map record, when the atlas pass read one for this repo.
    const am = snap.atlas_maps?.repos?.[r.name];
    if (am) {
      const doors = Array.isArray(am.doors) ? am.doors : [];
      stmts.atlasMap.run(sid, r.name, am.blob ?? null, am.size ?? null,
        am.error ? null : (am.engine ?? null), am.error ? null : (am.commit ?? null),
        am.error ? null : doors.length, am.error ?? null);
      const json = v => (v === undefined ? null : JSON.stringify(v));
      for (const d of doors) {
        stmts.atlasDoor.run(sid, r.name, d.file ?? null, d.name ?? null, d.kind ?? null,
          json(d.triggers), json(d.sends), json(d.counts), json(d.jobs), json(d.findings),
          json(d.unresolvedChecks));
        for (const c of d.commands ?? []) {
          // Atlas writes `dir`; records trimmed before collector 1.4.0 asked
          // for `directory`, which no map carries, so either spelling is read.
          stmts.atlasCmd.run(sid, r.name, d.file ?? null, d.name ?? null,
            c.job ?? null, c.step == null ? null : String(c.step),
            Array.isArray(c.programs) ? c.programs.join('\n') : null, c.dir ?? c.directory ?? null);
        }
      }
    }

    // Branch protection + what the default branch head actually reported. A row
    // is written only when the protection rule is readable at all; absent rows
    // mean "not measured", which is how the analyzer stays silent on a snapshot
    // taken without admin rights instead of declaring every repo ungated.
    const bpr = r.defaultBranchRef?.branchProtectionRule;
    if (bpr) {
      const ctxs = bpr.requiredStatusCheckContexts ?? [];
      stmts.bprot.run(
        sid, r.name, r.defaultBranchRef?.name ?? null,
        bool(bpr.requiresStatusChecks), bool(bpr.requiresStrictStatusChecks),
        ctxs.length, ctxs.join('\n'),
      );
    }
    for (const c of rollupNames(r.defaultBranchRef?.target?.statusCheckRollup))
      stmts.ctx.run(sid, r.name, 'default', null, c.name, c.state);

    for (const t of r.repositoryTopics?.nodes ?? []) stmts.topic.run(sid, r.name, t.topic.name);

    // Scripts and declared dependencies. Cheap to store and it is the only
    // way to ask "is this tool ever actually run?" — see WF/PKG rules.
    for (const [name, command] of Object.entries(pkg?.scripts ?? {})) {
      if (typeof command === 'string') stmts.pkgScript.run(sid, r.name, name, command.slice(0, 400));
    }
    for (const [kind, field] of [['prod', 'dependencies'], ['dev', 'devDependencies']]) {
      for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
        if (typeof spec === 'string') stmts.pkgDep.run(sid, r.name, name, spec, kind);
      }
    }

    const totalBytes = r.languages?.totalSize || 0;
    for (const e of r.languages?.edges ?? []) {
      stmts.lang.run(sid, r.name, e.node.name, e.size, totalBytes ? +(100 * e.size / totalBytes).toFixed(2) : 0);
    }

    for (const i of r.issueList?.nodes ?? []) {
      stmts.issue.run(sid, r.name, i.number, i.title, i.author?.login ?? null,
        i.createdAt, i.updatedAt, daysSince(i.createdAt), daysSince(i.updatedAt),
        i.comments?.totalCount ?? 0,
        (i.labels?.nodes ?? []).map(l => l.name).join(','), i.url);
    }

    for (const p of r.prList?.nodes ?? []) {
      stmts.pr.run(sid, r.name, p.number, p.title, p.author?.login ?? null,
        p.createdAt, p.updatedAt, daysSince(p.createdAt), daysSince(p.updatedAt),
        bool(p.isDraft), p.mergeable ?? null, p.reviewDecision ?? null,
        p.additions ?? 0, p.deletions ?? 0, p.changedFiles ?? 0,
        p.headRefName ?? null, p.baseRefName ?? null,
        (p.labels?.nodes ?? []).map(l => l.name).join(','), p.url);
      for (const c of rollupNames(p.commits?.nodes?.[0]?.commit?.statusCheckRollup))
        stmts.ctx.run(sid, r.name, 'pr', p.number, c.name, c.state);
    }

    for (const t of allTags) {
      stmts.tag.run(sid, r.name, t.name, t.at, bool(t.sem), bool(releaseTags.has(t.name)));
    }

    for (const rel of r.releases?.nodes ?? []) {
      stmts.rel.run(sid, r.name, rel.tagName, rel.name ?? null, rel.publishedAt,
        bool(rel.isLatest), bool(rel.isDraft), bool(rel.isPrerelease));
    }

    // Job environments as the map records them, per workflow file.
    const mapDoors = snap.atlas_maps?.repos?.[r.name]?.error ? [] : (snap.atlas_maps?.repos?.[r.name]?.doors ?? []);
    const atlasEnvByFile = new Map(mapDoors.filter(d => Array.isArray(d.jobs)).map(d => [d.file,
      new Map(d.jobs.filter(j => j && typeof j.name === 'string' && j.environment).map(j => [j.name, j.environment]))]));
    for (const f of wfFiles) {
      const w = inspectWorkflow(f.text, f.path, r.defaultBranchRef?.name ?? null, atlasEnvByFile.get(f.path) ?? null, !!r.isPrivate);
      stmts.wf.run(sid, r.name, w.path, w.name, w.state,
        w.has_paths_filter, w.has_workflow_dispatch, w.has_concurrency,
        w.runners, w.uses_macos, w.uses_windows,
        w.on_triggers, w.job_count, w.has_matrix, f.byteSize || w.size_bytes,
        w.edits_workflow_files, w.pr_create_default_token, w.job_names ?? '',
        w.audit_steps_enforcing ?? 0, w.audit_steps_defanged ?? '',
        w.pages_deploy_jobs ?? '', w.atlas_check ?? '', w.schedule_gaps ?? null);
      for (const e of w.environments ?? []) {
        stmts.wfEnv.run(sid, r.name, w.path, e.job, e.environment, e.runs_on_default,
          e.source ?? 'workflow', e.parsed ?? null);
      }
    }

    // Absent for a snapshot taken before the pass, and for a repo that was not
    // asked: no row, which the rules read as not measured.
    const ds = deploySettingsRows(snap.deploy_settings?.repos?.[r.name]);
    if (ds) {
      const d = ds.row;
      stmts.deploy.run(sid, r.name, d.pages_status, d.pages_enabled, d.pages_build_type,
        d.pages_source_branch, d.environments_status, d.default_branch,
        d.default_protected, d.any_branch_protected, d.default_ruleset_rules);
      for (const e of ds.environments) {
        stmts.env.run(sid, r.name, e.name, e.policy, e.branch_policies, e.policies_readable);
      }
    }

    // The API returns runs newest-first, so the first sighting of a workflow path
    // is its latest run. Default-branch runs are tracked separately: a red
    // dependabot PR branch is a different problem from a red main.
    const runs = runsByRepo.get(r.name) ?? [];
    const defaultBranch = r.defaultBranchRef?.name ?? null;
    const seenAny = new Set(), seenDefault = new Set();
    for (const run of runs) {
      const isLatest = !seenAny.has(run.path);
      if (isLatest) seenAny.add(run.path);
      const onDefault = Boolean(defaultBranch) && run.branch === defaultBranch;
      const isLatestDefault = onDefault && !seenDefault.has(run.path);
      if (isLatestDefault) seenDefault.add(run.path);
      const dur = run.created_at && run.updated_at
        ? Math.max(0, Math.round((Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000))
        : null;
      stmts.run.run(sid, r.name, run.workflow_name, run.path, run.run_id, run.run_number,
        run.event, run.status, run.conclusion, run.branch,
        run.created_at, run.updated_at, dur, run.url,
        bool(isLatest), bool(onDefault), bool(isLatestDefault));
    }

    for (const x of failedByRepo.get(r.name) ?? []) {
      const text = wfFiles.find(f => f.path === x.path)?.text ?? null;
      for (const row of failedStepRows(x, text)) {
        stmts.failedStep.run(sid, r.name, x.run_id, x.path, row.api_job, row.api_step,
          row.step_number, row.job, row.step, row.phase, row.unresolved);
      }
    }

    const fp = filePresence(r);
    stmts.fp.run(sid, r.name, fp.readme, fp.license, fp.changelog, fp.security,
      fp.contributing, fp.code_of_conduct, fp.codeowners, fp.dependabot,
      fp.gitignore, fp.package_json, fp.ship_gate, fp.claude_md,
      fp.workflows_dir, fp.root_entries);
  }

  // ---- security ---------------------------------------------------------
  // Absent `security` means the sweep did not run (old snapshot, or no scope).
  // Leave both tables empty in that case: the analyzer treats "no rows" as
  // "not measured" and stays silent rather than reporting a clean org.
  const sec = snap.security;
  if (sec && sec.ok) {
    const byRepo = new Map();
    for (const a of sec.alerts ?? []) {
      if (!a.repo) continue;
      if (!byRepo.has(a.repo)) byRepo.set(a.repo, []);
      byRepo.get(a.repo).push(a);
      stmts.secAlert.run(
        sid, a.repo, a.number ?? null, a.severity ?? null, a.ecosystem ?? null,
        a.package ?? null, a.manifest ?? null, a.ghsa ?? null, a.summary ?? null,
        a.created_at ?? null, daysSince(a.created_at), a.fixed_version ?? null, a.url ?? null,
      );
    }
    const fixes = sec.auto_security_fixes ?? {};
    const scanned = sec.vulnerability_alerts ?? {};
    for (const r of snap.repos) {
      const list = byRepo.get(r.name) ?? [];
      const count = sev => list.filter(a => a.severity === sev).length;
      const oldest = list.reduce((m, a) => (!m || (a.created_at && a.created_at < m) ? a.created_at : m), null);
      const enabled = Object.prototype.hasOwnProperty.call(fixes, r.name) ? fixes[r.name] : null;
      // A repo with no alerts still gets a row: it is how the analyzer tells
      // "measured and clean" from "never measured".
      const isScanned = Object.prototype.hasOwnProperty.call(scanned, r.name) ? scanned[r.name] : null;
      stmts.repoSec.run(
        sid, r.name, isScanned, enabled,
        list.length, count('critical'), count('high'), count('medium'), count('low'),
        oldest, daysSince(oldest),
        list.filter(a => a.fixed_version).length,
      );
    }
  }

  // ---- committed lockfiles, audited directly ------------------------------
  // Absent `lockfiles` means the pass did not run (older snapshot): no rows,
  // and the analyzer stays silent rather than reporting zero exposure.
  // `github_alerts` joins the org alert sweep by (repo, manifest_path) so the
  // rule can state the false negative from one row.
  if (snap.lockfiles && sec && sec.ok) {
    const alertsByManifest = new Map();
    for (const a of sec.alerts ?? []) {
      if (!a.repo || !a.manifest) continue;
      const k = `${a.repo}\n${a.manifest}`;
      alertsByManifest.set(k, (alertsByManifest.get(k) ?? 0) + 1);
    }
    for (const [repo, rows] of Object.entries(snap.lockfiles)) {
      for (const l of rows ?? []) {
        if (!l.path) { stmts.err.run(sid, repo, 'lockfiles', l.error ?? 'unknown'); continue; }
        const c = l.counts ?? {};
        stmts.lock.run(
          sid, repo, l.path, l.sha ?? null, l.size ?? null,
          l.lockfile_version ?? null, l.packages ?? null,
          l.error ? null : (c.critical ?? 0), l.error ? null : (c.high ?? 0),
          l.error ? null : (c.medium ?? 0), l.error ? null : (c.low ?? 0),
          // NULL, not 0, when the snapshot predates dev/prod attribution. A 0
          // here reads as "nothing ships", which turned every finding into a
          // toolchain one on 2026-09-18 when an older snapshot was reloaded.
          // Absent is not zero.
          l.error || c.prod_critical === undefined ? null : c.prod_critical,
          l.error || c.prod_high === undefined ? null : c.prod_high,
          alertsByManifest.get(`${repo}\n${l.path}`) ?? 0,
          l.error ?? null,
        );
        for (const a of l.advisories ?? []) {
          stmts.lockAdv.run(sid, repo, l.path, a.package, a.version, a.severity,
            a.ghsa ?? null, a.title ?? null, a.url ?? null, a.vulnerable_versions ?? null,
            a.dev === undefined ? null : (a.dev ? 1 : 0));
        }
      }
    }
  }

  // ---- Actions cost --------------------------------------------------------
  // Three tables that must stay independently absent. A snapshot predating this
  // pass loads with no billing rows AND no run_cost rows; one taken without the
  // billing scope loads with neither but records the error; one taken with
  // billing but a blown drill budget loads billing rows and PARTIAL run_cost
  // rows. Only the reconciliation can tell the third case from a clean one, so
  // it is written per repo rather than inferred later.
  if (snap.billing?.ok) {
    for (const i of snap.billing.items ?? []) {
      stmts.bill.run(sid, i.date, i.product, i.sku, i.unit_type,
        i.quantity ?? null, i.price_per_unit ?? null,
        i.gross ?? null, i.discount ?? null, i.net ?? null, i.repo ?? null);
    }
  } else if (snap.billing?.error) {
    stmts.err.run(sid, null, 'billing', snap.billing.error);
  }

  const rc = snap.run_costs;
  if (rc?.ok) {
    for (const r of rc.runs ?? []) {
      stmts.runCost.run(sid, r.repo, r.run_id, r.workflow_name, r.path ?? null,
        r.event ?? null, r.conclusion ?? null, r.created_at ?? null,
        r.job_count ?? null, r.billed_job_count ?? null,
        r.billable_minutes ?? null,
        r.ubuntu_minutes ?? null, r.windows_minutes ?? null, r.macos_minutes ?? null,
        r.self_hosted_minutes ?? null, r.unpriced_minutes ?? null,
        r.cost_usd ?? null);
      for (const j of r.jobs ?? []) {
        stmts.runCostJob.run(sid, r.repo, r.run_id, j.name,
          j.runner_labels ?? null, j.runner_class ?? null, j.conclusion ?? null,
          j.minutes ?? null, j.cost_usd ?? null);
      }
    }

    // Reconciliation is computed at load, not collect, so re-loading an old
    // snapshot re-derives it under today's code -- the point of keeping the
    // database derived. The decision itself lives in cost.mjs so the gate is
    // unit-tested; this only writes the rows.
    for (const row of reconcileRepos({
      billingItems: snap.billing?.items ?? [],
      runs: rc.runs ?? [],
      drilled: rc.drilled ?? [],
      ratesEstimated: rc.rates_estimated === true,
    })) {
      stmts.recon.run(sid, row.repo, row.computed_usd, row.billed_gross_usd,
        row.billed_net_usd, row.ratio, row.trustworthy, row.reason);
    }
  }

  // No row when the pass did not run (older snapshot): the engine check then
  // has nothing to measure against and stays silent.
  if (snap.atlas_maps?.fleet_version) {
    const fv = snap.atlas_maps.fleet_version;
    stmts.atlasFleet.run(sid, fv.version ?? null, fv.source ?? null, fv.error ?? null);
  }

  for (const e of snap.errors ?? []) stmts.err.run(sid, e.repo, e.stage, e.message);
  return sid;
}

export function latestSnapshotFile() {
  const dir = join(DATA_DIR, 'snapshots');
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }      // no directory yet is the same as no snapshots
  if (!files.length) throw userError('NO_SNAPSHOT', 'no snapshots in data/snapshots', 'run `hk refresh` to take one');
  return join(dir, files.at(-1));
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  const file = process.argv[2] ?? latestSnapshotFile();
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const db = openDb();
  const sid = loadSnapshot(db, snap);
  console.error(`[load] snapshot ${sid} <- ${file} (${snap.repo_count} repos)`);
}
