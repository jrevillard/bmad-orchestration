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

## Module dependency

This module declares **one** upstream module dependency: `bmad-issue-tracking`. Everything else is a runtime requirement of the consumer project, not a module dep.

| Component | Version | Why |
|---|---|---|
| [`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking) | **v3.0.0 minimum** (BMM 6.12+ with flat `_bmad/{method,toolbox}/` layout) | Provides `_bmad/custom/issue-tracking.yaml` and the `bmad-issue-tracking-sync` skill. Without this, the orchestrator halts on Setup. `bmad-issue-tracking` v2.x is **not supported** — its `_bmad/{bmm,bmb,...}/` legacy layout is incompatible with the v3.x file shape this module reads. |

## Runtime requirements (consumer project)

These are **not** module dependencies — they are BMad's own skills and CLIs that the orchestrator / converge scripts invoke at runtime. The consumer project must have them installed.

| Component | Why |
|---|---|
| BMad (BMM 6.12+ same floor as `bmad-issue-tracking` v3.x) | Provides `_bmad-output/{planning,implementation}-artifacts/`. The orchestration skills run on top of BMad. |
| `bmad-sprint-planning` (skill) | This skill ships `sprint_plan.py` in its `scripts/` folder. The orchestrator's Phase 4 invokes that script directly via `uv run python` (filesystem path, not `Skill:` routing) to write the done transition into `sprint-status.yaml`. The `uv run` wrapper is required because `sprint_plan.py` has PEP 723 inline metadata declaring `dependencies = ["ruamel.yaml>=0.18"]`; `uv` resolves it automatically. Matches the pattern used by this module's own `write-state.sh`. |
| `bmad-build-auto` | Converge loops this until the story converges. |
| `bmad-retrospective` | Orchestrator's `--retro` mode invokes it per epic. |
| `glab` CLI (GitLab) | Authenticated against the configured host. GitHub users go through the same `bmad-issue-tracking-sync` routing via `gh`. |

## Runtime

| Component | Required | Why |
|---|---|---|
| **Claude Code** | required (only) | The workflow scripts depend on Claude Code's Workflow tool globals (`agent`, `phase`, `log`, `workflow`, `args`, `writeState`, `appendJournal`) and the slash-command surface. They will not run on any other tool. |

## Platform coverage

| Platform | Routing | Source of truth |
|---|---|---|
| GitLab | `Skill: bmad-issue-tracking-sync` + `bmad-issue-tracking/common/` atomics | GitLab `issues/{id}` API via `glab` |
| GitHub | `Skill: bmad-issue-tracking-sync` + `bmad-issue-tracking/common/` atomics | GitHub REST via `gh` |

This module **never calls `glab`, `gh`, or any tracker HTTP endpoint directly**.
That abstraction belongs to [`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking). Enforced by
`test/integration.test.mjs` (see the `guard: no platform CLI or tracker API
anywhere in this repo` test).

## Workflow runtime globals

Claude Code's Workflow tool provides these globals to scripts in this module.
Scripts may not import Node built-ins to replace them — the runtime is the
only supported environment.

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

Scope and design constraints live in `README.md` ("Known limitations")
and `CHANGELOG.md`. The compat matrix above is the only thing this doc
owns.