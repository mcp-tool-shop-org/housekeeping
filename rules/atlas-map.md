# Atlas map rule

Every repository that runs workflows keeps a committed Atlas map on its
default branch, made by the fleet's current engine version, and runs
`atlas check` in CI. Archived repositories are exempt.

## What it means in a repository

- "Runs workflows" means it has at least one file under `.github/workflows/`.
- The map is the `atlas/` directory written by `atlas map`
  (`@dogfood-lab/atlas`), including `atlas/structure.json`.
- CI runs `npx --yes @dogfood-lab/atlas@<version> check` as a step of an existing push-triggered workflow.
  It is not a new workflow file, so the two-file cap in `github-actions.md` is
  untouched.
- The version is pinned, never floating, and the whole fleet carries the same
  one. It moves by pull request: the pin and the regenerated map in the same
  change.

## Transition (ended)

Until the first pin-bump wave completed, "made by the fleet's current engine
version" was reported and not counted as a defect. From the moment it
completed, an engine behind the fleet's counts as a defect; a snapshot taken
before that moment still reads as it did. A missing map, or a map with no
`atlas check` in CI, counted from the day the rule took effect.

## Why

A map that every repository keeps, made by one engine, is what lets one
question be asked of a whole organization's code.
