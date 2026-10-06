// Static detection of two GitHub Actions failures that a green CI run can never
// surface, because both only fire on a schedule nobody is watching.
//
// Kept separate from load.mjs on purpose: these encode facts about the GitHub
// platform (token capabilities, org settings), which change on GitHub's cadence,
// not on ours. The rest of load.mjs encodes our storage layout.

/**
 * Steps flattened with their effective env (workflow < job < step).
 *
 * `name` and `continue-on-error` ride along because one rule below needs to
 * know what a step is CALLED and whether it can actually fail the job -- a
 * scanner that cannot fail is indistinguishable, in the Checks tab, from one
 * that found nothing. Job-level continue-on-error is inherited; the step-level
 * value wins where both are set, which is GitHub's own precedence.
 */
function flattenSteps(doc, jobs) {
  const steps = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    for (const st of Array.isArray(job.steps) ? job.steps : []) {
      if (st && typeof st.run === 'string') {
        steps.push({
          run: st.run,
          name: typeof st.name === 'string' ? st.name : '',
          continueOnError: st['continue-on-error'] ?? job['continue-on-error'] ?? false,
          env: { ...(doc?.env ?? {}), ...(job.env ?? {}), ...(st.env ?? {}) },
        });
      }
    }
  }
  return steps;
}

// A write must be an actual write verb aimed at the path. Reading workflow files
// is common and legitimate — an org guard lints them in a loop, and
// `gh api .../contents` is a GET. An earlier version of this rule flagged an
// org's `.github` repo for auditing its own workflows, which is the opposite
// of the defect. Forward slash only: these run on Linux runners.
const WF = '\\.github/workflows';
const WRITE_TO_WORKFLOW = new RegExp([
  `sed\\s+-i[^\\n]*${WF}`,
  `(?:>|>>|\\|\\s*tee)\\s*[^\\n|]*${WF}`,
  `(?:cp|mv)\\s+[^\\n]*\\s+${WF}`,
  `gh\\s+api\\s+[^\\n]*-X\\s*(?:PUT|POST|PATCH)[^\\n]*${WF}`,
].join('|'), 'i');

const COMMITS = /git\s+(?:push|commit)|gh\s+api\s+[^\n]*-X\s*(?:PUT|POST|PATCH)/i;

/**
 * GITHUB_TOKEN cannot modify anything under .github/workflows/ under ANY
 * permission setting — there is no `workflows: write` scope to grant. A job that
 * rewrites a workflow file and then pushes is dead on arrival; it needs a PAT
 * with `workflow` scope, or the data moved out of the workflow file entirely.
 */
export function editsWorkflowFiles(doc, jobs) {
  const steps = flattenSteps(doc, jobs);
  return steps.some(s => WRITE_TO_WORKFLOW.test(s.run))
      && steps.some(s => COMMITS.test(s.run));
}

/**
 * `gh pr create` with the default token fails unless the org enables "Allow
 * GitHub Actions to create and approve pull requests", which is off by default.
 *
 * A `secrets.SOME_PAT || secrets.GITHUB_TOKEN` fallback is NOT this defect — it
 * prefers a real PAT and degrades gracefully. Flag only when the default token
 * is the only thing the expression can resolve to.
 */
export function prCreateWithDefaultToken(doc, jobs) {
  const defaultOnly = (v) => {
    if (typeof v !== 'string') return false;
    if (!/secrets\.GITHUB_TOKEN|github\.token/.test(v)) return false;
    const named = [...v.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1].toUpperCase());
    return !named.some(n => n !== 'GITHUB_TOKEN');
  };
  return flattenSteps(doc, jobs).some(s =>
    /gh\s+pr\s+create/.test(s.run) && Object.values(s.env).some(defaultOnly));
}

// ---------------------------------------------------------------------------
// A dependency scanner that cannot fail the job.
//
// An npm/pnpm audit step that ends in `|| true` reports a green check named
// something like "scan dependencies" while enforcing nothing. That is strictly
// worse than a repo GitHub is not scanning at all, which at least has no check
// to point at -- here the green check is the evidence someone cites.
//
// The defect is the UNDISCLOSED defang. A step named "npm audit (advisory --
// does not fail the build)" is honest engineering: a human reading the Checks
// tab is not misled, and some repos do exactly that deliberately. Flagging it
// would manufacture noise, which is the failure mode this repo exists to
// avoid: a finding that is confident, plausible and wrong.

// A regex LITERAL, not new RegExp(['\\b…'].join('|')). The string form was the
// first draft and it reported zero findings across all 89 audit steps in the
// org, which read as "nothing to fix": '\b' inside a JS string is the BACKSPACE
// character, so the pattern was hunting for a 0x08 byte. Same shape as the
// heredoc `\b` that became a literal backspace on 2026-09-17 -- a wrong regex
// does not throw, it just matches nothing, and nothing looks like clean.
const AUDIT_CMD = /\b(?:npm|pnpm|yarn|bun)\s+audit\b|\bpip-audit\b|\bcargo\s+audit\b|\bosv-scanner\b|\bgovulncheck\b|\bsafety\s+(?:check|scan)\b|\bbundler?[\s-]audit\b|\btrivy\s+(?:fs|repo|image)\b/i;

// `npm audit signatures` verifies registry provenance, not advisories. Different
// control, different remediation; collapsing them would misname the finding.
const NOT_AN_ADVISORY_SCAN = /\baudit\s+signatures\b/i;

// Only the forms that unambiguously swallow a non-zero exit. `set +e` and
// trap-based handling are deliberately NOT matched: they can be followed by a
// real check, and guessing produces exactly the confident-but-wrong finding
// this repo has been bitten by three times.
const SWALLOWS_EXIT = /\|\|\s*(?:true|:|echo\b)|;\s*true\s*$/m;

// Wording that tells a reader the step is informational. Checked against the
// step name only -- a comment in the YAML is not visible in the Checks tab,
// which is where the misreading happens.
const DISCLOSES = /advisory|advisor|non[-\s]?blocking|informational|info only|report only|does not fail|doesn't fail|warn only|warning only|\bfyi\b/i;

// Swallowing the exit is the NORMAL way to write a threshold gate: run the
// scanner with `|| true` so the report is still written, then parse it and fail
// on the tier you actually care about. A "pip-audit (CRITICAL floor)" step does
// exactly that and ends in sys.exit(1). A step that can still fail is not
// defanged, whatever its middle looks like.
const CAN_STILL_FAIL = /\bexit\s+1\b|sys\.exit\(\s*1\s*\)|\breturn\s+1\b|::error::/;

/**
 * Split a workflow's dependency-scanner steps into the ones that can fail the
 * job and the ones that cannot-and-do-not-say-so.
 *
 * Both halves are needed because they answer different questions. A defanged
 * step is a hygiene problem; a repo whose ONLY audit step is defanged has no
 * dependency gate at all while displaying a green check named like one, and
 * those are not the same finding: a repo can carry a defanged step and keep a
 * blocking scan alongside it.
 *
 * Verified against every audit step in a whole org before being trusted, which
 * is how a threshold gate and a summary step were found to be false positives
 * rather than shipped as findings.
 */
export function auditSteps(doc, jobs) {
  const enforcing = [];
  const defanged = [];
  for (const s of flattenSteps(doc, jobs)) {
    if (!AUDIT_CMD.test(s.run)) continue;
    if (NOT_AN_ADVISORY_SCAN.test(s.run)) continue;

    // Join backslash continuations so a wrapped invocation reads as one line,
    // then judge each invocation separately: a step with one gated audit and one
    // ungated one can still fail, so it is not defanged.
    const lines = s.run.replace(/\\\r?\n\s*/g, ' ').split('\n');
    const invocations = lines.filter((l) => {
      const at = l.search(AUDIT_CMD);
      if (at < 0) return false;
      // An audit inside `$( )` is being READ, not run as a gate -- for example
      // rendering `npm audit --json` into a job summary. Counting that as a
      // failed gate would flag a repo whose real gate is a separate, blocking
      // step three lines above.
      return !l.slice(0, at).includes('$(');
    });
    if (!invocations.length) continue;

    // Name the step the way the Checks tab does; fall back to the command when
    // the step is unnamed, because "" would make the finding unactionable.
    const label = s.name || s.run.trim().split('\n')[0].slice(0, 80);

    const swallowed = s.continueOnError === true || invocations.every(l => SWALLOWS_EXIT.test(l));
    if (!swallowed || CAN_STILL_FAIL.test(s.run)) { enforcing.push(label); continue; }
    // A step that announces itself as advisory is honest engineering, not a
    // defect: nobody reading the Checks tab is misled. Some repos do this
    // deliberately. It still is not an enforcing gate, so it counts as neither.
    if (DISCLOSES.test(s.name)) continue;
    defanged.push(label);
  }
  return { enforcing, defanged };
}

// ---------------------------------------------------------------------------
// Doors that deploy: which jobs publish to GitHub Pages, which name a
// deployment environment, and whether that job can run on the default branch.
//
// These read the workflow as GitHub will run it, so they sit with the other
// platform facts. They decide nothing about a defect: the settings a deploy
// needs are collected from GitHub (collect.mjs), and the rules that join the
// two live in analyze.mjs.

const jobSteps = job => (job && typeof job === 'object' && Array.isArray(job.steps) ? job.steps : []);

/**
 * Job ids with a step that uses actions/deploy-pages, at any version.
 *
 * In a private repository a job that skips itself there is left out: Pages on
 * a private repo is a plan feature, and a deploy gated on
 * `!github.event.repository.private` is how a workflow says "only when public".
 * That job never reaches deploy-pages, so Pages being off refuses nothing.
 */
export function pagesDeployJobs(jobEntries, { isPrivate = false } = {}) {
  const byId = new Map(jobEntries);
  return jobEntries
    .filter(([, job]) => jobSteps(job).some(st =>
      typeof st?.uses === 'string' && /^actions\/deploy-pages(?:@|$)/i.test(st.uses.trim())))
    .filter(([id]) => !(isPrivate && skipsWhenPrivate(byId, id)))
    .map(([id]) => id);
}

// A term that is false exactly when the repository is private.
const PUBLIC_ONLY = /^(?:!\s*github\.event\.repository\.private|github\.event\.repository\.private\s*==\s*false|github\.event\.repository\.private\s*!=\s*true|github\.event\.repository\.visibility\s*==\s*'public')$/;

/**
 * True when the job cannot run in a private repository: its own `if:` is a
 * conjunction with a public-only term, or it has no `if:` of its own (so
 * GitHub's implicit success() applies) and a job it needs cannot run. Any
 * `||`, or anything else this cannot read, is false: unknown never excuses.
 */
export function skipsWhenPrivate(byId, id, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const job = byId.get(id);
  if (!job || typeof job !== 'object') return false;
  if (job.if !== undefined) {
    if (typeof job.if !== 'string') return false;
    const expr = job.if.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    if (expr.includes('||')) return false;
    return expr.split('&&').some(t => PUBLIC_ONLY.test(t.trim().replace(/^\((.*)\)$/, '$1').trim()));
  }
  const needs = typeof job.needs === 'string' ? [job.needs] : (Array.isArray(job.needs) ? job.needs : []);
  return needs.some(n => skipsWhenPrivate(byId, n, seen));
}

/**
 * The environment a job names, or null when it names none or names it with an
 * expression. `environment:` is either a string or `{ name, url }`. A name built
 * from `${{ }}` cannot be known from the file, so it is left out rather than
 * stored half-resolved -- a wrong name would be joined to the wrong settings.
 */
export function jobEnvironment(job) {
  if (!job || typeof job !== 'object') return null;
  const env = job.environment;
  const name = typeof env === 'string' ? env : (env && typeof env === 'object' ? env.name : null);
  if (typeof name !== 'string' || !name.trim() || name.includes('${{')) return null;
  return name.trim();
}

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does a workflow `branches:` / `branches-ignore:` pattern list match this
 * branch? 1, 0, or null when a pattern uses syntax this does not evaluate.
 *
 * GitHub's filter syntax: `*` is any run of characters but `/`, `**` is any run
 * at all. `?`, `+`, `[]` and `!` negation (whose meaning depends on order) are
 * real syntax too, and are not evaluated here: a pattern this cannot read makes
 * the answer unknown unless another pattern already matched outright.
 */
export function filterMatches(patterns, branch) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  let unknown = false;
  for (const p of list) {
    if (typeof p !== 'string') { unknown = true; continue; }
    if (/[?+[\]!\\]/.test(p)) { unknown = true; continue; }
    const re = new RegExp('^' + p.split('**').map(part =>
      part.split('*').map(reEscape).join('[^/]*')).join('.*') + '$');
    if (re.test(branch)) return 1;
  }
  return unknown ? null : 0;
}

/**
 * Can a push to `branch` start this workflow? 1, 0 or null.
 *
 * Only `branches`/`branches-ignore` filter a branch push. A push trigger that
 * declares only `tags`/`tags-ignore` runs for tags alone -- GitHub does not run
 * a workflow for the kind of ref a filter leaves undefined -- so a
 * `push: tags: [v*]` release never runs on the default branch.
 */
export function pushAdmitsBranch(push, branch) {
  if (push == null || push === true || typeof push !== 'object' || Array.isArray(push)) return 1;
  const hasBranches = 'branches' in push, hasIgnore = 'branches-ignore' in push;
  if (!hasBranches && !hasIgnore) {
    return ('tags' in push || 'tags-ignore' in push) ? 0 : 1;
  }
  if (hasBranches) return filterMatches(push.branches, branch);
  const ignored = filterMatches(push['branches-ignore'], branch);
  return ignored === null ? null : ignored === 1 ? 0 : 1;
}

// Where each event runs. A scheduled run, a workflow_run follow-up and a
// repository_dispatch run on the default branch's latest commit whatever
// started them. A pull request runs on its merge ref, a release on its tag, and
// workflow_dispatch on whichever ref the person picks -- a release workflow
// dispatched from a tag is not a job that runs on main, so it is not counted as
// one. Every other event (workflow_call, pull_request_target, ...) is unknown.
const ON_DEFAULT = new Set(['schedule', 'workflow_run', 'repository_dispatch']);
const NOT_ON_DEFAULT = new Set(['pull_request', 'release', 'workflow_dispatch', 'merge_group']);
const eventOnDefault = (e, on, branch) =>
  e === 'push' ? pushAdmitsBranch(on && typeof on === 'object' && !Array.isArray(on) ? on.push : null, branch)
  : ON_DEFAULT.has(e) ? 1 : NOT_ON_DEFAULT.has(e) ? 0 : null;

// The job-level `if:` terms that are read. Anything else in an `if:` makes
// that alternative unknown: an expression this does not evaluate must never be
// guessed into "runs on main".
const IF_EVENT_IS = /^github\.event_name\s*==\s*'([^']+)'$/;
const IF_EVENT_NOT = /^github\.event_name\s*!=\s*'([^']+)'$/;
const IF_REF = /^github\.ref\s*==\s*'refs\/heads\/([^']+)'$|^'refs\/heads\/([^']+)'\s*==\s*github\.ref$/;
const unwrap = s => s.trim().replace(/^\((.*)\)$/, '$1').trim();

/**
 * Read one `&&`-joined alternative of a job's `if:`. Returns false when it can
 * never hold on the default branch, null when it cannot be read, or the
 * predicate over events it allows.
 */
function readAlternative(alt, branch) {
  let allow = () => true;
  for (const raw of alt.split('&&').map(unwrap)) {
    let m;
    if ((m = IF_EVENT_IS.exec(raw))) { const e = m[1], prev = allow; allow = x => prev(x) && x === e; continue; }
    if ((m = IF_EVENT_NOT.exec(raw))) { const e = m[1], prev = allow; allow = x => prev(x) && x !== e; continue; }
    if ((m = IF_REF.exec(raw))) { if ((m[1] ?? m[2]) !== branch) return false; continue; }
    return null;
  }
  return allow;
}

/**
 * Can this job run on the default branch? 1, 0 or null (cannot tell).
 *
 * The workflow's triggers say which events start it and whether each lands on
 * the default branch; the job's `if:` then narrows which of those it runs for.
 * Only plain `||` / `&&` over `github.event_name` and `github.ref` comparisons
 * is read. A parenthesised mix, a function call or any other context makes the
 * answer unknown, and unknown produces no finding.
 */
export function jobRunsOnDefaultBranch(doc, job, branch) {
  if (!branch || !doc || typeof doc !== 'object') return null;
  const on = doc.on ?? doc[true];
  const names = typeof on === 'string' ? [on]
    : Array.isArray(on) ? on
    : on && typeof on === 'object' ? Object.keys(on) : [];
  const events = names.map(e => [e, eventOnDefault(e, on, branch)]);
  // No trigger lands on the default branch: nothing in an `if:` can change that.
  if (events.every(([, v]) => v === 0)) return 0;

  let alternatives = [() => true];
  const cond = job && typeof job === 'object' ? job.if : undefined;
  if (cond !== undefined && cond !== null) {
    if (typeof cond !== 'string') return null;
    const expr = cond.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
    // An operator inside parentheses is grouping that a split on `||` and `&&`
    // would misread, so the whole condition is unknown. A call such as
    // startsWith(github.ref, 'x') has no operator inside and only makes its
    // own alternative unknown.
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth > 0 && (expr.startsWith('||', i) || expr.startsWith('&&', i))) return null;
    }
    alternatives = expr.split('||').map(unwrap).map(a => readAlternative(a, branch));
  }

  let unknown = false;
  for (const allow of alternatives) {
    if (allow === false) continue;
    if (allow === null) { unknown = true; continue; }
    for (const [e, v] of events) {
      if (!allow(e)) continue;
      if (v === 1) return 1;
      if (v === null) unknown = true;
    }
  }
  return unknown ? null : 0;
}

// ---------------------------------------------------------------------------
// `atlas check` in CI (rules/atlas-map.md): "CI runs `npx --yes
// @dogfood-lab/atlas@<version> check` as a step of an existing push-triggered
// workflow." Read from `run:` steps only. A version is anything after the `@`
// up to whitespace or a quote; a call with no `@<version>` is recorded as
// `unpinned`, because the rule forbids a floating engine and a pinned one is
// what the engine check compares.
const ATLAS_CHECK = /@dogfood-lab\/atlas(?:@([^\s'"`]+))?\s+check\b/g;

/** The pins of every `@dogfood-lab/atlas ... check` a run step issues, in order. */
export function atlasCheckPins(doc, jobs) {
  const pins = [];
  for (const s of flattenSteps(doc, jobs)) {
    for (const m of s.run.matchAll(ATLAS_CHECK)) pins.push(m[1] ?? 'unpinned');
  }
  return pins;
}

// ---------------------------------------------------------------------------
// Where a red run broke, in the terms an Atlas map uses. The Actions API names
// a failed job and step as GitHub DISPLAYS them; an Atlas door records a
// command by the job's key and the step's `name`, or the step's index from 0
// as a string when it has none. This turns one into the other by reading the
// workflow text, never by counting: GitHub numbers "Set up job" as step 1 and
// inserts container and post steps, so a step number is not an index.
//
// Display names, as the API reports them (read from live runs, 2026-09-30):
//   a job      -> its `name:` (expressions evaluated) or its key; a matrix cell
//                 of a job whose name has no expression gets " (a, b)" appended
//   a step     -> its `name:`; unnamed, "Run <uses as written>" or
//                 "Run <first line of the script>"
//   post / pre -> "Post <that display name>", "Pre <that display name>"
//   the runner's own steps -> "Set up job", "Complete job", container steps

/** A display template with `${{ ... }}` holes, as a whole-string pattern. */
function templateRe(template, matrixSuffix) {
  const body = template.split(/\$\{\{[\s\S]*?\}\}/).map(reEscape).join('[\\s\\S]*?');
  return new RegExp(`^${body}${matrixSuffix ? '(?: \\(.*\\))?' : ''}$`);
}

const RUNNER_STEPS = /^(?:Set up job|Complete job|Initialize containers|Stop containers|Set up runner|Build container for action use: .*)$/;

/** How GitHub displays step `st`, or null for a step with neither run nor uses. */
export function stepDisplayName(st) {
  if (!st || typeof st !== 'object') return null;
  if (typeof st.name === 'string' && st.name.trim()) return st.name;
  if (typeof st.uses === 'string') return `Run ${st.uses}`;
  if (typeof st.run === 'string') {
    const first = st.run.split('\n').map(l => l.trim()).find(Boolean);
    return first ? `Run ${first}` : null;
  }
  return null;
}

/**
 * The Atlas reference of the step a failed run stopped in. Pure.
 *
 * `doc` is the parsed workflow, `jobName` and `stepName` are the API's display
 * names, `stepNumber` the API's step number (a tie-break only). Returns
 * `{ job, step, index, phase }` -- `phase` is 'main', 'post' or 'pre' -- or
 * `{ job?, unresolved }` naming why no single step of this file could be
 * identified. An unresolved answer is never guessed into a resolved one: a
 * wrong step would pin the failure on a command that did not run.
 */
export function resolveFailedStep(doc, jobName, stepName, stepNumber = null) {
  const jobs = doc?.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs)
    ? Object.entries(doc.jobs) : [];
  if (typeof jobName !== 'string' || !jobName) return { unresolved: 'no job name' };

  // A reusable-workflow call shows as "<caller> / <called job>": its steps live
  // in the called file, which is a different door.
  const callers = jobs.filter(([, j]) => typeof j?.uses === 'string');
  for (const [id, j] of callers) {
    const t = typeof j.name === 'string' ? j.name : id;
    if (jobName === t || jobName.startsWith(`${t} / `) || templateRe(t, true).test(jobName.split(' / ')[0])) {
      return { job: id, unresolved: 'reusable workflow: the step is in the called file' };
    }
  }
  const matches = jobs.filter(([id, j]) => {
    if (!j || typeof j !== 'object' || typeof j.uses === 'string') return false;
    const t = typeof j.name === 'string' ? j.name : id;
    return templateRe(t, true).test(jobName);
  });
  if (!matches.length) return { unresolved: 'no job of this file displays as that name; the workflow may have changed since the run' };
  const exact = matches.filter(([id, j]) => (typeof j.name === 'string' ? j.name : id) === jobName);
  const hits = exact.length === 1 ? exact : matches;
  if (hits.length > 1) return { unresolved: `the name fits ${hits.length} jobs: ${hits.map(([id]) => id).join(', ')}` };
  const [jobId, job] = hits[0];

  if (typeof stepName !== 'string' || !stepName) return { job: jobId, unresolved: 'the job failed outside any step' };
  if (RUNNER_STEPS.test(stepName)) return { job: jobId, unresolved: `the runner's own step "${stepName}", not one the workflow declares` };
  const m = /^(Post|Pre) (.+)$/.exec(stepName);
  const phase = m ? m[1].toLowerCase() : 'main';
  const shown = m ? m[2] : stepName;

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const fits = [];
  steps.forEach((st, index) => {
    const d = stepDisplayName(st);
    if (d == null) return;
    const hasHole = typeof st.name === 'string' && /\$\{\{/.test(st.name);
    if (hasHole ? templateRe(d, false).test(shown) : d === shown) fits.push(index);
  });
  // Post and pre steps exist only for `uses:` steps; a script step cannot own one.
  const eligible = phase === 'main' ? fits : fits.filter(i => typeof steps[i].uses === 'string');
  let index = eligible.length === 1 ? eligible[0] : null;
  // Two identical steps (checkout twice): GitHub's number settles it only when
  // "Set up job" is the one step before them, i.e. no container or services.
  if (eligible.length > 1 && phase === 'main' && Number.isInteger(stepNumber)
      && !job.container && !job.services && eligible.includes(stepNumber - 2)) index = stepNumber - 2;
  if (index == null) {
    return { job: jobId, unresolved: eligible.length ? `the name fits ${eligible.length} steps` : 'no step of this job displays as that name; the workflow may have changed since the run' };
  }
  const st = steps[index];
  return { job: jobId, step: typeof st.name === 'string' && st.name.trim() ? st.name : String(index), index, phase };
}

// ---------------------------------------------------------------------------
// A scheduled workflow against rules/github-actions.md, "Scheduled workflows"
// (the org rule was amended 2026-09-08).
//
// The rule permits a schedule in an org repo when ALL of these hold: it does
// something a push cannot; it runs weekly or slower (daily needs a stated
// reason); it is bounded (ubuntu-latest, an explicit timeout-minutes, a
// concurrency block); it opens a PR and never pushes to a protected branch; and
// it carries workflow_dispatch. The first is judgment and is not checked here.
// Everything below is read from the file alone, and every unknown reads as
// "not shown to fail": an expression we cannot resolve is not a violation.

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = {
  3: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  4: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};

/** Number of values a cron field admits, or null when it cannot be read. */
function cronFieldSize(text, i) {
  const [lo, hi] = FIELD_RANGES[i];
  const values = new Set();
  const num = s => {
    const k = NAMES[i]?.indexOf(s.toLowerCase());
    if (k != null && k >= 0) return i === 3 ? k + 1 : k;
    return /^\d+$/.test(s) ? +s : NaN;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText == null ? 1 : +stepText;
    let a, b;
    if (range === '*') [a, b] = [lo, hi];
    else if (range.includes('-')) [a, b] = range.split('-').map(num);
    else { a = num(range); b = stepText == null ? a : hi; }
    if (![a, b, step].every(Number.isFinite) || step < 1) return null;
    for (let v = a; v <= b; v += step) values.add(i === 4 ? v % 7 : v);
  }
  return values.size;
}

/**
 * How many times a year a five-field cron fires, approximately. Day-of-month
 * and day-of-week are ORed by cron when both are restricted, so both count.
 */
export function cronFiresPerYear(expr) {
  const f = String(expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const n = f.map(cronFieldSize);
  if (n.some(x => x == null)) return null;
  const domAll = f[2] === '*', dowAll = f[4] === '*';
  const daysPerYear = domAll && dowAll ? 365
    : dowAll ? n[2] * 12
    : domAll ? n[4] * 52
    : n[2] * 12 + n[4] * 52;
  return n[0] * n[1] * daysPerYear * (n[3] / 12);
}

const PUSH = /\bgit\s+push\b/;
const NEW_BRANCH = /\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s/;
const AUTO_COMMIT = /^(?:stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|ad-m\/github-push-action)@/;

/** Does this job push to the branch it checked out (the default, on a cron)? */
function pushesCheckedOutBranch(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  let branched = false;
  for (const st of steps) {
    if (!st || typeof st !== 'object') continue;
    if (typeof st.uses === 'string' && AUTO_COMMIT.test(st.uses)) {
      const w = st.with ?? {};
      if (!w.branch && !w.create_branch && !w.new_branch) return true;
    }
    if (typeof st.run !== 'string') continue;
    if (NEW_BRANCH.test(st.run)) branched = true;
    if (PUSH.test(st.run) && !branched) return true;
  }
  return false;
}

/**
 * The rule's mechanical conditions that a scheduled workflow fails, as short
 * phrases. Empty: none shown to fail. null: the workflow has no schedule.
 */
export function scheduleGaps(doc, jobEntries) {
  const on = doc?.on ?? doc?.[true];
  const schedule = on && typeof on === 'object' && !Array.isArray(on) ? on.schedule : null;
  if (!Array.isArray(schedule)) return null;
  const gaps = [];

  const fires = schedule.map(s => cronFiresPerYear(s?.cron)).filter(x => x != null);
  const perYear = fires.reduce((a, b) => a + b, 0);
  if (perYear > 53) {
    const days = 365 / perYear;
    const every = Math.abs(days - 1) < 0.05 ? 'daily'
      : days >= 1 ? `every ${+days.toFixed(1)} days` : `${+(perYear / 365).toFixed(1)} times a day`;
    gaps.push(`runs more often than weekly (${every}, which needs a stated reason)`);
  }

  const offLinux = new Set();
  const noTimeout = [], noConcurrency = [], pushers = [];
  for (const [id, job] of jobEntries) {
    if (!job || typeof job !== 'object') continue;
    const reusable = typeof job.uses === 'string';
    const ro = job['runs-on'];
    const labels = (Array.isArray(ro) ? ro : [ro]).filter(r => typeof r === 'string');
    const os = job.strategy?.matrix?.os;
    for (const r of labels) {
      if (r.includes('${{')) {
        if (/matrix\.os/.test(r) && Array.isArray(os)) {
          os.filter(o => typeof o === 'string' && !/^ubuntu-/.test(o)).forEach(o => offLinux.add(o));
        }
      } else if (!/^ubuntu-/.test(r)) offLinux.add(r);
    }
    // A job that calls a reusable workflow cannot carry timeout-minutes.
    if (!reusable && job['timeout-minutes'] == null) noTimeout.push(id);
    if (!job.concurrency) noConcurrency.push(id);
    if (pushesCheckedOutBranch(job)) pushers.push(id);
  }
  if (offLinux.size) gaps.push(`runs off Linux (${[...offLinux].join(', ')})`);
  if (noTimeout.length) gaps.push(`no timeout-minutes on ${noTimeout.join(', ')}`);
  if (!doc.concurrency && noConcurrency.length) gaps.push('no concurrency block');
  if (pushers.length) gaps.push(`pushes to the branch it checked out instead of opening a PR (${pushers.join(', ')})`);
  if (!('workflow_dispatch' in on)) gaps.push('no workflow_dispatch');
  return gaps;
}
