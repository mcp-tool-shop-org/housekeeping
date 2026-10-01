#!/usr/bin/env node
// Derive findings from a loaded snapshot.
//
// Every rule cites the org rule it enforces, so a finding is arguable against a
// written standard rather than against taste. Rules are pure functions of the DB:
// re-running analyze() on an old snapshot reproduces that day's findings exactly.
import { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH, rangeAdmits039, parseSemver, compareSemver } from './load.mjs';
import { loadConfig } from './config.mjs';

// The one definition of "this failing run means the mainline is broken".
// cli.mjs `hk ci` and report.mjs both interpolate this so the CLI and the
// report can never disagree about what red means. A run counts only if its
// event is push-like AND its workflow can still be triggered by a push today:
// a workflow moved to `release:`-only keeps
// its last main-branch failure forever and would otherwise read as live
// breakage. A run whose workflow file is gone is left loud on purpose -- the
// row is missing rather than known-harmless.
export const RUN_IS_LIVE_MAINLINE_SIGNAL = `
  wr.is_latest_on_default=1 AND wr.conclusion='failure'
  AND wr.event NOT IN ('dynamic','schedule')
  AND (NOT EXISTS (SELECT 1 FROM workflow w
         WHERE w.snapshot_id=wr.snapshot_id AND w.repo=wr.repo AND w.path=wr.path)
       OR EXISTS (SELECT 1 FROM workflow w
         WHERE w.snapshot_id=wr.snapshot_id AND w.repo=wr.repo AND w.path=wr.path
           AND (','||w.on_triggers||',' LIKE '%,push,%'
             OR ','||w.on_triggers||',' LIKE '%,pull_request,%')))`;

// The one definition of "the default branch head's checks are red", for the
// same three readers: the analyzer decides (CI_FAILING, below) and the CLI,
// the MCP server and the report ask whether it did, never the raw rollup.
export const HEAD_CHECKS_RED = `EXISTS (SELECT 1 FROM finding f
  WHERE f.snapshot_id=r.snapshot_id AND f.repo=r.name AND f.code='CI_FAILING')`;

// Check-run states that mean a check ran and did not pass. CANCELLED is not
// among them: `cancel-in-progress` cancels a superseded run as designed.
const FAILED_STATES = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/**
 * Which checks on the default branch head actually fail. Pure.
 *
 * GitHub's rollup is FAILURE when any check run on the commit is, and it
 * counts a CANCELLED run as a failure. The same commit pushed twice starts
 * two runs; the concurrency rule cancels the first and the second passes,
 * and the rollup still reads FAILURE forever (measured 2026-09-30 on two
 * repos, every non-green check CANCELLED beside a SUCCESS of the same name).
 * So a check fails here only when one of its runs is in a failed state and
 * none of its runs on this commit succeeded. A check that was only ever
 * cancelled is not a failure either: a failed run is not a cancelled one.
 *
 * `contexts` are check_context rows for the head ({ name, state }). Returns
 * [{ name, states }] for the failing checks, or null when there are no rows
 * -- not measured, so the caller falls back to the rollup.
 */
export function failingHeadChecks(contexts) {
  if (!contexts?.length) return null;
  const byName = new Map();
  for (const c of contexts) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c.state ?? 'RUNNING');
  }
  return [...byName].filter(([, states]) => !states.includes('SUCCESS') && states.some(s => FAILED_STATES.has(s)))
    .map(([name, states]) => ({ name, states }));
}
// A checker declared in package.json but invoked by no script is a gate that
// exists on paper and never runs. The case that earned the rule: a repo carried
// `typescript` with no typecheck script -- build is tsup and tests are vitest,
// both esbuild, which strips types without checking them -- and real type
// errors sat in src/ invisible to CI. Same family as a workflow whose token
// cannot do what the workflow asks.
//
// `invokers` lists every binary that counts as running the checker, so a repo
// using vue-tsc or `astro check` instead of bare tsc is not flagged.
// A root script that hands off to a workspace runner cannot be judged from the
// root manifest: the invocation lives in a sub-package this collector does not
// fetch. A root running `pnpm -r typecheck` and one running `turbo run typecheck`
// both DO typecheck and were both false positives on the first pass.
//
// Note these are NOT caught by is_monorepo, which keys off the npm `workspaces`
// field; pnpm-workspace.yaml and turbo.json roots look like plain packages.
export const WORKSPACE_RUNNERS = [
  'pnpm -r', 'pnpm --filter', 'pnpm --recursive', 'nx ', 'lerna ',
  // bare `turbo build` is as much a delegation as `turbo run build`;
  // matching only the latter let a bare-`turbo` root through as a false positive.
  'turbo ',
  'npm -w', 'npm --workspace', 'yarn workspaces',
];

export const CHECKERS = [
  { dep: 'typescript', invokers: ['tsc', 'vue-tsc', 'svelte-check', 'astro check', 'tsgo'] },
  { dep: 'eslint', invokers: ['eslint'] },
  { dep: '@biomejs/biome', invokers: ['biome'] },
  { dep: 'oxlint', invokers: ['oxlint'] },
];
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_WEIGHT = { critical: 40, high: 15, medium: 6, low: 2, info: 0 };


const norm = v => (v == null ? null : String(v).trim().replace(/^v/i, ''));

/**
 * Which declared checkers are invoked by no script?
 * Returns [] when the repo delegates to a workspace runner, because the answer
 * then lives in a manifest this collector does not fetch.
 */
export function uninvokedCheckers(commands, depNames) {
  if (commands.length === 0) return [];      // no scripts == nothing to conclude
  const all = commands.join(' ; ').toLowerCase();
  if (WORKSPACE_RUNNERS.some(r => all.includes(r))) return [];
  const deps = new Set(depNames);
  return CHECKERS
    .filter(c => deps.has(c.dep))
    .filter(c => !c.invokers.some(bin => all.includes(bin.toLowerCase())));
}

/**
 * Split required status-check contexts into the two defects they can be.
 *
 * `observedNames` is what CI emitted RECENTLY -- the caller time-bounds it,
 * because check runs are frozen on their commit and a long-open PR keeps
 * reporting a matrix cell that was deleted months ago.
 *
 * Absent is not the same as dead. Only two absences prove death:
 *   - a SIBLING cell of the same job reported, so the job demonstrably runs and
 *     this cell is gone (protection requires `build-and-test (20)`; main reports
 *     (22) and (24), because the matrix is [22, 24]);
 *   - no workflow declares a job by that name at all (protection still requires
 *     `test (<package>)` after those jobs were renamed `python`/`nodejs`).
 *
 * Anything else is a live job that merely did not run here, which is a
 * different defect with a different repair -- see the two finding codes.
 */
/**
 * Strip the matrix cell GitHub appends to a job's check name:
 * `test (20, ubuntu-latest)` -> `test`. The leading `\s*` eats the separating
 * space, so no trim is needed.
 */
export const jobBaseName = n => String(n ?? '').replace(/\s*\([^()]*\)\s*$/, '');

/**
 * Widest EXPANDED matrix per (repo, workflow, job), from raw job rows.
 *
 * `rules/github-actions.md` caps a matrix at 6 jobs, and static parsing
 * cannot check it: a 3x2 matrix is ONE declared job in the YAML. Only the cells
 * that actually ran reveal the real width.
 *
 * Two traps, both found against live data, decide the shape here:
 *
 *   1. Taking the maximum across the whole window reports a matrix that has
 *      already been fixed. One repo ran a 9-cell `test` (node 20/22/24 x
 *      ubuntu/windows/macos) early in the window and 6 cells after its macOS
 *      removal landed. A window maximum files a stale finding against the repo
 *      that did the work, so width is read from the NEWEST run instead.
 *
 *   2. A skipped cell collapses. One `lint-and-test` job is 3 cells on
 *      push, but its scheduled canary gates the job off with
 *      `if: github.event_name != 'schedule'`, and GitHub then emits ONE
 *      unsuffixed skipped check rather than three. Reading width from the
 *      newest run alone therefore reports 1 for a 3-cell matrix. Skipped jobs
 *      are excluded, and "newest" is resolved per (workflow, job) rather than
 *      per run, so a job is measured from the last run in which it truly ran.
 *
 * Rows need `repo`, `workflow_name`, `name`, `conclusion`, `created_at`.
 */
export function matrixWidths(rows = []) {
  const best = new Map();                   // key -> { at, names:Set, meta }
  for (const r of rows) {
    if ((r.conclusion ?? '') === 'skipped') continue;
    const base = jobBaseName(r.name);
    const key = `${r.repo}\0${r.workflow_name}\0${base}`;
    const cur = best.get(key);
    if (!cur || r.created_at > cur.at) {
      best.set(key, {
        at: r.created_at, names: new Set([r.name]),
        repo: r.repo, workflow_name: r.workflow_name, base,
      });
    } else if (r.created_at === cur.at) {
      cur.names.add(r.name);
    }
  }
  return [...best.values()].map(v => ({
    repo: v.repo, workflow_name: v.workflow_name, base: v.base,
    cells: v.names.size, at: v.at,
  }));
}

/**
 * Does one deployment-branch-policy pattern match this branch? 1, 0 or null.
 *
 * GitHub documents these patterns as fnmatch patterns in which `*` does not
 * cross a `/` (so `release/*` does not match `release/a/b`). Only literals,
 * `*` and `?` are evaluated. `**` is read as `*` for a branch with no `/` in
 * it, which is the one case where the two cannot differ; `[`, `{` and `\` are
 * real syntax this does not evaluate, so they answer unknown.
 */
export function deploymentPatternMatches(pattern, branch) {
  if (typeof pattern !== 'string' || typeof branch !== 'string') return null;
  if (/[[\]{}\\]/.test(pattern)) return null;
  if (pattern.includes('**') && branch.includes('/')) return null;
  const re = new RegExp('^' + pattern.replace(/\*\*/g, '*').split('').map(c =>
    c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$');
  return re.test(branch) ? 1 : 0;
}

/**
 * Can `branch` deploy to this environment? 1, 0, or null when that cannot be
 * told from what was collected. Pure.
 *
 * `env` is an `environment` row; `settings` the repo's `deploy_settings` row.
 *   all       -- no restriction.
 *   custom    -- the branch must match a branch-type pattern. Tag patterns
 *                admit tags, never a branch. Unreadable patterns, or a
 *                pattern this cannot evaluate when nothing else matched, are
 *                unknown.
 *   protected -- the branch must be protected. GitHub lets every branch deploy
 *                when no branch in the repo is protected, so that case admits.
 *                A ruleset on the branch is unknown: whether GitHub counts it
 *                as protection here was not verified.
 */
export function environmentAdmitsBranch(env, settings, branch) {
  if (!env || !branch) return null;
  if (env.policy === 'all') return 1;
  if (env.policy === 'custom') {
    if (env.policies_readable !== 1) return null;
    let unknown = false;
    for (const line of (env.branch_policies ?? '').split('\n').filter(Boolean)) {
      const at = line.indexOf(':');
      const type = line.slice(0, at), pattern = line.slice(at + 1);
      if (type === 'tag') continue;
      const m = deploymentPatternMatches(pattern, branch);
      if (m === 1) return 1;
      if (m === null) unknown = true;
    }
    return unknown ? null : 0;
  }
  if (env.policy === 'protected') {
    if (!settings || settings.default_branch !== branch) return null;
    if (settings.default_protected === 1) return 1;
    if (settings.default_protected !== 0) return null;
    if (settings.any_branch_protected === 0) return 1;
    if (settings.any_branch_protected !== 1) return null;
    return settings.default_ruleset_rules === 0 ? 0 : null;
  }
  return null;
}

// ---- the committed Atlas map (rules/atlas-map.md) -------------------------
//
// rules/atlas-map.md, "Transition (ended 2026-09-30)": "made by the fleet's
// current engine version" was reported and not counted until the first
// pin-bump wave completed, and counts as a defect from then on. The wave to
// Atlas 1.24.0 ended when its last pull request merged, at the instant below
// (measured from GitHub: 78 of 78 merged). A snapshot taken before it keeps
// the finding at `info`, which the health score weighs at 0; one taken at or
// after it files `low`. The switch is a date, not a boolean, so that
// `npm run rebuild` still reproduces each earlier day's findings -- a flag
// flipped in source would rewrite every pre-wave snapshot. A missing map and
// a missing check counted from the start, and are unaffected by it.
export const ATLAS_ENGINE_BEHIND_COUNTS_SINCE = '2026-09-30T21:44:11Z';

/** Does an engine behind the fleet's count, for a snapshot taken at `takenAt`? Pure. */
export function engineBehindCounts(takenAt, since = ATLAS_ENGINE_BEHIND_COUNTS_SINCE) {
  const t = Date.parse(takenAt ?? ''), s = Date.parse(since);
  return Number.isFinite(t) && Number.isFinite(s) && t >= s;
}

/**
 * The Atlas version the fleet carries: the `@dogfood-lab/atlas@<v> check` pin
 * that the most repositories use in push-triggered CI. Pure.
 *
 * rules/atlas-map.md: "the whole fleet carries the same one. It moves by pull
 * request." So the fleet's version is what the repositories pin, and it moves
 * when a pin-bump wave lands -- not when npm publishes a newer engine. Each
 * repository counts once per pin it uses; a tie goes to the higher version.
 * `rows` are { repo, atlas_check, on_triggers } for non-archived repositories.
 * Returns { version, repos, pinned } or null when no repository pins one.
 */
export function fleetPin(rows) {
  const byPin = new Map();
  const pinned = new Set();
  for (const w of rows ?? []) {
    const push = (w.on_triggers ?? '').split(',').some(t => t === 'push' || t === 'pull_request');
    if (!push) continue;
    for (const pin of (w.atlas_check ?? '').split('\n')) {
      if (!pin || pin === 'unpinned' || !parseSemver(pin)) continue;
      if (!byPin.has(pin)) byPin.set(pin, new Set());
      byPin.get(pin).add(w.repo);
      pinned.add(w.repo);
    }
  }
  if (!byPin.size) return null;
  // compareSemver sorts newest first, which is the tie-break wanted here.
  const [version, repos] = [...byPin].sort(([a, ra], [b, rb]) =>
    rb.size - ra.size || compareSemver(parseSemver(a), parseSemver(b)))[0];
  return { version, repos: repos.size, pinned: pinned.size };
}

/**
 * The version maps and pins are measured against, for one snapshot.
 *
 * From the end of the first pin-bump wave (ATLAS_ENGINE_BEHIND_COUNTS_SINCE)
 * it is the fleet's own pin (fleetPin). Before it, it is npm's latest, which
 * is what those snapshots were reported against; keeping it means a rebuild
 * reproduces their findings. npm's latest is returned beside it either way.
 */
export function fleetEngineFor(db, sid) {
  const npm = db.prepare('SELECT version, error FROM atlas_fleet WHERE snapshot_id = ?').get(sid) ?? null;
  const takenAt = db.prepare('SELECT taken_at FROM snapshot WHERE id = ?').get(sid)?.taken_at;
  if (!engineBehindCounts(takenAt)) {
    return { version: npm?.version ?? null, source: 'npm-latest', npmLatest: npm?.version ?? null, npmError: npm?.error ?? null };
  }
  const pin = fleetPin(db.prepare(`SELECT w.repo, w.atlas_check, w.on_triggers FROM workflow w
    JOIN repo r ON r.snapshot_id = w.snapshot_id AND r.name = w.repo
    WHERE w.snapshot_id = ? AND r.is_archived = 0 AND w.atlas_check <> ''`).all(sid));
  return { version: pin?.version ?? null, source: 'fleet-pin', repos: pin?.repos ?? 0, pinned: pin?.pinned ?? 0,
    npmLatest: npm?.version ?? null, npmError: npm?.error ?? null };
}

const ATLAS_RULE = 'rules/atlas-map.md';
const isOlder = (v, fleet) => {
  const a = parseSemver(v), b = parseSemver(fleet);
  return a && b ? compareSemver(a, b) > 0 : null;
};

/**
 * The map-health findings for one repository. Pure.
 *
 * `workflows` are workflow rows (path, on_triggers, atlas_check). `hasMap` is
 * repo.has_atlas_map: NULL means the snapshot never looked, and yields nothing.
 * `scripts` are package.json commands: a check reached through an npm script
 * is not read from the workflow, so a script that carries one makes the
 * no-check finding unknown rather than fired.
 */
export function atlasMapFindings({
  hasMap, workflows = [], scripts = [], mapEngine = null, fleetVersion = null,
  engineCounts = false,
}) {
  const out = [];
  // "Runs workflows" means at least one file under .github/workflows/.
  if (!workflows.length || (hasMap !== 0 && hasMap !== 1)) return out;
  if (hasMap === 0) {
    out.push({
      code: 'ATLAS_MAP_MISSING', severity: 'medium',
      message: `Runs ${workflows.length} workflow file(s) and keeps no committed Atlas map (atlas/structure.json is not on the default branch).`,
      evidence: `${ATLAS_RULE}: "Every repository that runs workflows keeps a committed Atlas map on its default branch"`,
    });
    return out;
  }

  const pushLike = w => (w.on_triggers ?? '').split(',').some(t => t === 'push' || t === 'pull_request');
  const checks = workflows.flatMap(w => (w.atlas_check ?? '').split('\n').filter(Boolean)
    .map(pin => ({ path: w.path, pin, push: pushLike(w) })));
  const pinnedOnPush = checks.filter(c => c.push && c.pin !== 'unpinned');
  if (!pinnedOnPush.length) {
    const viaScript = scripts.some(s => /@dogfood-lab\/atlas\b[^;&|]*\bcheck\b/.test(s ?? ''));
    if (!viaScript) {
      const why = !checks.length ? 'no workflow runs `atlas check`'
        : checks.some(c => c.pin !== 'unpinned') ? `\`atlas check\` runs only in ${[...new Set(checks.filter(c => !c.push).map(c => c.path))].join(', ')}, which no push or pull request triggers`
        : '`atlas check` runs with no pinned version';
      out.push({
        code: 'ATLAS_CHECK_NOT_IN_CI', severity: 'medium',
        message: `A committed Atlas map, and ${why}: nothing tells a change that it moved the structure the map describes.`,
        evidence: `${ATLAS_RULE}: "CI runs \`npx --yes @dogfood-lab/atlas@<version> check\` as a step of an existing push-triggered workflow"`
          + (checks.length ? `; found ${checks.map(c => `${c.path}: ${c.pin}`).join(', ')}` : ''),
      });
    }
  }

  if (fleetVersion && parseSemver(fleetVersion)) {
    const pins = [...new Set(checks.map(c => c.pin).filter(p => p !== 'unpinned'))];
    const behindPins = pins.filter(p => isOlder(p, fleetVersion) === true);
    const engineBehind = mapEngine ? isOlder(mapEngine, fleetVersion) === true : false;
    if (behindPins.length || engineBehind) {
      const parts = [];
      if (behindPins.length) parts.push(`CI pins ${behindPins.join(', ')}`);
      if (engineBehind) parts.push(`the map was made by ${mapEngine}`);
      out.push({
        code: 'ATLAS_ENGINE_BEHIND', severity: engineCounts ? 'low' : 'info',
        message: `${parts.join(' and ')}; the fleet engine is ${fleetVersion}.`
          + (engineCounts ? '' : ' Reported, not counted: this snapshot predates the end of the first fleet pin-bump wave.'),
        evidence: `${ATLAS_RULE}: "made by the fleet's current engine version"; map engine ${mapEngine ?? 'not recorded (before 1.23.0)'}`,
      });
    }
  }
  return out;
}

// ---- where a red run broke, and whether the map saw it coming --------------
//
// A red default branch says THAT a workflow failed; the run's jobs say WHERE.
// The Atlas map names the same place by job key and step reference, so a
// failed step joins the door command it ran and any door finding (D1: the
// toolchain the job pins is one a package refuses; D2: a lockfile that lacks
// the job's platform) recorded against that exact step. A finding at a
// different step of the same door is not cited: it may be real, but it is
// not what broke this run.

// Built from the facts a map records; Atlas's own sentences are built the same
// way by its door-checks module, and the map holds facts only.
const DOOR_RULES = {
  D1: f => (`${f.package ?? 'a package'} ${f.version ?? ''} requires Node ${f.requires ?? '(unstated)'}`
    + `${f.refuses ? ' and refuses to start below it' : ''}, and the job pins ${(f.pins ?? []).join(', ') || 'an older one'}`
    + `${f.engineStrict ? ` (${f.engineStrict} sets engine-strict, so the install itself refuses)` : ''}`).replace(/ {2,}/g, ' '),
  'D1-python': f => `${f.manifest ?? 'the project'} requires Python ${f.requires ?? '(unstated)'}, and the job pins ${(f.pins ?? []).join(', ') || 'an older one'}`,
  D2: f => {
    const pk = f.packages ?? [];
    return `${f.tool ?? 'the install'} runs on ${(f.platforms ?? []).join(', ') || 'a platform'} from ${f.lock ?? 'a lockfile'}, which lacks that platform's build of ${pk.slice(0, 3).join(', ')}${pk.length > 3 ? ` and ${pk.length - 3} more` : ''}`;
  },
};

/** One sentence for an Atlas door finding, or null for a rule this does not know. Pure. */
export function doorFindingSentence(f) {
  return f && DOOR_RULES[f.rule] ? DOOR_RULES[f.rule](f) : null;
}

/** The first release whose maps record door findings; an older map is not measured. */
export const ATLAS_DOOR_CHECKS_SINCE = '1.24.0';

/**
 * The door-finding rows of a snapshot, for the report. Pure over the given
 * rows: `maps` are atlas_map rows, `doors` atlas_door rows (findings and
 * unresolved_checks as stored JSON). Returns the measured population as well
 * as the rows, because a map made before 1.24.0 records no door checks and
 * its silence is "not measured", never "clean".
 */
export function doorFindingRows(maps, doors) {
  const since = parseSemver(ATLAS_DOOR_CHECKS_SINCE);
  const measured = new Set(maps
    // compareSemver sorts newest first: <= 0 means "this release or newer".
    .filter(m => !m.error && m.engine && parseSemver(m.engine) && compareSemver(parseSemver(m.engine), since) <= 0)
    .map(m => m.repo));
  const rows = [], unresolved = new Map();
  const parse = t => { try { return JSON.parse(t); } catch { return null; } };
  for (const d of doors) {
    if (!measured.has(d.repo)) continue;
    for (const f of parse(d.findings) ?? []) {
      rows.push({ repo: d.repo, file: d.file, rule: f.rule, where: `${f.job} / ${f.step}`,
        says: doorFindingSentence(f) ?? `a ${f.rule} finding this version of housekeeping does not describe` });
    }
    for (const u of parse(d.unresolved_checks) ?? []) {
      const k = `${u.rule}: ${u.why}`;
      unresolved.set(k, (unresolved.get(k) ?? 0) + 1);
    }
  }
  rows.sort((a, b) => a.rule.localeCompare(b.rule) || a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file));
  return {
    measured: measured.size, mapped: maps.filter(m => !m.error).length, rows,
    unresolved: [...unresolved].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count),
  };
}

/**
 * One sentence on where a red run broke, for the CI finding's message. Pure.
 *
 * `steps` are run_failed_step rows of the run; `commands` the
 * atlas_door_command rows of its workflow file; `doorFindings` the parsed
 * `findings` of that door, or null when the map records none. Empty string
 * when the run was not read: silence, never a guess.
 */
export function failedStepNote({ steps = [], commands = [], doorFindings = null }) {
  if (!steps.length) return '';
  const parts = [], predicted = [];
  if (steps.length === 1 && steps[0].api_job == null) {
    const why = steps[0].unresolved ?? 'no job failed';
    return `${why[0].toUpperCase()}${why.slice(1)}.`;
  }
  for (const s of steps.slice(0, 3)) {
    const where = s.api_step ? `job "${s.api_job}", step "${s.api_step}"` : `job "${s.api_job}", outside any step`;
    if (s.step == null) {
      const said = !s.unresolved || s.unresolved === 'the job failed outside any step';
      parts.push(said ? where : `${where} (${s.unresolved})`);
      continue;
    }
    const cmd = commands.find(c => c.job === s.job && c.step === s.step);
    const runs = cmd?.programs ? ` (runs ${cmd.programs.split('\n').join(', ')}${cmd.directory ? ` in ${cmd.directory}/` : ''})` : '';
    parts.push(`${where}${runs}`);
    for (const f of doorFindings ?? []) {
      if (f?.job === s.job && String(f?.step) === s.step && DOOR_RULES[f.rule]) predicted.push(`${f.rule}: ${DOOR_RULES[f.rule](f)}`);
    }
  }
  const more = steps.length > 3 ? ` and ${steps.length - 3} more` : '';
  return `It broke at ${parts.join('; ')}${more}.`
    + (predicted.length ? ` The Atlas map flagged that step before it ran: ${predicted.join('; ')}.` : '');
}

export function classifyRequiredChecks({ required, observedNames, declaredJobs }) {
  // GitHub appends the matrix cell in parentheses only when a job has no
  // `name:`, so the text before it is the job id.
  const base = c => c.replace(/\s*\([^()]*\)\s*$/, '');
  const universe = new Set(observedNames);
  const observedBases = new Set([...universe].map(base));
  const jobs = new Set(declaredJobs);

  const stale = required
    .filter(c => !universe.has(c))
    .filter(c => observedBases.has(base(c)) || !jobs.has(base(c)));
  const staleSet = new Set(stale);
  // Everything not proven dead. A stale context is absent from every PR by
  // definition, so leaving it in `live` would bill one defect twice under two
  // repairs that contradict each other.
  return { stale, live: required.filter(c => !staleSet.has(c)) };
}

/**
 * Which open PRs are missing a live required check because their files missed
 * the workflow's paths filter. `live` comes from classifyRequiredChecks;
 * `observed` is the repo's check_context rows.
 */
export function gatedPrs({ prs, live, observed }) {
  const seenByPr = new Map();
  for (const c of observed) {
    if (c.source !== 'pr' || c.pr_number == null) continue;
    if (!seenByPr.has(c.pr_number)) seenByPr.set(c.pr_number, new Set());
    seenByPr.get(c.pr_number).add(c.name);
  }
  // Drafts are not trying to merge, and a PR opened moments ago may have
  // checks still being created. The window is measured off `created_at`,
  // NOT `updated_at`: updated_at moves for comments, labels and rebases,
  // none of which say anything about whether CI ran, so a long-open PR
  // that someone commented on today would read as "too fresh to judge".
  // created_at never moves.
  //
  // This deliberately holds fire for a day. Dependabot PRs opened 90
  // minutes before a snapshot can have zero checks and never get any
  // (site-only changes against a paths-gated ci.yml), but at that age
  // "no checks yet" and "no checks ever" are genuinely indistinguishable.
  // They surface on the next run.
  // Residual gap: a week-old PR force-pushed seconds before a snapshot.
  // Rare, self-heals, and the cheap direction to be wrong in.
  //
  // A conflicting PR is left out. GitHub builds no merge ref for it, so no
  // pull_request workflow runs at all, and a check missing from it says
  // nothing about paths; the repair is a rebase, which PR_CONFLICTED already
  // asks for. Counting them called eight repos' trigger broken when every
  // blocked PR there was simply conflicted. The cost: a conflicted PR that
  // ALSO misses the paths filter is only reported once it is rebased.
  const settled = prs.filter(p => !p.is_draft && (p.age_days ?? 0) >= 1 && p.mergeable !== 'CONFLICTING');
  const blocked = settled
    .map(p => ({ p, absent: live.filter(c => !(seenByPr.get(p.number)?.has(c))) }))
    .filter(x => x.absent.length);
  return { settled, blocked };
}

/**
 * `metaRepos` are exempt from product-hygiene rules: repos that hold org
 * defaults, assets or tooling rather than a shipped product. Which repos those
 * are is a fact about the org, so it comes from the config file (config.mjs),
 * not from this file. Tests pass it explicitly.
 */
export function analyze(db, sid, { metaRepos = loadConfig().metaRepos } = {}) {
  const META_REPOS = new Set(metaRepos);
  db.prepare('DELETE FROM finding WHERE snapshot_id = ?').run(sid);
  const add = db.prepare('INSERT INTO finding VALUES (?,?,?,?,?,?,?)');
  const F = (repo, code, severity, category, message, evidence = null) =>
    add.run(sid, repo, code, severity, category, message, evidence);

  const repos = db.prepare('SELECT * FROM repo WHERE snapshot_id = ?').all(sid);
  const q = (sql, ...p) => db.prepare(sql).all(sid, ...p);

  const wfs = q('SELECT * FROM workflow WHERE snapshot_id = ?');
  // "main is red" and "a PR branch is red" are different defects with different owners.
  const runs = q('SELECT * FROM workflow_run WHERE snapshot_id = ? AND is_latest_on_default = 1');
  const branchRuns = q(`SELECT * FROM workflow_run
    WHERE snapshot_id = ? AND is_latest_for_workflow = 1 AND on_default_branch = 0`);
  const allRuns = q('SELECT * FROM workflow_run WHERE snapshot_id = ?');
  const fps = q('SELECT * FROM file_presence WHERE snapshot_id = ?');
  const tags = q('SELECT * FROM tag WHERE snapshot_id = ?');
  const prs = q('SELECT * FROM pull_request WHERE snapshot_id = ?');
  const issues = q('SELECT * FROM issue WHERE snapshot_id = ?');
  const pkgScripts = q('SELECT * FROM package_script WHERE snapshot_id = ?');
  const pkgDeps = q('SELECT * FROM package_dep WHERE snapshot_id = ?');

  const byRepo = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.repo)) m.set(r.repo, []);
      m.get(r.repo).push(r);
    }
    return m;
  };
  const wfBy = byRepo(wfs), runBy = byRepo(runs), allRunBy = byRepo(allRuns);
  const branchRunBy = byRepo(branchRuns);
  const prBy = byRepo(prs), issueBy = byRepo(issues);
  const scriptBy = byRepo(pkgScripts), depBy = byRepo(pkgDeps);
  const fpBy = new Map(fps.map(f => [f.repo, f]));
  const tagBy = byRepo(tags);

  // Both empty when the snapshot predates the protection sweep, which the
  // gate rules below read as "not measured" rather than "nothing is gated".
  //
  // KNOWN GAP: this reads CLASSIC branch protection only. Rulesets are a second,
  // independent mechanism that can also require status checks, and they do not
  // appear in `branchProtectionRule` -- they need
  // GET /repos/{o}/{r}/rules/branches/{branch}. Where no ruleset declares a
  // required status check, classic protection is the whole story; that was
  // true of the org this was built against, and it is not true in general.
  // The org-level ruleset list needs the admin:org scope to read at all, so a
  // ruleset added later would be invisible here. Re-measure before trusting a
  // clean result on a repo whose PRs are stuck for no visible reason.
  //
  // Rulesets also carry non-check gates this rule deliberately ignores, because
  // they are policy rather than defect: a ruleset can set
  // require_extra_approval_for_unattributed_changes, which holds every
  // Dependabot PR for one approving review even with
  // required_approving_review_count at 0 and all contexts green.
  const protBy = new Map(
    q('SELECT * FROM branch_protection WHERE snapshot_id = ?').map(x => [x.repo, x]),
  );
  const ctxBy = byRepo(q('SELECT * FROM check_context WHERE snapshot_id = ?'));

  // What a deploy needs from the repo's settings. Empty for a snapshot taken
  // before the pass, and a repo with no row was not asked: both are silence.
  const deployBy = new Map(
    q('SELECT * FROM deploy_settings WHERE snapshot_id = ?').map(x => [x.repo, x]),
  );
  const envBy = byRepo(q('SELECT * FROM environment WHERE snapshot_id = ?'));
  const wfEnvBy = byRepo(q('SELECT * FROM workflow_environment WHERE snapshot_id = ?'));

  // The committed maps and the engine version they are measured against
  // (fleetEngineFor: the fleet's own pin after the first wave, npm's latest
  // before it). No version to measure against leaves the engine check silent.
  const atlasBy = new Map(
    q('SELECT * FROM atlas_map WHERE snapshot_id = ?').map(x => [x.repo, x]),
  );
  const fleetEngine = fleetEngineFor(db, sid).version;
  const engineCounts = engineBehindCounts(db.prepare('SELECT taken_at FROM snapshot WHERE id = ?').get(sid)?.taken_at);

  // Where each red run broke, and the door it broke in. Keyed by run id and by
  // repo + workflow path; empty for a snapshot before collector 1.4.0, when the
  // CI findings simply say less.
  const failedStepsBy = new Map();
  for (const x of q('SELECT * FROM run_failed_step WHERE snapshot_id = ? ORDER BY rowid')) {
    if (!failedStepsBy.has(x.run_id)) failedStepsBy.set(x.run_id, []);
    failedStepsBy.get(x.run_id).push(x);
  }
  const doorKey = (repo, file) => `${repo}\n${file}`;
  const doorCmdsBy = new Map();
  for (const c of q('SELECT * FROM atlas_door_command WHERE snapshot_id = ?')) {
    const k = doorKey(c.repo, c.file);
    if (!doorCmdsBy.has(k)) doorCmdsBy.set(k, []);
    doorCmdsBy.get(k).push(c);
  }
  const doorFindingsBy = new Map(
    q('SELECT repo, file, findings FROM atlas_door WHERE snapshot_id = ? AND findings IS NOT NULL')
      .map(d => { try { return [doorKey(d.repo, d.file), JSON.parse(d.findings)]; } catch { return [doorKey(d.repo, d.file), null]; } }),
  );
  const whereItBroke = (repo, x) => {
    const note = failedStepNote({
      steps: failedStepsBy.get(x.run_id) ?? [],
      commands: doorCmdsBy.get(doorKey(repo, x.path)) ?? [],
      doorFindings: doorFindingsBy.get(doorKey(repo, x.path)) ?? null,
    });
    return note ? ` ${note}` : '';
  };

  // Empty when the snapshot predates the security sweep. The rules below then
  // see `undefined` and stay silent, rather than reporting a clean org.
  const secByRepo = new Map(
    q('SELECT * FROM repo_security WHERE snapshot_id = ?').map(x => [x.repo, x]),
  );
  // Committed lockfiles audited by the warehouse itself; empty when the
  // snapshot predates that pass. A row with `error` set is UNKNOWN and is
  // skipped below -- it must never read as zero exposure.
  const lockBy = byRepo(q('SELECT * FROM lockfile WHERE snapshot_id = ?'));
  const lockAdvBy = byRepo(q(`SELECT * FROM lockfile_advisory WHERE snapshot_id = ?
    AND severity IN ('critical','high')`));

  // ---- Actions cost --------------------------------------------------------
  // Only the repos the invoice ranked highest get priced, so absence here means
  // NOT MEASURED. Every rule below is gated on `costOK`, which requires both a
  // row and a reconciliation that agreed with the invoice: a cost claim built
  // on a partial window is the exact failure mode this warehouse keeps finding
  // in its own rules.
  const reconBy = new Map(
    q('SELECT * FROM cost_reconciliation WHERE snapshot_id = ?').map(x => [x.repo, x]),
  );
  const costOK = repo => reconBy.get(repo)?.trustworthy === 1;
  const costRollup = new Map(
    q(`SELECT repo,
         SUM(cost_usd) cost, SUM(billable_minutes) minutes,
         SUM(CASE WHEN conclusion='failure'   THEN cost_usd         ELSE 0 END) fail_cost,
         SUM(CASE WHEN conclusion='failure'   THEN billable_minutes ELSE 0 END) fail_min,
         SUM(CASE WHEN conclusion='failure'   THEN 1 ELSE 0 END)                fail_runs,
         SUM(CASE WHEN conclusion='cancelled' THEN cost_usd         ELSE 0 END) cancel_cost,
         COUNT(*) runs, SUM(unpriced_minutes) unpriced_min
       FROM run_cost WHERE snapshot_id = ? GROUP BY repo`).map(x => [x.repo, x]),
  );
  // Minutes AND dollars per runner class, so the static WF_MACOS_RUNNER /
  // WF_WINDOWS_RUNNER findings can quote what the runner actually cost instead
  // of the "~10x" estimate they carried before this data existed. Grouped on
  // the stored `runner_class` rather than a LIKE over labels: `self-hosted`
  // plus a `macos` label is free hardware, and matching the string would bill
  // it at the 10x rate.
  const classCost = new Map(
    q(`SELECT repo,
         SUM(CASE WHEN runner_class='MACOS'   THEN minutes  ELSE 0 END) macos_min,
         SUM(CASE WHEN runner_class='MACOS'   THEN cost_usd ELSE 0 END) macos_cost,
         SUM(CASE WHEN runner_class='WINDOWS' THEN minutes  ELSE 0 END) windows_min,
         SUM(CASE WHEN runner_class='WINDOWS' THEN cost_usd ELSE 0 END) windows_cost,
         SUM(CASE WHEN runner_class='UBUNTU'  THEN minutes  ELSE 0 END) ubuntu_min,
         SUM(CASE WHEN runner_class='UBUNTU'  THEN cost_usd ELSE 0 END) ubuntu_cost
       FROM run_cost_job WHERE snapshot_id = ? GROUP BY repo`).map(x => [x.repo, x]),
  );

  // Widest expanded matrix per (workflow, job). The decision lives in
  // matrixWidths() so its two traps are unit-tested; the query only feeds it.
  const matrixBy = byRepo(matrixWidths(q(`
    SELECT j.repo, c.workflow_name, j.name, j.conclusion, c.created_at
    FROM run_cost_job j JOIN run_cost c
      ON c.snapshot_id = j.snapshot_id AND c.run_id = j.run_id
    WHERE j.snapshot_id = ?`)));

  // Gross Actions spend per repo straight off the invoice. Distinct from
  // costRollup: this is every run in the month whether or not we priced it.
  const billedBy = new Map(
    q(`SELECT repo, SUM(gross) gross, SUM(net) net FROM billing_usage
       WHERE snapshot_id = ? AND product = 'actions' AND sku <> 'Actions storage'
         AND repo IS NOT NULL GROUP BY repo`).map(x => [x.repo, x]),
  );

  for (const r of repos) {
    const name = r.name;
    if (r.is_archived) continue;                    // archived is a deliberate end-state
    const isMeta = META_REPOS.has(name);
    const fp = fpBy.get(name) ?? {};
    const myWfs = wfBy.get(name) ?? [];
    const myLatest = runBy.get(name) ?? [];
    const myPrs = prBy.get(name) ?? [];
    const myIssues = issueBy.get(name) ?? [];

    // ---- lifecycle -------------------------------------------------------
    if (r.is_empty) {
      F(name, 'REPO_EMPTY', 'medium', 'lifecycle',
        'Repository has no commits.', `created ${r.created_at}`);
      continue;                                     // nothing else is measurable
    }
    if (r.default_branch && r.default_branch !== 'main') {
      F(name, 'DEFAULT_BRANCH_NOT_MAIN', 'high', 'lifecycle',
        `Default branch is "${r.default_branch}", not "main".`,
        'rules/repo-first.md: "Default branch is main"');
    }
    // ---- security --------------------------------------------------------
    // Exposure is not derivable from anything else here: a repo can be green,
    // released, documented and still carry critical advisories. Alerts can sit
    // open for months in an org whose audit measures everything else, because
    // no rule about CI, releases or hygiene ever looks at them.
    //
    // Two findings, not one, because they have different remedies. Alerts are
    // the exposure. The disabled setting is the REASON the exposure persists:
    // GitHub detects the advisory and never opens a PR, so the count only grows.
    // Collapsing them would hide the cause behind the symptom.
    const sec = secByRepo.get(name);

    // GitHub's alert coverage is silently per-manifest (lockfile.mjs has the
    // measurements). This is the false negative stated from one row: scanning
    // is ON for the repo, the committed lockfile resolves to critical/high
    // advisories, and GitHub reports zero alerts for that exact manifest. It
    // is `high` regardless of the advisory's own severity because the defect
    // is that nothing will ever open a fix PR -- the same reasoning as
    // SECURITY_FIXES_DISABLED. Repos where scanning is off are already
    // SECURITY_SCANNING_DISABLED; double-billing them would drown that.
    //
    // Two codes, because the remedies differ: a shipped dependency is fixed by
    // a version bump users receive; a dev-only one (vitest, esbuild) is fixed
    // by a toolchain bump nobody installs. Collapsing them makes a critical
    // count read as shipped exposure when most of it is test runners. A repo
    // of vendored examples can carry a hundred lockfiles; each is a real row,
    // and the report groups by repo so it does not drown the rest.
    for (const l of lockBy.get(name) ?? []) {
      if (l.error != null) continue;                              // not measured
      if (l.github_alerts > 0) continue;                          // GitHub sees this one
      if (!sec || sec.vuln_alerts !== 1) continue;                // that repo is SECURITY_SCANNING_DISABLED's
      const total = (l.critical ?? 0) + (l.high ?? 0);
      if (total === 0) continue;
      const advs = (lockAdvBy.get(name) ?? []).filter(a => a.path === l.path);
      const bySev = (list) => list.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1))[0];
      const ev = (w) => w ? `${w.package}@${w.version} ${w.ghsa} (${w.severity}); npm bulk advisory API vs manifest_path` : l.path;
      // A snapshot taken before dev/prod attribution has NULL here. Report the
      // exposure without the split rather than guessing which side it falls
      // on -- and say so, so the reader re-sweeps instead of trusting it.
      if (l.prod_critical == null) {
        F(name, 'SECURITY_LOCKFILE_UNREPORTED', 'high', 'security',
          `GitHub reports 0 alerts for ${l.path} while its committed lockfile resolves to `
          + `${l.critical} critical and ${l.high} high advisories (dev/prod not attributed in this snapshot -- re-sweep). `
          + 'That zero is a false negative: Dependabot will never open a fix PR for what it has not counted.',
          ev(bySev(advs)));
        continue;
      }
      const prod = l.prod_critical + (l.prod_high ?? 0);
      const devOnly = total - prod;
      const pick = (wantDev) => bySev(advs.filter(a => (a.dev === 1) === wantDev));
      if (prod > 0) {
        F(name, 'SECURITY_LOCKFILE_UNREPORTED', 'high', 'security',
          `GitHub reports 0 alerts for ${l.path} while its committed lockfile resolves to `
          + `${l.prod_critical} critical and ${l.prod_high} high advisories on SHIPPED dependencies. `
          + 'That zero is a false negative: Dependabot will never open a fix PR for what it has not counted.',
          ev(pick(false)));
      }
      if (devOnly > 0) {
        F(name, 'SECURITY_LOCKFILE_UNREPORTED_DEV', 'medium', 'security',
          `GitHub reports 0 alerts for ${l.path} while ${devOnly} critical/high advisor${devOnly === 1 ? 'y' : 'ies'} `
          + 'sit on dev-only packages (test runner, bundler). Not shipped, but the toolchain runs it on every CI job.',
          ev(pick(true)));
      }
    }

    if (sec && sec.alerts_total > 0) {
      const worst = sec.critical > 0 ? 'critical' : sec.high > 0 ? 'high' : 'medium';
      const parts = [];
      if (sec.critical) parts.push(`${sec.critical} critical`);
      if (sec.high) parts.push(`${sec.high} high`);
      if (sec.medium) parts.push(`${sec.medium} medium`);
      if (sec.low) parts.push(`${sec.low} low`);
      F(name, 'SECURITY_ALERTS_OPEN', worst, 'security',
        `${sec.alerts_total} open Dependabot alerts (${parts.join(', ')}); oldest ${sec.oldest_age_days} days.`,
        `${sec.fixable} of ${sec.alerts_total} have a patched version available`);
    }
    // The quietest failure of all: a repo GitHub is not scanning reports zero
    // alerts, which is indistinguishable from a clean repo in every other view.
    // A sweep that counts alerts without asking whether the counter is switched
    // on reports every such repo as healthy.
    if (sec && sec.vuln_alerts === 0) {
      F(name, 'SECURITY_SCANNING_DISABLED', 'high', 'security',
        'Dependabot vulnerability alerts are off, so this repo is not scanned and its zero-alert count means nothing.',
        'GitHub repos/<repo>/vulnerability-alerts: 404');
    }
    // Only a finding where there is something to fix. A quiet repo with the
    // setting off is a preference; an exposed one is a leak that cannot close.
    if (sec && sec.auto_security_fixes === 0 && sec.alerts_total > 0) {
      F(name, 'SECURITY_FIXES_DISABLED', 'high', 'security',
        `Dependabot security updates are off while ${sec.alerts_total} alerts are open, so no fix PR will ever be opened.`,
        'GitHub repos/<repo>/automated-security-fixes: enabled=false');
    }

    if (r.days_since_push != null && r.days_since_push > 180) {
      F(name, 'REPO_DORMANT', 'low', 'lifecycle',
        `No push in ${r.days_since_push} days and not archived.`,
        `pushed_at ${r.pushed_at}`);
    }

    // ---- CI health -------------------------------------------------------
    // The rollup is read through the head's own checks when the snapshot has
    // them: a rollup red only with cancelled runs that a green run of the
    // same check replaced is not a failing mainline (failingHeadChecks).
    if (r.ci_rollup === 'FAILURE' || r.ci_rollup === 'ERROR') {
      const head = (ctxBy.get(name) ?? []).filter(c => c.source === 'default');
      const failing = failingHeadChecks(head);
      const at = `${r.default_branch}@${(r.head_oid ?? '').slice(0, 7)}`;
      // The collector reads the first 100 checks of a commit (most seen: 19).
      // A red rollup whose failing check could lie past that page is read as
      // the rollup says, never as clean.
      if (failing === null || (failing.length === 0 && head.length >= 100)) {
        F(name, 'CI_FAILING', 'high', 'ci', `Default-branch check rollup is ${r.ci_rollup}.`, at);
      } else if (failing.length) {
        F(name, 'CI_FAILING', 'high', 'ci',
          `Default-branch checks failing: ${failing.map(c => `${c.name} (${[...new Set(c.states)].join(', ')})`).join('; ')}.`,
          `${at}; rollup ${r.ci_rollup}`);
      }
    }
    // A run only speaks for the mainline if its workflow could still be
    // triggered by a push today. Match the run back to the workflow file it
    // came from; if that file is gone or no longer takes push/pull_request,
    // the run is history rather than a live signal.
    const wfByPath = new Map(myWfs.map(w => [w.path, w]));
    const wfTriggers = (x) => wfByPath.get(x.path)?.on_triggers ?? null;
    const canStillRunOnPush = (x) => {
      const t = wfTriggers(x);
      if (t == null) return true;   // unknown shape: keep the louder reading
      return t.split(',').some(s => s === 'push' || s === 'pull_request');
    };

    const failing = myLatest.filter(x => x.conclusion === 'failure' || x.conclusion === 'timed_out');
    for (const x of failing) {
      // A run's event decides what its failure means. Only push-like events say
      // "the default branch is broken"; cron and Dependabot say something else.
      if (x.event === 'dynamic') {
        F(name, 'CI_DEPENDABOT_FAILING', 'medium', 'backlog',
          `Dependabot security-update run "${x.workflow_name}" failed.`, x.url);
      } else if (x.event === 'schedule') {
        F(name, 'CI_SCHEDULED_FAILING', 'medium', 'ci',
          `Scheduled workflow "${x.workflow_name}" is failing (last run ${x.created_at?.slice(0, 10)}).`
          + whereItBroke(name, x),
          x.url);
      } else if (!canStillRunOnPush(x)) {
        // A workflow that no longer fires on push cannot refresh its
        // default-branch history. When publish.yml moves to `release: published`
        // only, its last main-branch run is frozen where it stood and will never
        // update, while the workflow itself can be demonstrably healthy (still
        // shipping releases). Reading that stale run as a broken mainline is the
        // same error class as reading a deleted workflow's last failure as live.
        F(name, 'CI_STALE_TRIGGER_FAILING', 'info', 'ci',
          `"${x.workflow_name}" last failed on ${r.default_branch} (${x.created_at?.slice(0, 10)}) `
          + `under triggers it no longer has; it now runs on ${wfTriggers(x) || 'other events'}.`
          + whereItBroke(name, x),
          x.url);
      } else {
        F(name, 'CI_RUN_FAILING', 'high', 'ci',
          `Latest ${r.default_branch} run of "${x.workflow_name}" concluded ${x.conclusion} (${x.event}).`
          + whereItBroke(name, x),
          x.url);
      }
    }
    // Red PR branches are backlog, not a broken default branch.
    const branchFailing = (branchRunBy.get(name) ?? [])
      .filter(x => x.conclusion === 'failure' || x.conclusion === 'timed_out');
    for (const x of branchFailing) {
      const bot = /^dependabot\//.test(x.branch ?? '');
      F(name, bot ? 'CI_DEPENDABOT_FAILING' : 'CI_BRANCH_FAILING', 'medium', 'backlog',
        `"${x.workflow_name}" failing on ${bot ? 'a Dependabot' : 'non-default'} branch "${x.branch}".`,
        x.url);
    }
    // ---- branch-protection gates ----------------------------------------
    // A required status check is the last thing between a PR and main. When the
    // gate names a context nothing emits, the PR is BLOCKED forever -- and every
    // other view still reads green: `gh run list` is all-success, the default
    // branch rollup is SUCCESS, and only mergeStateStatus dissents. Every open
    // PR in such a repo is unmergeable without --admin, and no rule that reads
    // runs alone can see it.
    //
    // rules/shipcheck-product-standards.md, "CI verification (Non-Negotiable):
    // After pushing, verify CI passes on the repo (`gh run list --limit 1`) ...
    // Never leave a repo with failing CI." A gate whose verdict can never be
    // obtained makes that unsatisfiable, and unlike a red run it is invisible to
    // the exact command the rule names.
    //
    // Two codes, because the repair lands in different files and neither
    // substitutes for the other:
    //   STALE -- no commit anywhere reports it. The job was renamed, its matrix
    //     cell was dropped, or its workflow left pull_request. Fix belongs in
    //     protection (drop the context) or in the matrix (restore the cell).
    //   GATED -- the default branch reports it, a PR head does not. The job is
    //     alive and green; that PR's file set just missed the workflow's paths
    //     filter (rules/github-actions.md requires those filters, so this is a
    //     cost rule and a merge gate pulling against each other). Fix belongs in
    //     the workflow trigger. Dropping the context would retire a live gate.
    const prot = protBy.get(name);
    const required = prot?.contexts ? prot.contexts.split('\n').filter(Boolean) : [];
    const observed = ctxBy.get(name) ?? [];
    // Check runs are frozen on the commit they ran against, so a stale PR head
    // keeps reporting a matrix cell for as long as the PR stays open. Evidence
    // of what CI emits TODAY has to be time-bounded or a dropped cell looks
    // alive forever: a repo that deleted its Python 3.11 cell still had two
    // earlier PRs carrying "Python 3.11 on ubuntu-latest" three months
    // later. Same distinction
    // CI_STALE_TRIGGER_FAILING draws -- an old run is history, not evidence.
    // The default branch head is exempt: it is current by construction.
    const FRESH_PR_DAYS = 30;
    const freshPrs = new Set(
      myPrs.filter(p => (p.stale_days ?? Infinity) <= FRESH_PR_DAYS).map(p => p.number),
    );
    const universe = new Set(
      observed
        .filter(c => c.source === 'default' || freshPrs.has(c.pr_number))
        .map(c => c.name),
    );
    // An empty universe cannot tell a dead gate from a repo whose CI has simply
    // not run yet, so it buys silence rather than a confident wrong finding.
    if (required.length && universe.size) {
      const { stale, live } = classifyRequiredChecks({
        required,
        observedNames: universe,
        declaredJobs: myWfs.flatMap(w => (w.job_names ?? '').split('\n').filter(Boolean)),
      });
      if (stale.length) {
        F(name, 'CI_REQUIRED_CHECK_STALE', 'high', 'ci',
          `${stale.length} of ${required.length} required status checks are reported by no job: `
          + `every PR is BLOCKED and cannot merge without --admin.`,
          `never reported on ${r.default_branch} or any open PR head: `
          + stale.map(c => `"${c}"`).join(', '));
      }
      if (live.length) {
        const { settled, blocked } = gatedPrs({ prs: myPrs, live, observed });
        if (blocked.length) {
          const worst = blocked.slice().sort((a, b) => b.absent.length - a.absent.length)[0];
          F(name, 'CI_REQUIRED_CHECK_GATED', 'medium', 'ci',
            `${blocked.length} of ${settled.length} open PRs without conflicts are BLOCKED by required `
            + `checks that never ran on them: the job still exists, the PR's files just missed its paths filter.`,
            `#${worst.p.number} is missing ${worst.absent.map(c => `"${c}"`).join(', ')}`
            + (blocked.length > 1 ? `; also #${blocked.filter(x => x !== worst).map(x => x.p.number).join(', #')}` : ''));
        }
      }
    }

    // ---- settings a deploy depends on -----------------------------------
    // rules/shipcheck-product-standards.md, "CI verification (Non-Negotiable):
    // ... Never leave a repo with failing CI." A deploy whose repository
    // settings refuse it cannot succeed as configured, however correct the
    // workflow is -- and the workflow file is all a code review ever sees. Two
    // causes met in practice are exactly this: Pages switched off under a
    // deploy-pages workflow, and an environment whose branch policy still
    // named the old default branch.
    //
    // Both codes stay silent unless the setting was READ. No deploy_settings
    // row (not asked, or an older snapshot), a status other than the ones the
    // endpoint documents, a pattern or protection state this cannot evaluate:
    // each is unknown, and unknown is never a finding.
    const ds = deployBy.get(name);
    const pagesWfs = myWfs.filter(w => (w.pages_deploy_jobs ?? '') !== '');
    if (ds && ds.pages_enabled === 0 && pagesWfs.length) {
      const doors = pagesWfs.map(w => `${w.path} (${w.pages_deploy_jobs.split('\n').join(', ')})`);
      F(name, 'CI_PAGES_NOT_ENABLED', 'high', 'ci',
        `${doors.length === 1 ? 'A workflow deploys' : `${doors.length} workflows deploy`} to GitHub Pages `
        + 'with actions/deploy-pages, and Pages is not enabled for this repository: the deploy job cannot succeed.',
        `GitHub repos/<repo>/pages: ${ds.pages_status}; ${doors.join('; ')}; `
        + 'rules/shipcheck-product-standards.md: "Never leave a repo with failing CI"');
    }
    if (ds && ds.environments_status === 200 && r.default_branch) {
      const envs = new Map((envBy.get(name) ?? []).map(e => [String(e.name).toLowerCase(), e]));
      const jobsByEnv = new Map();
      for (const j of wfEnvBy.get(name) ?? []) {
        if (j.runs_on_default !== 1) continue;
        const k = String(j.environment).toLowerCase();
        if (!jobsByEnv.has(k)) jobsByEnv.set(k, []);
        jobsByEnv.get(k).push(j);
      }
      for (const [k, jobs] of jobsByEnv) {
        // Named by a job but absent from the repo: GitHub creates it on first
        // use with no branch policy, so nothing refuses the deploy.
        const env = envs.get(k);
        if (!env) continue;
        if (environmentAdmitsBranch(env, ds, r.default_branch) !== 0) continue;
        const allows = env.policy === 'protected'
          ? `protected branches only, and "${r.default_branch}" is not protected`
          : `only ${(env.branch_policies ?? '').split('\n').filter(Boolean).join(', ') || 'no branch at all'}`;
        F(name, 'CI_ENVIRONMENT_EXCLUDES_DEFAULT', 'high', 'ci',
          `Environment "${env.name}" admits ${allows}, so ${jobs.length === 1 ? 'the job' : `the ${jobs.length} jobs`} `
          + `that deploy${jobs.length === 1 ? 's' : ''} to it from "${r.default_branch}" cannot succeed.`,
          `${jobs.map(j => `${j.path}: ${j.job}`).join('; ')}; GitHub environments/${env.name} `
          + `deployment branch policy: ${env.policy}; `
          + 'rules/shipcheck-product-standards.md: "Never leave a repo with failing CI"');
      }
    }

    if (!isMeta && myWfs.length === 0) {
      F(name, 'CI_NO_WORKFLOWS', 'medium', 'ci',
        'No GitHub Actions workflows: nothing verifies this repo on push.',
        `${r.primary_language ?? 'unknown'} repo, ${r.disk_usage_kb}KB`);
    }
    if (myWfs.length > 0 && (allRunBy.get(name) ?? []).length === 0) {
      F(name, 'CI_NEVER_RAN', 'medium', 'ci',
        `${myWfs.length} workflow file(s) present but zero runs recorded.`,
        myWfs.map(w => w.path).join(', '));
    }

    // ---- declared-but-never-invoked checkers -----------------------------
    const myScripts = scriptBy.get(name) ?? [];
    for (const c of uninvokedCheckers(
      myScripts.map(x => x.command ?? ''),
      (depBy.get(name) ?? []).map(d => d.name),
    )) {
      F(name, 'PKG_CHECKER_NEVER_RUN', 'low', 'hygiene',
        `"${c.dep}" is declared but no npm script invokes it (looked for ${c.invokers.join(', ')}).`,
        `scripts: ${myScripts.map(x => x.name).join(', ').slice(0, 160)}`);
    }

    // ---- the committed Atlas map (rules/atlas-map.md) --------------------
    // The rule, in force since 2026-09-30: every repository that runs workflows keeps
    // a committed map and runs `atlas check` in CI; archived repositories are
    // exempt (skipped above). The decision is atlasMapFindings(), so both
    // directions are unit-tested. A snapshot that did not look for the map
    // (has_atlas_map NULL) yields nothing.
    //
    // Severity: a missing map and a missing check are `medium`, as
    // CI_NO_WORKFLOWS is -- a verification the org requires, absent -- and as
    // REPO_EMPTY is among the lifecycle findings. Neither breaks a build today.
    // "Map older than the branch" is deliberately not a finding: a map needs
    // regenerating only when the structure changes, and `atlas check` in CI is
    // what enforces that.
    for (const f of atlasMapFindings({
      hasMap: r.has_atlas_map,
      workflows: myWfs,
      scripts: myScripts.map(x => x.command ?? ''),
      mapEngine: atlasBy.get(name)?.engine ?? null,
      fleetVersion: fleetEngine,
      engineCounts,
    })) {
      F(name, f.code, f.severity, 'atlas', f.message, f.evidence);
    }

    // ---- Actions cost + shape rules (rules/github-actions.md) ------------
    // The cap counts PUSH-TRIGGERED workflows only (rules/github-actions.md).
    // Counting every file puts most repos out of compliance with a rule whose
    // intent is CI-minute cost -- and a release-only publish.yml costs nothing
    // until you cut a release. A whole-file cap can also be unsatisfiable: PyPI
    // Trusted Publishing authenticates the workflow FILENAME, so a project's
    // publish workflows cannot be merged into one file.
    const pushWfs = myWfs.filter(w => (w.on_triggers ?? '').split(',')
      .some(t => t === 'push' || t === 'pull_request'));
    if (pushWfs.length > 2) {
      F(name, 'WF_FILE_COUNT', 'medium', 'actions',
        `${pushWfs.length} push-triggered workflow files (rule caps at 2).`,
        pushWfs.map(w => w.path).join(', '));
    }
    // A dependency scanner that cannot fail its job renders exactly the same
    // green check as a clean one, so "this repo audits its dependencies" is not
    // decidable from the presence of an audit step. This is the SECURITY_
    // family's own lesson pointed at our side of the fence: absent renders as
    // fine, and a swallowed exit is absent wearing a check name.
    //
    // The two severities are different defects with the same repair. Where no
    // workflow has an enforcing scan, the repo has no dependency gate at all
    // while displaying one. Where an enforcing scan exists elsewhere, the
    // swallowed step is only misleading.
    const defangedWfs = myWfs.filter(w => (w.audit_steps_defanged ?? '').length > 0);
    if (defangedWfs.length) {
      const enforcingAnywhere = myWfs.reduce((n, w) => n + (w.audit_steps_enforcing ?? 0), 0);
      const steps = defangedWfs.flatMap(w =>
        w.audit_steps_defanged.split('\n').filter(Boolean).map(s => `${w.path}: ${s}`));
      const open = sec?.alerts_total ?? 0;
      F(name, 'SECURITY_AUDIT_GATE_DEFANGED', enforcingAnywhere ? 'low' : 'medium', 'security',
        enforcingAnywhere
          ? `${steps.length} dependency-scan step(s) cannot fail the job and do not say so in the step name, alongside ${enforcingAnywhere} that can. The green check is misleading, but the repo is still gated.`
          : `Every dependency-scan step here is swallowed (\`|| true\` or continue-on-error) and none says so in its name, so this repo has no dependency gate while displaying a green check named like one. ${open} alert(s) open today; the cost is the next one, not this one.`,
        steps.join(' | '));
    }

    for (const w of myWfs) {
      const at = `${w.path}`;
      if (w.state === 'parse_error') {
        F(name, 'WF_PARSE_ERROR', 'medium', 'actions', `Workflow YAML failed to parse.`, at);
        continue;
      }
      // The multiplier in these two messages used to be an estimate. Where the
      // cost pass priced this repo, quote what the runner actually cost this
      // month instead -- "re-measure, never estimate" is the rule these
      // findings exist to enforce, and it applies to the finding too.
      const cc = costOK(name) ? classCost.get(name) : null;
      if (w.uses_macos) {
        const measured = cc && cc.macos_min > 0
          ? ` Measured this month: ${cc.macos_min} macOS min = $${cc.macos_cost.toFixed(2)}, `
            + `against ${cc.ubuntu_min} Linux min = $${cc.ubuntu_cost.toFixed(2)}.`
          : '';
        F(name, 'WF_MACOS_RUNNER', 'high', 'actions',
          `Uses a macOS runner (~10x Linux cost): ${w.runners}.${measured}`, at);
      }
      if (w.uses_windows) {
        const measured = cc && cc.windows_min > 0
          ? ` Measured this month: ${cc.windows_min} Windows min = $${cc.windows_cost.toFixed(2)}.`
          : '';
        F(name, 'WF_WINDOWS_RUNNER', 'low', 'actions',
          `Uses a Windows runner (~2x Linux cost): ${w.runners}.${measured}`, at);
      }
      const triggers = (w.on_triggers ?? '').split(',').filter(Boolean);
      const pushLike = triggers.some(t => t === 'push' || t === 'pull_request');
      if (pushLike && !w.has_paths_filter) {
        F(name, 'WF_NO_PATHS_FILTER', 'medium', 'actions',
          `push/pull_request trigger has no paths filter - fires on every change.`, at);
      }
      if (pushLike && !w.has_concurrency) {
        F(name, 'WF_NO_CONCURRENCY', 'medium', 'actions',
          'No concurrency block: superseded runs are not cancelled.', at);
      }
      if (pushLike && !w.has_workflow_dispatch) {
        F(name, 'WF_NO_DISPATCH', 'low', 'actions',
          'No workflow_dispatch fallback for manual runs.', at);
      }
      // Both of these are dead on arrival and only discover it on a schedule,
      // so CI stays green while the automation silently never works.
      if (w.edits_workflow_files) {
        F(name, 'WF_TOKEN_CANNOT_EDIT_WORKFLOWS', 'high', 'actions',
          'Job edits a file under .github/workflows/ and then commits or pushes. '
          + 'GITHUB_TOKEN cannot modify workflow files under any permission setting '
          + '(there is no workflows: write scope), so this needs a PAT with `workflow` '
          + 'scope, or the data moved out of the workflow file.', at);
      }
      if (w.pr_create_default_token) {
        F(name, 'WF_PR_CREATE_DEFAULT_TOKEN', 'medium', 'actions',
          '`gh pr create` runs with the default GITHUB_TOKEN, which fails unless the '
          + 'org enables "Allow GitHub Actions to create and approve pull requests" '
          + '(off by default). Push a branch and open an issue instead, or supply a PAT.',
          at);
      }
      // rules/github-actions.md, "Scheduled workflows" (amended 2026-09-08): a
      // schedule is permitted in an org repo when it does what a push cannot, runs weekly or slower ("daily
      // needs a stated reason"), is bounded, opens a PR rather than pushing, and
      // carries workflow_dispatch. Only a condition shown to fail fires; the
      // first is judgment and is never checked. A gap in cadence alone is `low`:
      // the rule allows a faster schedule with a reason, and the reason lives in
      // prose this cannot read. A NULL column is a snapshot loaded before the
      // check existed, which says nothing either way.
      const gaps = (w.schedule_gaps ?? '').split('\n').filter(Boolean);
      if (triggers.includes('schedule') && gaps.length) {
        const cadenceOnly = gaps.every(g => g.startsWith('runs more often than weekly'));
        F(name, 'WF_SCHEDULED', cadenceOnly ? 'low' : 'medium', 'actions',
          `Scheduled workflow outside rules/github-actions.md: ${gaps.join('; ')}.`,
          at);
      }
    }

    // ---- Actions cost (rules/github-actions.md) ---------------------------
    // "CI minutes are finite. Every workflow must be paths-gated and
    // right-sized." Every rule here needs measured minutes, so each is gated on
    // a reconciliation that agreed with the invoice. No row, or a row that
    // diverged, means silence -- not a clean bill.
    const cost = costOK(name) ? costRollup.get(name) : null;
    if (cost && cost.cost > 0) {
      // Minutes spent on runs that FAILED. Cancelled runs are deliberately
      // excluded: `cancel-in-progress` exists to kill superseded runs, so
      // counting those as waste would file a finding against the concurrency
      // block working correctly. One measured repo looked like 82% waste until
      // the two were separated, at which point it was 12% failure and 67%
      // concurrency doing its job, while another was 41% genuine failure.
      // Collapsing them would have flagged the wrong repo.
      const failPct = cost.fail_cost / cost.cost;
      if (failPct >= 0.30 && cost.fail_min >= 120) {
        F(name, 'ACTIONS_COST_FAILURE_WASTE', 'medium', 'actions',
          `${Math.round(failPct * 100)}% of measured Actions compute went to runs that FAILED `
          + `(${cost.fail_runs} runs, ${cost.fail_min} billable min, $${cost.fail_cost.toFixed(2)} of `
          + `$${cost.cost.toFixed(2)}). Concurrency cancellations are excluded and cost a further `
          + `$${cost.cancel_cost.toFixed(2)}. A suite that fails this often is paying full price per attempt.`,
          `${cost.runs} runs priced`);
      }

      // "Never exceed 6 total jobs in a matrix without explicit approval."
      // Static parsing cannot see this: a 3x2 matrix is one declared job. Only
      // the expanded cells say what actually ran.
      for (const m of matrixBy.get(name) ?? []) {
        if (m.cells > 6) {
          F(name, 'ACTIONS_COST_MATRIX_EXPANDED', 'medium', 'actions',
            `\`${m.base}\` in ${m.workflow_name} expands to ${m.cells} matrix cells, over the `
            + 'cap of 6. Declared job count does not show this - the cells were counted from '
            + `the run of ${m.at?.slice(0, 10)}.`,
            `${m.workflow_name}: ${m.base}`);
        }
      }
    }

    // The only rule here about MONEY rather than compute. On a public repo
    // GitHub meters Actions at full price and discounts it to zero, so gross is
    // real compute but nothing is owed; on a private repo gross draws down the
    // included allowance and then bills. An org of mostly public repos can
    // meter a three-figure gross month and owe nothing -- so this is a tripwire
    // for a change in that shape, not a finding anyone is expected to see on an
    // ordinary day.
    const billed = billedBy.get(name);
    if (r.is_private && billed && billed.gross >= 5) {
      F(name, 'ACTIONS_COST_BILLED_PRIVATE', billed.net > 0 ? 'high' : 'medium', 'actions',
        `Private repo consuming $${billed.gross.toFixed(2)} of Actions compute this month `
        + `($${billed.net.toFixed(2)} billed after allowance). Unlike the public repos, this `
        + 'draws down the included minutes and is charged once they run out.',
        'billing_usage');
    }

    // ---- hygiene / ship gates --------------------------------------------
    // A README is for whoever opens the repo, so it is owed regardless of
    // visibility. The rest are PUBLIC-SURFACE obligations: a LICENSE grants
    // rights to people outside the org, SECURITY.md tells an outside reporter
    // where to go, topics and descriptions serve discovery. A private repo owes
    // none of them, and the ship gates they encode (A, D, E) are about shipped
    // products. Unscoped, these findings land almost entirely on private repos
    // -- NO_LICENSE fired on private repos only, so the rule had never once
    // found a real problem. Scoping them to public repos removes the noise
    // without weakening a single gate that was ever load-bearing.
    if (!isMeta) {
      if (!fp.readme) F(name, 'NO_README', 'high', 'hygiene', 'No README at repo root.', 'gate C');

      if (!r.is_private) {
        if (!fp.license)    F(name, 'NO_LICENSE', 'medium', 'hygiene', 'No LICENSE on a public repo.', 'gate D');
        if (!fp.security)   F(name, 'NO_SECURITY', 'medium', 'hygiene', 'No SECURITY.md on a public repo.', 'gate A');
        if (!fp.changelog)  F(name, 'NO_CHANGELOG', 'low', 'hygiene', 'No CHANGELOG on a public repo.', 'gate C');
        if (!r.description) F(name, 'NO_DESCRIPTION', 'medium', 'metadata', 'No GitHub description set.', 'gate E');
        if (!r.topic_count) F(name, 'NO_TOPICS', 'low', 'metadata', 'No GitHub topics set.', 'gate E');
      }
    }

    // ---- handbook site (rules/shipcheck-product-standards.md gate E) ------
    // Starlight 0.39 removed the top-level autogenerate key on a labelled
    // sidebar group and added the nested `items: [{ autogenerate }]` form.
    // Neither shape is simply "the old one": each is the ONLY valid shape on
    // its side of that boundary. Verified in both directions on 2026-09-17 --
    // a site on Starlight 0.37.7 rejects the nested form outright
    // ("Expected type { label, link } | { label, items } | { label } | { slug }
    // | string"), and a site on 0.42.1 rejects the labelled one.
    //
    // So the defect is a DISAGREEMENT between the declared range and the shape,
    // never the shape alone. Reporting the shape by itself would flag every
    // repo whose config is correct for the version it pins, and bury the
    // handful that are actually broken -- the failure mode this file's header
    // exists to prevent.
    const shape = r.site_sidebar_shape;
    const slAdmits = rangeAdmits039(r.site_starlight_range);
    // Both halves must be measured. A null shape means no site/astro.config.mjs
    // (or a snapshot predating this collection); a null verdict means the range
    // did not parse. Either way, stay silent rather than guess.
    if (shape && slAdmits !== null && shape !== 'none' && shape !== 'explicit') {
      const range = r.site_starlight_range;
      if (shape === 'labeled-autogenerate' && slAdmits) {
        F(name, 'HANDBOOK_SIDEBAR_INCOMPATIBLE', 'high', 'ci',
          `site/astro.config.mjs uses a labelled autogenerate group, removed in Starlight 0.39; site declares ${range}. The site build fails.`,
          'nest it as items: [{ autogenerate: { directory: ... } }]');
      } else if (shape === 'items-autogenerate' && !slAdmits) {
        // The mirror image, and the reason this rule is not one-directional:
        // applying the >=0.39 fix to a repo still pinned below it breaks a
        // site that builds today.
        F(name, 'HANDBOOK_SIDEBAR_INCOMPATIBLE', 'high', 'ci',
          `site/astro.config.mjs nests autogenerate under items, which Starlight only accepts from 0.39; site declares ${range}. The site build fails.`,
          'either bump @astrojs/starlight to >=0.39 or move autogenerate back onto the labelled group');
      } else if (shape === 'labeled-autogenerate' && !slAdmits) {
        // Correct today, and deliberately NOT reported as broken. A caret on a
        // 0.x version pins the minor (^0.37.6 never resolves to 0.39), so this
        // only detonates when something widens the range -- which is exactly
        // how two sites went red on the same day.
        F(name, 'HANDBOOK_SIDEBAR_BUMP_RISK', 'low', 'ci',
          `site/astro.config.mjs uses a labelled autogenerate group, valid for the declared ${range} but removed in Starlight 0.39.`,
          'the bump and the sidebar rewrite must land in the same PR');
      }
    }

    // ---- versioning (rules/shipcheck-product-standards.md) ----------------
    const pv = norm(r.pkg_version), npmv = norm(r.npm_latest_version);
    // Compare against the newest semver TAG, not the newest GitHub Release.
    // They are different objects, and collapsing them reported "version drift"
    // for repos that were correctly tagged and simply never had a Release
    // published.
    const tag = norm(r.latest_tag);
    const myTags = tagBy.get(name) ?? [];
    const unreleased = myTags.filter(t => t.is_semver && !t.has_release);

    if (r.is_monorepo) {
      // A workspace root's version is not the shipped artifact's version, so
      // comparing it to tags or npm produces noise rather than signal.
      F(name, 'MONOREPO_ROOT', 'info', 'version',
        `Workspace root package "${r.pkg_name}" v${pv}; per-package versions are not audited yet.`,
        `latest tag ${r.latest_tag ?? 'none'}`);
    } else {
      // PRE_1_0 was retired on 2026-09-30. It filed every 0.x package as a
      // defect, but the standard changed on 2026-09-09: 1.0.0 means the product
      // is 1.0, and new or unfinished work stays 0.x. A finding against a
      // version that follows the standard is not arguable against it.
      if (pv && tag && pv !== tag) {
        F(name, 'VERSION_TAG_DRIFT', 'high', 'version',
          `package.json v${pv} != latest release tag v${tag}.`,
          `${r.pkg_name ?? name} released ${r.latest_release_at ?? '?'}`);
      }
      if (pv && npmv && pv !== npmv) {
        F(name, 'NPM_DRIFT', 'high', 'version',
          `package.json v${pv} != npm latest v${npmv}.`, r.pkg_name ?? '');
      }
      if (pv && !tag && r.pkg_name) {
        F(name, 'NEVER_TAGGED', 'medium', 'version',
          `Package "${r.pkg_name}" is at v${pv} but the repo has no semver tag at all.`,
          `${r.tag_count ?? 0} tag(s) total`);
      }
    }

    // A tag with no Release is a release that was cut and never published.
    // Independent of monorepo status, and not the same defect as version drift.
    // Two very different cases: if the CURRENT version was never announced,
    // that is live and actionable; if only superseded tags lack Releases, that
    // is historical backfill and must not crowd out real findings.
    if (unreleased.length) {
      const currentUnreleased = tag && unreleased.some(t => norm(t.name) === tag);
      if (currentUnreleased) {
        F(name, 'RELEASE_MISSING', 'medium', 'version',
          `Newest tag ${r.latest_tag} has no GitHub Release - the current version was never published.`,
          unreleased.slice(0, 5).map(t => t.name).join(', '));
      } else {
        F(name, 'RELEASE_BACKFILL', 'info', 'version',
          `${unreleased.length} superseded tag(s) have no GitHub Release; the newest tag does.`,
          unreleased.slice(0, 5).map(t => t.name).join(', '));
      }
    }
    if (r.npm_status === 'unpublished' && r.pkg_name) {
      F(name, 'NPM_UNPUBLISHED', 'info', 'version',
        `Public package "${r.pkg_name}" is not on npm.`, `local v${pv ?? '?'}`);
    }
    if (r.npm_status === 'published' && r.translation_count === 0) {
      F(name, 'NO_TRANSLATIONS', 'info', 'docs',
        'Published package with no translated READMEs (full-treatment expects 7).',
        r.pkg_name ?? '');
    }
    if (!isMeta && r.release_count === 0 && r.disk_usage_kb > 200) {
      F(name, 'NO_RELEASES', 'info', 'version', 'Substantial repo with zero releases.',
        `${r.disk_usage_kb}KB`);
    }

    // ---- backlog ---------------------------------------------------------
    if (r.open_prs > 10) {
      F(name, 'PR_PILEUP', 'high', 'backlog',
        `${r.open_prs} open pull requests.`,
        `oldest ${Math.max(0, ...myPrs.map(p => p.age_days ?? 0))}d`);
    } else if (r.open_prs > 4) {
      F(name, 'PR_PILEUP', 'medium', 'backlog', `${r.open_prs} open pull requests.`, null);
    }
    const stalePrs = myPrs.filter(p => (p.age_days ?? 0) > 30);
    if (stalePrs.length) {
      F(name, 'PR_STALE', 'medium', 'backlog',
        `${stalePrs.length} pull request(s) open longer than 30 days.`,
        stalePrs.slice(0, 5).map(p => `#${p.number} (${p.age_days}d)`).join(', '));
    }
    const conflicted = myPrs.filter(p => p.mergeable === 'CONFLICTING');
    if (conflicted.length) {
      F(name, 'PR_CONFLICTED', 'medium', 'backlog',
        `${conflicted.length} pull request(s) have merge conflicts.`,
        conflicted.slice(0, 5).map(p => `#${p.number}`).join(', '));
    }
    if (r.open_issues > 10) {
      F(name, 'ISSUE_PILEUP', 'medium', 'backlog', `${r.open_issues} open issues.`, null);
    }
    const staleIssues = myIssues.filter(i => (i.stale_days ?? 0) > 90);
    if (staleIssues.length) {
      F(name, 'ISSUE_STALE', 'low', 'backlog',
        `${staleIssues.length} issue(s) untouched for 90+ days.`,
        staleIssues.slice(0, 5).map(i => `#${i.number} (${i.stale_days}d)`).join(', '));
    }
  }

  return db.prepare('SELECT COUNT(*) AS n FROM finding WHERE snapshot_id = ?').get(sid).n;
}

/** 100 = clean. Deducts per finding by severity, floored at 0. */
export function healthScores(db, sid) {
  const rows = db.prepare(`
    SELECT r.name,
           COALESCE(SUM(CASE f.severity WHEN 'critical' THEN ${SEV_WEIGHT.critical}
                                        WHEN 'high'     THEN ${SEV_WEIGHT.high}
                                        WHEN 'medium'   THEN ${SEV_WEIGHT.medium}
                                        WHEN 'low'      THEN ${SEV_WEIGHT.low}
                                        ELSE 0 END), 0) AS penalty,
           COUNT(f.code) AS findings
    FROM repo r LEFT JOIN finding f ON f.snapshot_id = r.snapshot_id AND f.repo = r.name
    WHERE r.snapshot_id = ? AND r.is_archived = 0
    GROUP BY r.name ORDER BY penalty DESC, r.name`).all(sid);
  return rows.map(r => ({ ...r, score: Math.max(0, 100 - r.penalty) }));
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  const db = openDb();
  const sid = process.argv[2]
    ? Number(process.argv[2])
    : db.prepare('SELECT MAX(id) AS id FROM snapshot').get().id;
  const n = analyze(db, sid);
  console.error(`[analyze] snapshot ${sid}: ${n} findings`);
}
