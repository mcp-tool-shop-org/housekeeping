// Pure functions for auditing a committed package-lock.json against the npm
// advisory registry -- no network here, so every branch is unit-testable.
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

/** Tree entries that are committed npm lockfiles worth auditing. */
export function lockfilePathsFromTree(entries) {
  return (entries ?? [])
    .filter(e => e && e.type === 'blob' && typeof e.path === 'string')
    .filter(e => e.path === 'package-lock.json' || e.path.endsWith('/package-lock.json'))
    // A vendored node_modules tree is someone else's lockfile.
    .filter(e => !e.path.includes('node_modules/'))
    .map(e => ({ path: e.path, sha: e.sha, size: e.size ?? null }));
}
