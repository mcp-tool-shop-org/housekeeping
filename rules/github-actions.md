# GitHub Actions rules

CI minutes are finite. Every workflow must be paths-gated and right-sized.
These are the rules the `actions` findings enforce.

## Triggers

- CI workflows use `on.push.paths` filters, never "all pushes".
- The filter always includes `.github/workflows/**`, so a workflow change is
  tested.
- Every workflow carries `workflow_dispatch` as a manual fallback.
- Release, publish and container workflows trigger on `release: published`
  only, with no push trigger.
- A workflow that emits a required status check takes no paths filter on its
  `pull_request` trigger; its `push` trigger stays paths-gated. Otherwise a
  pull request that touches none of the listed paths, such as a docs-only
  change, never reports the check and can never merge.

## Runners

- The default is `ubuntu-latest`.
- No macOS runner unless explicitly requested.
- Windows only for Windows-only work.
- Cost reality: macOS is roughly 10x Linux per minute, Windows roughly 2x.

## Matrices

- At most one OS unless explicitly requested.
- Two or three language versions at most.
- Never more than 6 total jobs in a matrix without explicit approval. The cap
  is on the cells that run, which a declared job count does not show.

## Workflow file limit

- At most 2 **push-triggered** workflow files per repository: files that fire
  on `push` or `pull_request`.
- Workflows that cannot fire on a push do not count: `release`,
  `workflow_dispatch`, `schedule`, `repository_dispatch`. A release-only
  publish workflow costs nothing until a release is cut, and some registries
  authenticate the workflow's filename, so such files cannot always be merged.

## Concurrency

Every workflow declares:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## Dependabot

- No `dependabot.yml` unless explicitly requested.
- When present: monthly interval, grouped updates, at most 3 open pull requests.

## Scheduled workflows

A scheduled workflow is allowed when it does something a push trigger cannot
(dependency or pin freshness, drift detection against an outside source), runs
weekly or slower (daily needs a stated reason), is bounded (`ubuntu-latest`, an
explicit `timeout-minutes`, a `concurrency` block), opens a pull request rather
than pushing to a protected branch, and carries `workflow_dispatch`.
