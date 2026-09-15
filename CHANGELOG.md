# Changelog

All notable changes to `bmad-orchestration` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-15

Initial public release. Two Skills-as-modules under the module key
`bmad-orchestration`, installed together via `npx skills add`.

### Added

- **`bmad-prd-orchestrate`** — PRD meta-orchestrator. Drives every story
  across every epic of a PRD through `bmad-build-converge`, with operator
  halts at decision points and single-writer discipline on
  `sprint-status.yaml`. Phases: Setup, Plan, Execute, Epic boundary, Final
  report, Cleanup.
- **`bmad-build-converge`** — single-story sub-workflow. Creates a story
  worktree on `feat/<prdKey>/<storyKey>`, opens a draft MR/PR, loops
  `bmad-build-auto` to convergence, polls CI, auto-merges on green.
  Usable standalone or as the orchestrator's loop body.
- **Helper scripts** (`write-state.sh`, `orchestrate-helper.sh`) — installed
  per skill in `scripts/`. Passed via `args.helpersDir` so the JS finds
  them at runtime regardless of install location.
- **Atomic contract** with `bmad-issue-tracking` module — all MR/PR
  operations dispatched via `Skill: bmad-issue-tracking-sync`. No raw
  `glab`, `gh, or tracker HTTP calls in this repo (see
  `test/integration.test.mjs` guard).
- **168 unit + integration tests** covering pure helpers, dispatch
  contracts, and the no-platform-CLI invariant.

### Notable design points

- **Sub-workflow dispatch** uses `workflow({ scriptPath }, args)` (the
  2-arg form, lowercase). `Workflow` (capital-W) is the
  main-conversation tool and throws `ReferenceError` from inside a
  workflow script.
- **`return await main();`** at the top level of each script. A bare
  `await main();` discards the return value, which silently makes
  `workflow(...)` return `undefined` and triggers a false `launch_failure`.
- **Sprint-status freshness** — the orchestrator reads from
  `origin/<baseBranch>` via `git show`, not the prd worktree's stale
  working tree. A `git fetch` precedes the read. A `cat` fallback only
  fires if the remote ref doesn't exist (first iteration of a fresh
  repo). Guarded by `test/integration.test.mjs`.
- **No raw platform CLI** in this repo. The previous `ci-monitor.sh` was
  deleted for hardcoding GitLab-specific paths into a generic module.
  CI gating now runs the `bmad-issue-tracking` module's
  `wait-for-green-ci` atomic.
- **Worktree marker** `<worktreePath>/.bmad-ci-handled` silences
  `bmad-build-auto`'s terminal hook (which would otherwise duplicate
  MR / CI / issue work and reintroduce the CI wait the convergence loop
  deliberately removed). Without the marker, every other consumer is
  unchanged.
- **Module manifests are byte-identical** between the two skills — the
  BMad installer enforces this (`update_source`, `knowledge`, `version`,
  `module`). Guarded by code review.

### Compatibility

| Consumer | Required | Notes |
|---|---|---|
| `bmad-issue-tracking` | v2.x | BMM 6.11+ (`_bmad/{bmm,bmb,...}/` layout) |
| `bmad-issue-tracking` | v3.x | BMM 6.12+ (`_bmad/{method,toolbox}/` layout) |
| `bmad-build-auto` | latest | dev primitive called by `bmad-build-converge` |
| `bmad-sprint-planning` | latest | required by orchestrator (Phase 4 done-transition sync) |
| `bmad-retrospective` | latest | orchestrator's `--retro` mode only |
| `glab` CLI | any recent | GitLab authentication; `gh` analog via the `bmad-issue-tracking` module on GitHub repos |

### Known limitations

- No body-drift detection in the sync loop (by design — see
  `CHANGELOG.md` and `SKILL.md` for the intentional split between
  `sync-issues.yaml` (labels only, idempotent) and `complete.yaml`
  workflows (body refresh on artifact change). Adding continuous
  body-drift restoration would conflict with this design.
- Converge does not write `sprint-status.yaml` to `done` — the
  orchestrator's Phase 4 is the sole writer on the PRD branch. Pushing
  the done transition from inside converge caused 35+ rebase attempts
  per merge agent on a moving shared branch.

### Install

```bash
npx skills add github:jrevillard/bmad-orchestration
```

Both skills install under `.agents/skills/`. Slash commands
`/bmad-prd-orchestrate` and `/bmad-build-converge` become available.

[1.0.0]: https://github.com/jrevillard/bmad-orchestration/releases/tag/v1.0.0