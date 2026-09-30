#!/usr/bin/env node
// MCP server over the housekeeping warehouse.
//
// Why this exists: the raw snapshot is ~3 MB of JSON. Pulling that into a model's
// context to answer "which repos have red CI" is the wrong shape. These tools
// answer questions and return small tables instead.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, formatError, readOnlyQuery, structured, userError } from './errors.mjs';
import { DATA_DIR, PACKAGE_ROOT } from './paths.mjs';
import { HEAD_CHECKS_RED } from './analyze.mjs';

const DB_FILE = process.env.HK_DB || join(DATA_DIR, 'housekeeping.db');
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

if (!existsSync(DB_FILE)) {
  console.error(formatError(userError('NO_DATABASE', `no database at ${DB_FILE}`, 'run `hk refresh` first')));
  process.exit(EXIT.USER);
}
const db = new DatabaseSync(DB_FILE, { readOnly: true });
const sid = () => db.prepare('SELECT MAX(id) AS id FROM snapshot').get().id;

/** Render rows as a pipe table: far cheaper in tokens than pretty-printed JSON. */
function asTable(rows, note) {
  if (!rows.length) return (note ? note + '\n' : '') + '(no rows)';
  const cols = Object.keys(rows[0]);
  const body = [
    cols.join(' | '),
    cols.map(() => '---').join(' | '),
    ...rows.map(r => cols.map(c => String(r[c] ?? '').replace(/\n/g, ' ')).join(' | ')),
  ].join('\n');
  return (note ? note + '\n\n' : '') + body + `\n\n(${rows.length} rows)`;
}

const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });

const TOOLS = [
  {
    name: 'hk_summary',
    description: 'Portfolio totals for the newest snapshot: repo/issue/PR/workflow/finding counts.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const s = db.prepare('SELECT * FROM snapshot WHERE id=?').get(sid());
      const t = db.prepare(`SELECT
        (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1) repos,
        (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_archived=1) archived,
        (SELECT COUNT(*) FROM repo WHERE snapshot_id=?1 AND is_private=1) private,
        (SELECT COUNT(*) FROM issue WHERE snapshot_id=?1) open_issues,
        (SELECT COUNT(*) FROM pull_request WHERE snapshot_id=?1) open_prs,
        (SELECT COUNT(*) FROM workflow WHERE snapshot_id=?1) workflows,
        (SELECT COUNT(*) FROM finding WHERE snapshot_id=?1) findings`).get(sid());
      return asTable([t], `snapshot ${s.id} of ${s.org}, collected ${s.taken_at}`);
    },
  },
  {
    name: 'hk_findings',
    description: 'Audit findings, optionally filtered. Omit all filters for counts grouped by code.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: str('critical | high | medium | low | info'),
        category: str('ci | security | actions | version | hygiene | metadata | docs | backlog | lifecycle | atlas'),
        code: str('exact finding code, e.g. CI_RUN_FAILING'),
        repo: str('repo name'),
        limit: int('max rows, default 100'),
      },
    },
    run: ({ severity, category, code, repo, limit = 100 }) => {
      const where = ['snapshot_id = ?'], args = [sid()];
      for (const [col, val] of [['severity', severity], ['category', category], ['code', code], ['repo', repo]]) {
        if (val) { where.push(`${col} = ?`); args.push(val); }
      }
      if (!severity && !category && !code && !repo) {
        return asTable(db.prepare(`SELECT severity, category, code, COUNT(*) n,
          COUNT(DISTINCT repo) repos FROM finding WHERE snapshot_id=?
          GROUP BY severity, category, code
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
            WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, n DESC`).all(sid()),
          'All findings grouped by code. Pass a filter to see individual rows.');
      }
      return asTable(db.prepare(`SELECT repo, severity, code, message, evidence
        FROM finding WHERE ${where.join(' AND ')} ORDER BY repo LIMIT ?`).all(...args, limit));
    },
  },
  {
    name: 'hk_ci',
    description: 'CI health. Default lists repos whose DEFAULT BRANCH is red (the ones that matter).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: str('red_main (default) | scheduled | branches | none | all_runs'),
      },
    },
    run: ({ scope = 'red_main' }) => {
      if (scope === 'scheduled' || scope === 'branches' || scope === 'none') {
        const codes = {
          scheduled: ['CI_SCHEDULED_FAILING'],
          branches: ['CI_DEPENDABOT_FAILING', 'CI_BRANCH_FAILING'],
          none: ['CI_NO_WORKFLOWS', 'CI_NEVER_RAN'],
        }[scope];
        return asTable(db.prepare(`SELECT repo, code, message, evidence FROM finding
          WHERE snapshot_id=? AND code IN (${codes.map(() => '?').join(',')})
          ORDER BY repo`).all(sid(), ...codes));
      }
      if (scope === 'all_runs') {
        return asTable(db.prepare(`SELECT conclusion, COUNT(*) runs FROM workflow_run
          WHERE snapshot_id=? GROUP BY conclusion ORDER BY runs DESC`).all(sid()));
      }
      return asTable(db.prepare(`SELECT r.name repo, r.default_branch branch, r.ci_rollup rollup,
          (SELECT GROUP_CONCAT(wr.workflow_name, '; ') FROM workflow_run wr
            WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name AND wr.is_latest_on_default=1
              AND wr.conclusion='failure' AND wr.event NOT IN ('dynamic','schedule')) failing
        FROM repo r WHERE r.snapshot_id=? AND r.is_archived=0
          AND (${HEAD_CHECKS_RED} OR EXISTS (
            SELECT 1 FROM workflow_run wr WHERE wr.snapshot_id=r.snapshot_id AND wr.repo=r.name
              AND wr.is_latest_on_default=1 AND wr.conclusion='failure'
              AND wr.event NOT IN ('dynamic','schedule')))
        ORDER BY r.name`).all(sid()), 'Repos whose default branch is failing.');
    },
  },
  {
    name: 'hk_repo',
    description: 'Everything known about one repo: metadata, findings, workflows, open PRs and issues.',
    inputSchema: {
      type: 'object',
      properties: { name: str('repo name') },
      required: ['name'],
    },
    run: ({ name }) => {
      const r = db.prepare('SELECT * FROM repo WHERE snapshot_id=? AND name=?').get(sid(), name);
      if (!r) return `No repo named "${name}" in the newest snapshot.`;
      const part = (label, rows) => `\n### ${label}\n${asTable(rows)}`;
      return [
        asTable([r], `## ${name}`),
        part('findings', db.prepare('SELECT severity, code, message FROM finding WHERE snapshot_id=? AND repo=? ORDER BY severity').all(sid(), name)),
        part('workflows', db.prepare('SELECT path, on_triggers, has_paths_filter, has_concurrency, runners, job_count FROM workflow WHERE snapshot_id=? AND repo=?').all(sid(), name)),
        part('open PRs', db.prepare('SELECT number, age_days, mergeable, author, title FROM pull_request WHERE snapshot_id=? AND repo=? ORDER BY age_days DESC').all(sid(), name)),
        part('open issues', db.prepare('SELECT number, age_days, stale_days, author, title FROM issue WHERE snapshot_id=? AND repo=? ORDER BY stale_days DESC').all(sid(), name)),
      ].join('\n');
    },
  },
  {
    name: 'hk_backlog',
    description: 'Open pull requests or issues across the org, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: str('prs (default) | issues'),
        repo: str('restrict to one repo'),
        min_age_days: int('only items older than this'),
        limit: int('max rows, default 50'),
      },
    },
    run: ({ kind = 'prs', repo, min_age_days = 0, limit = 50 }) => {
      const t = kind === 'issues' ? 'issue' : 'pull_request';
      const cols = kind === 'issues'
        ? 'repo, number, age_days, stale_days, comments, author, title'
        : 'repo, number, age_days, mergeable, is_draft, author, title';
      const where = ['snapshot_id = ?', 'age_days >= ?'], args = [sid(), min_age_days];
      if (repo) { where.push('repo = ?'); args.push(repo); }
      return asTable(db.prepare(`SELECT ${cols} FROM ${t}
        WHERE ${where.join(' AND ')} ORDER BY age_days DESC LIMIT ?`).all(...args, limit));
    },
  },
  {
    name: 'hk_health',
    description: 'Per-repo health score (100 minus severity-weighted findings), worst first.',
    inputSchema: { type: 'object', properties: { limit: int('default 25') } },
    run: ({ limit = 25 }) => asTable(db.prepare(`
      SELECT r.name repo,
        COALESCE(SUM(CASE f.severity WHEN 'high' THEN 15 WHEN 'medium' THEN 6
                                     WHEN 'low' THEN 2 ELSE 0 END),0) penalty,
        COUNT(f.code) findings
      FROM repo r LEFT JOIN finding f ON f.snapshot_id=r.snapshot_id AND f.repo=r.name
      WHERE r.snapshot_id=? AND r.is_archived=0
      GROUP BY r.name ORDER BY penalty DESC, r.name LIMIT ?`).all(sid(), limit)),
  },
  {
    name: 'hk_cost',
    description: 'GitHub Actions spend. `scope` picks the grain: "repo" (the invoice, per repo), '
      + '"workflow" or "job" (computed from per-job durations). IMPORTANT: gross and net are '
      + 'different numbers. GitHub meters public repos at full price and discounts them to zero, '
      + 'so gross is compute consumed and net is money owed - never report gross as a bill. '
      + 'Workflow and job grains cover only the repos whose totals reconciled against the invoice; '
      + 'a repo missing from them was not measured, which is not the same as costing nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: str('repo | workflow | job (default repo)'),
        repo: str('restrict to one repo'),
        limit: int('default 25'),
      },
    },
    run: ({ scope = 'repo', repo, limit = 25 }) => {
      const s = sid();
      const has = db.prepare(
        "SELECT COUNT(*) n FROM billing_usage WHERE snapshot_id=? AND product='actions'").get(s);
      if (!has.n) return 'No cost data in this snapshot (billing pass absent or unauthorized). '
        + 'This means NOT MEASURED, not zero cost.';
      if (scope === 'repo') {
        return asTable(db.prepare(`SELECT b.repo,
            ROUND(SUM(b.gross),2) gross_usd, ROUND(SUM(b.net),2) net_usd,
            CASE WHEN r.is_private=1 THEN 'private' ELSE 'public' END visibility,
            ROUND(SUM(CASE WHEN b.sku='Actions Linux'       THEN b.quantity ELSE 0 END)) linux_min,
            ROUND(SUM(CASE WHEN b.sku='Actions Windows'     THEN b.quantity ELSE 0 END)) windows_min,
            ROUND(SUM(CASE WHEN b.sku LIKE 'Actions macOS%' THEN b.quantity ELSE 0 END)) macos_min
          FROM billing_usage b LEFT JOIN repo r ON r.snapshot_id=b.snapshot_id AND r.name=b.repo
          WHERE b.snapshot_id=? AND b.product='actions' AND b.sku<>'Actions storage'
            AND b.repo IS NOT NULL AND (?2 IS NULL OR b.repo=?2)
          GROUP BY b.repo ORDER BY SUM(b.gross) DESC LIMIT ?3`).all(s, repo ?? null, limit));
      }
      if (scope === 'workflow') {
        return asTable(db.prepare(`SELECT c.repo, c.workflow_name workflow, COUNT(*) runs,
            SUM(c.billable_minutes) billable_min, ROUND(SUM(c.cost_usd),2) cost_usd,
            ROUND(AVG(c.billed_job_count),1) jobs_per_run,
            SUM(CASE WHEN c.conclusion='failure' THEN c.billable_minutes ELSE 0 END) failed_min,
            SUM(CASE WHEN c.conclusion='cancelled' THEN c.billable_minutes ELSE 0 END) cancelled_min
          FROM run_cost c
          JOIN cost_reconciliation x ON x.snapshot_id=c.snapshot_id AND x.repo=c.repo
          WHERE c.snapshot_id=? AND x.trustworthy=1 AND (?2 IS NULL OR c.repo=?2)
          GROUP BY c.repo, c.workflow_name ORDER BY SUM(c.cost_usd) DESC LIMIT ?3`)
          .all(s, repo ?? null, limit));
      }
      return asTable(db.prepare(`SELECT j.repo, c.workflow_name workflow,
          TRIM(CASE WHEN j.name LIKE '%(%)' THEN SUBSTR(j.name,1,INSTR(j.name,' (')-1)
                    ELSE j.name END) job,
          COUNT(DISTINCT j.name) matrix_cells, SUM(j.minutes) billable_min,
          ROUND(SUM(j.cost_usd),2) cost_usd
        FROM run_cost_job j JOIN run_cost c
          ON c.snapshot_id=j.snapshot_id AND c.run_id=j.run_id
        JOIN cost_reconciliation x ON x.snapshot_id=j.snapshot_id AND x.repo=j.repo
        WHERE j.snapshot_id=? AND x.trustworthy=1 AND (?2 IS NULL OR j.repo=?2)
        GROUP BY j.repo, c.workflow_name, job ORDER BY SUM(j.cost_usd) DESC LIMIT ?3`)
        .all(s, repo ?? null, limit));
    },
  },
  {
    name: 'hk_sql',
    description: 'Read-only SQL against the warehouse. Tables: snapshot, repo, topic, language, '
      + 'issue, pull_request, release, workflow, workflow_run, file_presence, finding, collect_error, '
      + 'billing_usage, run_cost, run_cost_job, cost_reconciliation. '
      + 'Every table is keyed by snapshot_id.',
    inputSchema: {
      type: 'object',
      properties: { query: str('a single SELECT or WITH statement') },
      required: ['query'],
    },
    run: ({ query }) => {
      return asTable(db.prepare(readOnlyQuery(query)).all());
    },
  },
  {
    name: 'hk_schema',
    description: 'The warehouse schema - table and column names, for writing hk_sql queries.',
    inputSchema: { type: 'object', properties: { table: str('one table, or omit for all') } },
    run: ({ table }) => {
      const tables = table ? [table]
        : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all().map(r => r.name);
      return tables.map(t => {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all();
        if (!cols.length) return `${t}: (unknown table)`;
        return `${t}(${cols.map(c => c.name).join(', ')})`;
      }).join('\n');
    },
  },
];

const server = new Server(
  { name: 'housekeeping', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  // Every failure is a structured result: { code, message, hint, retryable }.
  // A bad argument or a failing query must never take the server down, and a
  // stack trace is never sent to the caller.
  const fail = e => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(structured(e)) }] });
  if (!tool) return fail(userError('UNKNOWN_TOOL', `unknown tool "${req.params.name}"`, `tools: ${TOOLS.map(t => t.name).join(', ')}`));
  try {
    return { content: [{ type: 'text', text: tool.run(req.params.arguments ?? {}) }] };
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
console.error(`[hk-mcp] serving ${TOOLS.length} tools from ${DB_FILE}`);
