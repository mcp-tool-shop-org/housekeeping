import type { SiteConfig } from '@mcptoolshop/site-theme';

const REPO = 'https://github.com/mcp-tool-shop-org/housekeeping';

export const config: SiteConfig = {
  title: 'housekeeping',
  description:
    'An operational-health warehouse for a GitHub organization: CI, pull requests, releases, Actions cost and repo hygiene, collected into SQLite and audited against written rules.',
  logoBadge: 'HK',
  brandName: 'housekeeping',
  repoUrl: REPO,
  footerText:
    'MIT Licensed — built by <a href="https://mcp-tool-shop.github.io/" style="color:var(--color-muted);text-decoration:underline">MCP Tool Shop</a>',

  hero: {
    badge: 'Open source',
    headline: 'housekeeping',
    headlineAccent: 'every repo, one question.',
    description:
      'One sweep collects CI, pull requests, releases, security alerts, lockfiles and Actions billing for a whole GitHub organization into SQLite, ' +
      'then audits it against written rules. <strong>Read-only.</strong> It changes nothing on GitHub.',
    primaryCta: { href: '#usage', label: 'Get started' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Sweep', code: 'hk refresh' },
      { label: 'Ask', code: 'hk ci' },
      { label: 'Dig', code: 'hk sql "SELECT ..."' },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'answers',
      title: 'What it answers',
      subtitle: 'For the whole organization at once, without opening each repository.',
      features: [
        {
          title: 'Which default branches are red',
          desc: 'A broken mainline is kept apart from a failing Dependabot branch, a failing nightly job, and history left behind by a workflow that no longer runs on push.',
        },
        {
          title: 'Which pull requests can never merge',
          desc: 'A required status check that no job reports blocks every pull request, and every other view still reads green. This finds it.',
        },
        {
          title: 'Which deploys the settings refuse',
          desc: 'Pages switched off under a deploy workflow, or an environment that does not admit the default branch. Neither shows in a workflow file.',
        },
        {
          title: 'Where versions have drifted',
          desc: 'The version in package.json, the newest semver tag, the newest Release and npm, side by side.',
        },
        {
          title: 'What Actions cost, and which job spent it',
          desc: 'Per-job cost rebuilt from run durations, then checked against the invoice. A repository whose numbers disagree is reported as not measured.',
        },
        {
          title: 'Which advisories GitHub is not counting',
          desc: 'Every committed npm lockfile is read directly and checked against the advisory registry, because an unparsed manifest reports zero alerts.',
        },
      ],
    },
    {
      kind: 'features',
      id: 'principles',
      title: 'How it stays trustworthy',
      subtitle: 'An audit that is confident and wrong is worse than none.',
      features: [
        {
          title: 'Every finding cites a written rule',
          desc: 'The rule files ship in the repository. A finding is arguable against a standard, not against taste.',
        },
        {
          title: 'Not measured is never clean',
          desc: 'A refused API call, an unscanned repository and an unread setting are reported as unknown. None of them is recorded as zero.',
        },
        {
          title: 'Snapshots are the source of truth',
          desc: 'Each sweep is one immutable JSON file. The database is derived and rebuilds offline, so drift between two dates is a join.',
        },
        {
          title: 'Rules are tested in both directions',
          desc: 'The shape that must fire, and the neighbouring shape that must not. A separate verifier re-derives findings from live GitHub.',
        },
      ],
    },
    {
      kind: 'code-cards',
      id: 'usage',
      title: 'Use it',
      subtitle: 'Node 22.5 or later, and the GitHub CLI signed in.',
      cards: [
        {
          title: 'Install',
          code: 'gh repo clone \\\n  mcp-tool-shop-org/housekeeping\ncd housekeeping\nnpm install && npm link',
        },
        {
          title: 'Sweep',
          code: '# set "org" in\n# housekeeping.config.json\nhk refresh',
        },
        {
          title: 'Ask',
          code: 'hk ci          # red mainlines\nhk findings    # by severity\nhk health      # worst first\nhk cost        # gross and net',
        },
        {
          title: 'Serve it to an assistant',
          code: 'npm run mcp\n# hk_ci, hk_findings, hk_repo,\n# hk_cost, hk_sql and more',
        },
      ],
    },
    {
      kind: 'data-table',
      id: 'private',
      title: 'Keep the data private',
      subtitle: 'The tool is public. What a sweep writes is not.',
      columns: ['A snapshot contains', 'Why it matters'],
      rows: [
        ['Private repository names', 'Their existence is not public.'],
        ['Open security alerts', 'GitHub hides these from everyone but maintainers.'],
        ['The Actions invoice', 'Your spending, line by line.'],
      ],
    },
  ],
};
