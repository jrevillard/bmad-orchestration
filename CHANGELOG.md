# Changelog

All notable changes to `bmad-orchestration` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-15

Initial public release. Two Skills-as-modules under the module key
`bmad-orchestration`, installed together via `npx skills add`.

### Added

- `bmad-prd-orchestrate` skill — PRD meta-orchestrator. Phases: Setup,
  Plan, Execute, Epic boundary, Final report, Cleanup.
- `bmad-build-converge` skill — single-story sub-workflow with CI
  integration and auto-merge. Usable standalone or dispatched by the
  orchestrator.
- Helper scripts (`write-state.sh`, `orchestrate-helper.sh`) installed
  per skill in `scripts/`. Passed via `args.helpersDir` so the JS
  finds them regardless of install location.
- Atomic contract with [`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking)
  module — MR/PR operations routed via `Skill: bmad-issue-tracking-sync`.
  No raw `glab`, `gh`, or tracker HTTP in this repo (enforced by
  `test/integration.test.mjs`).
- 168 unit + integration tests covering pure helpers, dispatch
  contracts, and the no-platform-CLI invariant.
- `LICENSE` (MIT), `CHANGELOG.md`, `README.md`, `docs/compatibility.md`,
  `docs/dev/orchestrator-flow.md`.

### Removed

- `skills/bmad-build-converge/scripts/ci-monitor.sh` — was a
  GitLab-specific poll loop that baked consumer config defaults into a
  generic module. Replaced by [`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking)'s
  `wait-for-green-ci` atomic.
- `skills/bmad-prd-orchestrate/scripts/ci-monitor.sh` — same.

[1.0.0]: https://github.com/jrevillard/bmad-orchestration/compare/0000000...v1.0.0