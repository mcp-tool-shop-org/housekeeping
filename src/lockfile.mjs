// Pure functions for auditing a committed package-lock.json or pnpm-lock.yaml
// against the npm advisory registry -- no network here, so every branch is
// unit-testable.
//
// Why this exists: on 2026-09-17 GitHub's Dependabot alert coverage turned out
// to be silently per-manifest. One repo reported alerts on its root lockfile
// and ZERO on site/package-lock.json; another had the same two files and
// reported zero on both, while npm audit found a critical in each. No API
// forces a re-parse, pushes do not repopulate the graph, and the SBOM
// endpoint's 404 turned out not to be the signal (a repo can answer 404 while
// counting). So the warehouse stops trusting the counter and reads the
// lockfiles itself. Absent renders as fine; this is the counter switched on.

/**
 * Map every resolved package in a lockfile to the set of versions it appears
 * at. Handles lockfileVersion 2/3 (`packages`, keyed by path) and 1
 * (`dependencies`, nested). The root entry ("") is the project itself and is
 * skipped. A name is the path after the LAST `node_modules/`, so a nested
 * duplicate (`node_modules/a/node_modules/b`) counts as `b`, which is what the
 * advisory registry is keyed on.
 *
 * Returns { name: [version, ...] } with versions deduplicated and sorted, so
 * two lockfiles resolving to the same set produce byte-identical maps.
 */
export function packageMapFromLockfile(lock) {
  const out = new Map();
  const add = (name, version) => {
    if (!name || !version || typeof version !== 'string') return;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  };

  if (lock && typeof lock.packages === 'object' && lock.packages) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || !entry || typeof entry !== 'object') continue;   // "" is the root
      if (entry.link) continue;                                      // workspace symlink, not a resolved package
      const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      add(name, entry.version);
    }
  } else if (lock && typeof lock.dependencies === 'object' && lock.dependencies) {
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps)) {
        if (!entry || typeof entry !== 'object') continue;
        add(name, entry.version);
        if (entry.dependencies) walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }

  return Object.fromEntries(
    [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
  );
}

/**
 * Names that appear in the lockfile ONLY as dev dependencies (`dev: true` on
 * every entry). A name resolved as prod anywhere in the tree is prod: the
 * shipped surface is what matters, and one prod edge is enough to ship it.
 *
 * Kept apart from the package map because the map is the registry payload and
 * must stay {name: [versions]}; dev-ness is a second axis the report needs
 * because many audit gates run `--omit=dev`, and a critical in a test
 * runner is a different finding from a critical in what users install.
 */
export function devOnlyPackages(lock) {
  const prod = new Set(), dev = new Set();
  const see = (name, entry) => {
    if (!name || !entry || typeof entry !== 'object') return;
    (entry.dev === true ? dev : prod).add(name);
  };
  if (lock && typeof lock.packages === 'object' && lock.packages) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || entry?.link) continue;
      see(entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), entry);
    }
  } else if (lock && typeof lock.dependencies === 'object' && lock.dependencies) {
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps)) {
        see(name, entry);
        if (entry?.dependencies) walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return [...dev].filter(n => !prod.has(n)).sort();
}

/**
 * The npm bulk endpoint (POST /-/npm/v1/security/advisories/bulk) takes exactly
 * the { name: [versions] } map above and answers { name: [advisory...] } with
 * only the advisories whose `vulnerable_versions` range matches a version sent.
 * Flatten that to one row per (package, version, advisory) so a finding can
 * name the version that is actually resolved.
 *
 * `vulnerable_versions` is a semver range string; the registry has already
 * applied it, so this does NOT re-evaluate it -- doing so with a home-grown
 * range parser is how a rule ends up disagreeing with the tool it cites.
 */
export function advisoriesFromBulk(packageMap, response, devOnly = []) {
  const rows = [];
  if (!response || typeof response !== 'object') return rows;
  const dev = new Set(devOnly);
  for (const [name, list] of Object.entries(response)) {
    const versions = packageMap[name] ?? [];
    for (const a of Array.isArray(list) ? list : []) {
      const ghsa = (a.url ?? '').split('/').pop() || (a.id != null ? String(a.id) : null);
      for (const version of versions) {
        rows.push({
          package: name,
          version,
          severity: normaliseSeverity(a.severity),
          ghsa,
          title: (a.title ?? '').slice(0, 200),
          url: a.url ?? null,
          vulnerable_versions: a.vulnerable_versions ?? null,
          dev: dev.has(name),
        });
      }
    }
  }
  return rows;
}

// npm says "moderate"; GitHub says "medium". The report already speaks
// GitHub's dialect (repo_security.medium), so translate at the boundary once.
export function normaliseSeverity(s) {
  const v = String(s ?? '').toLowerCase();
  if (v === 'moderate') return 'medium';
  if (['critical', 'high', 'medium', 'low'].includes(v)) return v;
  return 'unknown';
}

/**
 * Per-severity counts in the shape repo_security uses, plus the prod-only
 * subset. Count distinct advisories, not (advisory x version) rows: a package
 * resolved at two vulnerable versions is one exposure to fix, not two.
 */
export function countBySeverity(advisories) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, prod_critical: 0, prod_high: 0 };
  const seen = new Set();
  for (const a of advisories) {
    const key = `${a.package}|${a.ghsa}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.severity in c) c[a.severity]++;
    if (!a.dev && (a.severity === 'critical' || a.severity === 'high')) c[`prod_${a.severity}`]++;
  }
  return c;
}

// A lockfile's kind, from its file name. Both kinds resolve packages from the
// npm registry, so both are audited against the same advisory endpoint.
const LOCK_KINDS = { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm' };

/** Tree entries that are committed npm or pnpm lockfiles worth auditing. */
export function lockfilePathsFromTree(entries) {
  return (entries ?? [])
    .filter(e => e && e.type === 'blob' && typeof e.path === 'string')
    .map(e => ({ e, kind: LOCK_KINDS[e.path.split('/').pop()] }))
    .filter(({ kind }) => kind)
    // A vendored node_modules tree is someone else's lockfile.
    .filter(({ e }) => !e.path.includes('node_modules/'))
    .map(({ e, kind }) => ({ path: e.path, sha: e.sha, size: e.size ?? null, kind }));
}

// ---- pnpm ---------------------------------------------------------------
//
// pnpm-lock.yaml keys its packages by name and version, in three spellings
// across lockfile versions:
//   9.x   `name@1.2.3` in `packages`, and `name@1.2.3(peer@2.0.0)` in
//         `snapshots`, which carries the dependency edges
//   6.x   `/name@1.2.3` or `/name@1.2.3(peer@2.0.0)`, with `dev: true|false`
//   5.x   `/name/1.2.3` or `/name/1.2.3_peer@2.0.0`, with `dev: true|false`
// A scoped name keeps its leading `@`, so the version starts after the LAST
// `@` (or, in 5.x, the last `/`). A key whose version is not a registry
// version -- a git or tarball URL, `file:`, `link:` -- is not in the advisory
// registry and is left out, as the npm path leaves out workspace links.

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** { name, version, key } for one pnpm package key, or null. Pure. */
// A package name: an optional `@scope/`, then a name with no `/` or `@`.
// 5.x is tried first because its peer suffix (`_peer@1.0.0`) carries an `@`
// of its own, which the 6.x/9.x spelling would take for the version's.
const PNPM_V5_KEY = /^\/((?:@[^/@]+\/)?[^/@]+)\/([^/_(]+)(?:_.*)?$/;
const PNPM_KEY = /^\/?((?:@[^/@]+\/)?[^/@]+)@([^(]+)(?:\(.*)?$/;

export function parsePnpmKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const m = PNPM_V5_KEY.exec(key) ?? PNPM_KEY.exec(key);
  if (!m) return null;
  const [, name, version] = m;
  return SEMVER.test(version) ? { name, version } : null;
}

/**
 * The package map and dev-only names of a parsed pnpm-lock.yaml. Pure.
 *
 * Dev-ness: 5.x and 6.x mark each package `dev: true|false`, read like npm's
 * flag. 9.x marks nothing, so what ships is computed: every package reachable
 * through `snapshots` from any importer's `dependencies` or
 * `optionalDependencies` is prod; the rest of the lock is dev-only. A 9.x
 * lock with no `snapshots` cannot be walked, and then nothing is called
 * dev-only -- the louder reading, never a guess that hides a shipped package.
 */
export function pnpmPackageMap(lock) {
  const out = new Map();
  const add = (name, version) => {
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  };
  const pkgs = lock?.packages && typeof lock.packages === 'object' ? lock.packages : {};
  const flagged = { prod: new Set(), dev: new Set() };
  let anyFlag = false;
  for (const [key, entry] of Object.entries(pkgs)) {
    const p = parsePnpmKey(key);
    if (!p) continue;
    add(p.name, p.version);
    if (entry && typeof entry.dev === 'boolean') { anyFlag = true; (entry.dev ? flagged.dev : flagged.prod).add(p.name); }
  }
  const packages = Object.fromEntries(
    [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
  );

  let dev = [];
  if (anyFlag) {
    dev = [...flagged.dev].filter(n => !flagged.prod.has(n));
  } else if (lock?.snapshots && typeof lock.snapshots === 'object') {
    const snaps = lock.snapshots;
    const prod = new Set();
    const queue = [];
    const visit = (name, ver) => {
      if (typeof ver !== 'string' || ver.startsWith('link:') || ver.startsWith('file:')) return;
      const key = `${name}@${ver}`;
      if (prod.has(key)) return;
      prod.add(key);
      queue.push(key);
    };
    for (const imp of Object.values(lock.importers ?? {})) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [name, d] of Object.entries(imp?.[field] ?? {})) visit(name, typeof d === 'string' ? d : d?.version);
      }
    }
    while (queue.length) {
      const s = snaps[queue.shift()];
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [name, ver] of Object.entries(s?.[field] ?? {})) visit(name, ver);
      }
    }
    const prodNames = new Set([...prod].map(k => parsePnpmKey(k)?.name).filter(Boolean));
    dev = Object.keys(packages).filter(n => !prodNames.has(n));
  }
  return { packages, dev: dev.sort() };
}

/**
 * One committed lockfile, read: { version, packages, dev }. Pure apart from
 * parsing. `kind` is lockfilePathsFromTree's. Throws on a file that does not
 * parse; the collector records that as not measured.
 */
export function readLockfile(text, kind, parseYaml) {
  if (kind === 'pnpm') {
    const lock = parseYaml(text);
    if (!lock || typeof lock !== 'object') throw new Error('pnpm-lock.yaml does not parse to a mapping');
    const { packages, dev } = pnpmPackageMap(lock);
    const v = parseFloat(lock.lockfileVersion);
    return { version: Number.isFinite(v) ? v : null, packages, dev };
  }
  const lock = JSON.parse(text);
  return { version: lock.lockfileVersion ?? null, packages: packageMapFromLockfile(lock), dev: devOnlyPackages(lock) };
}
