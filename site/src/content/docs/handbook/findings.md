---
title: Findings
description: What each finding means, how severe it is, and the distinctions the rules refuse to blur.
sidebar:
  order: 4
---

A finding is one rule firing on one repository. It has a code, a severity, a
category, a message, and evidence: the run, the file or the rule sentence it
rests on.

Every rule cites the written rule it enforces. The rule files ship in the
repository under `rules/`. They are one organization's standards; if yours
differ, change the rule file and the rule together.

## Severity and the health score

| Severity | Points |
|---|---|
| critical | 40 |
| high | 15 |
| medium | 6 |
| low | 2 |
| info | 0 |

A repository's health score is 100 minus the points of its findings, floored
at zero. `hk health` lists the lowest first.

The score ranks **attention**, not quality. An active repository collects
findings faster than a dormant one.

## Distinctions the rules keep

Most of the work in a rule is refusing to merge two things that look alike.
Merging them produces findings that are confident, plausible and wrong.

### A red default branch is not a red pull-request branch

- `CI_RUN_FAILING`: the newest run on the default branch failed, from a push
  or a pull request. This is a broken mainline.
- `CI_DEPENDABOT_FAILING`, `CI_BRANCH_FAILING`: a branch is red. This is
  backlog.
- `CI_SCHEDULED_FAILING`: a nightly or weekly job is red.

The run's **event** decides which, never the branch name alone.

Each of the three default-branch findings also says where the run broke: the
failed job and step, read from the run's own jobs and matched to the workflow
file by name, never by step number. When the repository keeps an Atlas map,
the step is joined to the map's entry for it, and a map finding recorded
against that same step (a toolchain a package refuses, or a lockfile without
the job's platform) is cited as having predicted the failure. A map finding
at a different step is not cited. A step that cannot be matched, because the
workflow changed since the run or the step is the runner's own, is reported
with the reason rather than guessed.

### History is not breakage

- `CI_STALE_TRIGGER_FAILING`: a workflow's last default-branch run failed,
  and the workflow can no longer run on push. Its history is frozen. It is
  reported as `info`.
- A workflow whose file was deleted keeps its runs forever. Its last failure
  is not a finding at all.

### A check nothing can emit is not a check that did not run here

- `CI_REQUIRED_CHECK_STALE`: branch protection requires a status check that
  no job reports any more. The job was renamed or its matrix cell was dropped.
  Every pull request is blocked. **Repair: drop or rename the requirement.**
- `CI_REQUIRED_CHECK_GATED`: the job exists and passes, but a paths filter
  kept its workflow from running on this pull request. **Repair: fix the
  trigger.** Dropping the requirement would retire a working gate.

The two repairs contradict each other, which is why they are two codes.

### A failed run is not a cancelled one

`ACTIONS_COST_FAILURE_WASTE` counts minutes spent on runs that **failed**.
Cancelled runs are left out: `cancel-in-progress` exists to kill superseded
runs, so cancelled minutes are usually the concurrency rule working.

### Gross cost is not net cost

GitHub meters a public repository at full price and discounts it to zero.
Gross is compute; net is money. They are carried separately everywhere and
never added. `ACTIONS_COST_BILLED_PRIVATE` is the one rule about money.

### Not measured is not clean

- `SECURITY_SCANNING_DISABLED`: GitHub is not scanning the repository, so its
  zero alerts mean nothing.
- A repository the cost pass did not reach has no cost rows. The cost rules
  stay silent about it.
- A setting that could not be read is unknown. `CI_PAGES_NOT_ENABLED` fires
  on an answer of "off", never on a refusal to answer.

## The catalogue

### ci

| Code | Severity | Fires when |
|---|---|---|
| `CI_RUN_FAILING` | high | the newest default-branch run of a push-triggered workflow failed |
| `CI_FAILING` | high | the default branch's check rollup is failing |
| `CI_REQUIRED_CHECK_STALE` | high | a required status check is reported by no job |
| `CI_PAGES_NOT_ENABLED` | high | a workflow deploys to Pages and Pages is switched off |
| `CI_ENVIRONMENT_EXCLUDES_DEFAULT` | high | a job's environment does not admit the default branch |
| `HANDBOOK_SIDEBAR_INCOMPATIBLE` | high | a docs site's sidebar shape and its declared Starlight range disagree |
| `CI_REQUIRED_CHECK_GATED` | medium | open pull requests wait on a check their files never triggered |
| `CI_NO_WORKFLOWS` | medium | nothing verifies the repository on push |
| `CI_NEVER_RAN` | medium | workflow files exist and no run is recorded |
| `CI_SCHEDULED_FAILING` | medium | a scheduled workflow is failing |
| `HANDBOOK_SIDEBAR_BUMP_RISK` | low | the sidebar is valid today and breaks on the next Starlight bump |
| `CI_STALE_TRIGGER_FAILING` | info | a failure frozen under triggers the workflow no longer has |

### security

| Code | Severity | Fires when |
|---|---|---|
| `SECURITY_ALERTS_OPEN` | the worst open alert | Dependabot alerts are open |
| `SECURITY_FIXES_DISABLED` | high | alerts are open and security updates are off, so no fix is coming |
| `SECURITY_SCANNING_DISABLED` | high | vulnerability alerts are off |
| `SECURITY_LOCKFILE_UNREPORTED` | high | a committed lockfile carries critical or high advisories on shipped packages that GitHub reports as zero |
| `SECURITY_LOCKFILE_UNREPORTED_DEV` | medium | the same, on development-only packages |

The lockfile rules exist because GitHub's alert count is per manifest, and a
manifest it has not parsed reports zero. housekeeping reads every committed
`package-lock.json` and `pnpm-lock.yaml` itself and asks the npm advisory
registry.

A package is shipped when a production dependency reaches it. In a pnpm
workspace that includes every workspace package's production dependencies,
not only the root's, so it can name a package that `pnpm audit --prod`, which
reads only the root project, does not.

### actions

| Code | Severity | Fires when |
|---|---|---|
| `WF_MACOS_RUNNER` | high | a workflow uses a macOS runner |
| `WF_TOKEN_CANNOT_EDIT_WORKFLOWS` | high | a job edits a workflow file and pushes with the default token, which cannot |
| `ACTIONS_COST_BILLED_PRIVATE` | high or medium | a private repository's Actions usage is metered against the allowance, or billed |
| `WF_NO_PATHS_FILTER` | medium | a push-triggered workflow has no paths filter |
| `WF_NO_CONCURRENCY` | medium | a workflow has no concurrency block |
| `WF_FILE_COUNT` | medium | more than two push-triggered workflow files |
| `WF_SCHEDULED` | medium | a workflow runs on a schedule |
| `WF_PR_CREATE_DEFAULT_TOKEN` | medium | `gh pr create` runs with the default token |
| `WF_PARSE_ERROR` | medium | a workflow file is not valid YAML |
| `ACTIONS_COST_FAILURE_WASTE` | medium | at least 30% of measured compute, and 120 minutes, went to failed runs |
| `ACTIONS_COST_MATRIX_EXPANDED` | medium | a matrix expanded to more than 6 cells |
| `WF_WINDOWS_RUNNER` | low | a workflow uses a Windows runner |
| `WF_NO_DISPATCH` | low | a workflow has no `workflow_dispatch` |

### version

| Code | Severity | Fires when |
|---|---|---|
| `VERSION_TAG_DRIFT` | high | `package.json` and the newest semver tag disagree |
| `NPM_DRIFT` | high | `package.json` and npm's latest disagree |
| `RELEASE_MISSING` | medium | the newest tag has no GitHub Release |
| `NEVER_TAGGED` | medium | a package has a version and no tag |
| `PRE_1_0` | medium | a package is below version 1.0 |
| `RELEASE_BACKFILL` | info | older tags have no Release; the newest does |
| `NPM_UNPUBLISHED` | info | a public package is not on npm |
| `NO_RELEASES` | info | a substantial repository has never released |
| `MONOREPO_ROOT` | info | the root is a workspace, so its version ships nothing |

### hygiene, metadata, docs

| Code | Severity | Fires when |
|---|---|---|
| `NO_README` | high | no README at the root |
| `NO_LICENSE` | medium | a public repository has no LICENSE |
| `NO_SECURITY` | medium | a public repository has no SECURITY.md |
| `NO_DESCRIPTION` | medium | a public repository has no description |
| `NO_CHANGELOG` | low | a public repository has no CHANGELOG |
| `NO_TOPICS` | low | a public repository has no topics |
| `PKG_CHECKER_NEVER_RUN` | low | a type checker or linter is a dependency and no script runs it |
| `NO_TRANSLATIONS` | info | a published package has no translated README |

### backlog and lifecycle

| Code | Severity | Fires when |
|---|---|---|
| `DEFAULT_BRANCH_NOT_MAIN` | high | the default branch is not `main` |
| `PR_PILEUP` | high or medium | more than 10, or more than 4, open pull requests |
| `PR_STALE` | medium | pull requests open longer than 30 days |
| `PR_CONFLICTED` | medium | pull requests with merge conflicts |
| `CI_DEPENDABOT_FAILING` | medium | a Dependabot branch is red |
| `CI_BRANCH_FAILING` | medium | another branch is red |
| `ISSUE_PILEUP` | medium | more than 10 open issues |
| `REPO_EMPTY` | medium | the repository has no commits |
| `ISSUE_STALE` | low | issues untouched for 90 days |
| `REPO_DORMANT` | low | no push in 180 days, and not archived |

### atlas

| Code | Severity | Fires when |
|---|---|---|
| `ATLAS_MAP_MISSING` | medium | the repository runs workflows and commits no map |
| `ATLAS_CHECK_NOT_IN_CI` | medium | a map is committed and no workflow checks it |
| `ATLAS_ENGINE_BEHIND` | low | the map or its check is pinned behind the current engine (`info` in a snapshot taken before the first fleet pin-bump wave ended) |

## When a finding looks wrong

Check it against GitHub before acting on it, and before trusting the count.
A rule that fires on the wrong repository and a rule that never fires look
the same in the source. The tests assert both directions for every rule, and
the live verifier re-derives a sample of findings from GitHub on its own.

If a rule is wrong for your organization, its written rule is in `rules/`
and its code is in `src/analyze.mjs`. See [Architecture](../architecture/).
