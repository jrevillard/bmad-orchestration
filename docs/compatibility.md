# Compatibility matrix

This module (`bmad-orchestration`) is **a layer on top of BMad**, not a
replacement. It depends on several upstream modules and skills. The table
below is the authoritative compat reference; if you install the wrong
version of one of these, the orchestrator will halt on its first setup
phase with a diagnostic.

## Module manifest

| Field | Value |
|---|---|
| Module key | `bmad-orchestration` |
| Version | `1.0.0` |
| License | MIT |
| Both skills share the manifest | yes (`update_source` + `knowledge` byte-identical per the BMad installer rule) |

## Required upstream

| Component | Version | Why |
|---|---|---|
| `bmad-issue-tracking` | **v2.x** for BMM 6.11+ (legacy `_bmad/{bmm,bmb,...}/` layout) OR **v3.x** for BMM 6.12+ (flat `_bmad/{method,toolbox}/` layout) | Provides `_bmad/custom/issue-tracking.yaml`. Without this file, the orchestrator cannot read platform/host/project and halts on Setup. |
| `bmad-build-auto` | latest | The dev primitive called in a loop by `bmad-build-converge` until convergence. |
| `bmad-sprint-planning` | latest (orchestrator only) | Phase 4 invokes `sprint_plan.py generate --set <key>=done` to advance the PRD branch to its final state. |
| `bmad-retrospective` | latest (orchestrator, `--retro` only) | Per-epic retrospective — opt-in via the orchestrator's first-run question. |
| `glab` CLI | any recent | GitLab authentication against the configured host. |

## Platform coverage

| Platform | Routing | Source of truth |
|---|---|---|
| GitLab | `Skill: bmad-issue-tracking-sync` + `bmad-issue-tracking/common/` atomics | GitLab `issues/{id}` API via `glab` |
| GitHub | `Skill: bmad-issue-tracking-sync` + `bmad-issue-tracking/common/` atomics | GitHub REST via `gh` |

This module **never calls `glab`, `gh`, or any tracker HTTP endpoint directly**.
That abstraction belongs to `bmad-issue-tracking`. Enforced by
`test/integration.test.mjs` (see the `guard: no platform CLI or tracker API
anywhere in this repo` test).

## Workflow runtime

This module's `.js` files are executed by Claude Code's Workflow tool. The
runtime provides the following globals; scripts may not import Node built-ins
to replace them:

| Global | Purpose |
|---|---|
| `agent(label, prompt, opts)` | Dispatch a sub-agent |
| `phase` | Current phase name |
| `log(msg)` | Stream log to the workflow console |
| `workflow(nameOrRef, args?)` | Dispatch a sub-workflow (2-arg form, lowercase) |
| `args` | Dispatch arguments |
| `writeState(stateObj)` | Persist state to the run dir |
| `appendJournal(event)` | Append a structured event to `journal.jsonl` |

Top-level `await main();` discards the return value. Scripts end with
`return await main();` so the Workflow wrapper's return value reaches the
caller. Guarded by `test/integration.test.mjs`.

## Consumer project requirements

Your project must already have:

- `_bmad-output/implementation-artifacts/` (created by BMad sprint-planning)
- `_bmad-output/planning-artifacts/` (created by BMad PRD planning)
- A worktree at `<repoRoot>/<worktree_base>/<branch>` whose branch matches
  `feat/<prdKey>/prd` (the orchestrator dispatches into it)
- `glab` authenticated for the GitLab host configured in
  `_bmad/custom/issue-tracking.yaml`

If any of these are missing, the orchestrator halts with a specific halt
reason at Setup — not a generic error.

## What is NOT covered

- **Body-drift detection in the sync loop** — by design. `sync-issues`
  handles status labels (cheap, idempotent, safe to run unattended).
  `complete.yaml` workflows refresh bodies when the source artifact
  actually changes. Adding continuous body-drift restoration would
  thrash manual edits. See `CHANGELOG.md` ("Known limitations") and the
  design intent in `bmad-issue-tracking`'s `SKILL.md`.
- **Direct tracker / pipeline HTTP calls** — always routed through
  `Skill: bmad-issue-tracking-sync` or the module's workflow atomics.
  Hardcoding a platform call would re-introduce the GitLab-specific
  leak that the deleted `ci-monitor.sh` left behind.
- **Multi-tenant / per-tenant tracker configuration** — the orchestrator
  reads `_bmad/custom/issue-tracking.yaml` once at setup and uses it for
  the whole run. Re-configuring mid-run is not supported.