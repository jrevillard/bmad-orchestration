# BMad Orchestration

> **Claude Code only.** This module's workflow scripts depend on Claude Code's Workflow tool globals (`agent`, `phase`, `log`, `workflow`, `args`, `writeState`, `appendJournal`) and the slash-command surface (`/bmad-prd-orchestrate`, `/bmad-build-converge`). It will not run on any other tool. If you are not on Claude Code, this module is not for you.

Two Skills-as-modules skills under the module key `bmad-orchestration`:

| Skill | Role |
|---|---|
| `/bmad-prd-orchestrate` | PRD meta-orchestrator: drives all stories across all epics with quality-gate convergence + CI + auto-merge |
| `/bmad-build-converge` | Single-story build + convergence loop + CI-fix + auto-merge (sub-workflow of the orchestrator; usable standalone) |

Both skills ship self-contained: the workflow `.js` plus the helper bash scripts (`write-state.sh`, `orchestrate-helper.sh`) live in each skill's `scripts/` folder. Claude Code's Workflow tool reads the JS and dispatches with the `script` parameter; helper paths are passed via `args.helpersDir` so the JS finds them at runtime regardless of install location.

Neither skill calls a platform CLI or a tracker API directly. `glab`, `gh`, and the tracker/pipeline HTTP calls belong to the [`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking) module, which owns that abstraction; this repo reaches them only through `Skill: bmad-issue-tracking-sync` or by executing one of the module's workflow atomics (its CI wait, its issue-comment atomic). A `test/integration.test.mjs` guard enforces it across both scripts and both `scripts/*.sh`.

## Install

In a project that already has BMad set up:

```bash
npx skills add github:jrevillard/bmad-orchestration
```

Installs both skills under `.agents/skills/`. Claude Code discovers them and exposes `/bmad-prd-orchestrate` + `/bmad-build-converge` as slash commands.

For local development against this repo:

```bash
npx skills add /absolute/path/to/bmad-orchestration
```

## Prerequisites

This module declares **one** upstream module dependency: `bmad-issue-tracking`. Everything else is a runtime requirement of the consumer project, not a module dep.

### Module dependency

- **[`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking) v3.0.0 minimum** (BMM 6.12+ with flat `_bmad/{method,toolbox}/` layout). Provides `_bmad/custom/issue-tracking.yaml` and the `bmad-issue-tracking-sync` skill. Without this, the orchestrator halts on Setup.
- `bmad-issue-tracking` v2.x is **not supported** — its `_bmad/{bmm,bmb,...}/` legacy layout is incompatible with the v3.x file shape this module reads. If your project still has v2.x installed, upgrade before installing this module.

### Runtime requirements (consumer project)

The orchestrator and converge scripts call the following BMad skills at runtime. They must exist in the consumer's BMad install — they are **not** module dependencies of `bmad-orchestration`; they are BMad's own skills, and BMad is what `bmad-issue-tracking` (and these orchestration skills) run on top of.

- **BMad installed in the consumer project** — BMM 6.12+ (same floor as `bmad-issue-tracking` v3.x).
- `bmad-sprint-planning` — the skill ships `sprint_plan.py` in its `scripts/` folder. Orchestrator's Phase 4 invokes that script directly (`python3 .../bmad-sprint-planning/scripts/sprint_plan.py generate --set <key>=done`) to mark converged stories as done in `sprint-status.yaml`. The story-level done transition works. Epic-level advancement and spec→ready-for-dev upgrade inside `sprint_plan.py` have a known filename mismatch with this module's producer format — see `Known limitations`.
- `bmad-build-auto` — converge loops this until the story converges.
- `bmad-retrospective` — orchestrator's `--retro` mode invokes it per epic.
- `glab` CLI (GitLab) authenticated against the configured host. (GitHub users go through the same `bmad-issue-tracking-sync` routing via `gh`.)

## Layout

```
bmad-orchestration/
├── README.md
├── .gitignore
└── skills/
    ├── bmad-prd-orchestrate/
    │   ├── SKILL.md
    │   ├── module-manifest.toml
    │   ├── references/help.md
    │   └── scripts/
    │       ├── bmad-prd-orchestrate.js
    │       ├── write-state.sh
    │       └── orchestrate-helper.sh
    └── bmad-build-converge/
        ├── SKILL.md
        ├── module-manifest.toml
        ├── references/help.md
        └── scripts/
            ├── bmad-build-converge.js
            ├── write-state.sh
            └── orchestrate-helper.sh
```

## Versioning

Module key: `bmad-orchestration`. Version: `1.0.0`. Both skills in this module declare the same version.

A `v1.0.0` git tag exists on `main`. `bmad setup --doctor` is happy.

## Usage

Two slash commands are available after install:

### `/bmad-prd-orchestrate`

Drives every story of a PRD through `bmad-build-converge`. The skill asks 4 questions before dispatch (discover resumable runs, scope, HITL cadence, retro, dep inference), then runs Setup → Plan → Execute → Epic boundary → Final report → Cleanup. Halts at decision points for operator input.

Most common invocation: open the slash command, pick `Fresh run`, scope=`Full PRD`, HITL=`Final only`. Resumable runs from previous sessions are auto-discovered.

### `/bmad-build-converge`

Single-story convergence without orchestrator overhead. Useful for fixing one stuck story or testing a converged pipeline without the PRD-level state machine.

```
/bmad-build-converge --storyKey 3-1-add-tests
```

## Troubleshooting

### `bmad setup --doctor` reports `blocked` on this module

You installed this repo before the `v1.0.0` git tag existed, OR your local
cache is stale. Update the install:

```bash
npx skills update bmad-orchestration
```

### Orchestrator halts with `sprint_status_path_not_found`

`_bmad-output/implementation-artifacts/sprint-status.yaml` doesn't exist in
your prd worktree. Run `bmad-sprint-planning` first, then re-dispatch.

### Orchestrator halts with `issue_tracking_yaml_missing`

`_bmad/custom/issue-tracking.yaml` is not present. Install and run
[`bmad-issue-tracking`](https://github.com/jrevillard/bmad-issue-tracking)
v3.0.0 minimum (BMM 6.12+). See `docs/compatibility.md` for the full
compat table.

### `bmad-build-converge` halts with `workflow is not a function`

A regression in a script. Either an outdated script bundle, or someone
edited `bmad-build-converge.js` and reintroduced capital-W `Workflow({`.
Re-pull from the repo and re-dispatch. `test/integration.test.mjs` catches
this typo class at module-test time.

### Story stays `backlog` after merging the MR externally

The orchestrator probes `origin/<baseBranch>` (not the prd worktree's
stale working tree). The first probe after a merge happens before the
working tree catches up. The next iteration of the loop re-fetches and
sees the new state. If a story stays `backlog` across two iterations
after a successful merge, file an issue with the run journal.

### Many rebase attempts in a converge run

Converge is fighting sprint-status push conflicts on the shared PRD
branch. By design, converge does NOT push the done transition under the
orchestrator — Phase 4 owns that write. If you see rebase loops, you
have an outdated converge script that hasn't been redeployed. Re-pull
and re-dispatch.

## Known limitations

- **No body-drift detection in the sync loop.** By design — see
  `CHANGELOG.md` ("Known limitations") and `docs/compatibility.md`
  ("What is NOT covered"). Sync handles status labels only;
  `complete.yaml` workflows refresh bodies on artifact change.
- **No CI wait inside `bmad-build-auto`'s hook under converge.**
  Converge creates `<worktreePath>/.bmad-ci-handled` to silence the
  hook. Without the marker, every consumer is unchanged. See
  `CLAUDE.md` ("Interference from the module's on_complete hook")
  for the full rationale.
- **Sprint-status freshness** — first probe after a merge may see the
  pre-merge state; the second iteration re-fetches and corrects.
  Observed in long debug sessions, never in healthy runs.
- **`bmad-sprint-planning` integration is story-level only.** Phase 4
  invokes `sprint_plan.py generate --set <key>=done` and the story-level
  done transition works (verified by the `advanced` counter in the run
  journal). The epic-level advancement and the spec→ready-for-dev
  upgrade inside `sprint_plan.py` have a known filename mismatch with
  this module's producer (`spec-<id>-<slug>.md` vs `f"{key}.md"`) and
  silently no-op. Fixing it belongs upstream in `bmad-sprint-planning`;
  this module intentionally does not patch around it.

## Examples

### Fresh run on a single PRD

```bash
# In your consumer project root, with BMad + bmad-issue-tracking installed:
/bmad-prd-orchestrate
# Pick: Fresh run · Full PRD · Final only · Off · Confirm
```

### Resume a paused run

```bash
/bmad-prd-orchestrate
# Pick: <discovered-timestamp> — testprd · 7 completed · 1 blocked · Full PRD · Final only
```

### Converge a single story directly

```bash
/bmad-build-converge --storyKey 2-3-sync-drift-reconciliation --maxIterations 5
```

### End-to-end flow at a glance

```
user → /bmad-prd-orchestrate
  → discover runs (1st Q)
  → user picks scope/HITL/retro/dep-inference
  → Setup: discover prd worktree, load issue-tracking.yaml, derive setup
  → Plan: ask plan agent for storyQueue + deps, halt at dep_inference_confirm (if Confirm)
  → Execute loop:
      for each sk in storyQueue:
        recheck skipped[] for newly-met deps
        probe sk's status from origin/<baseBranch>
        if done → mark completed, continue
        if awaiting-operator → park in awaitingOperator[], continue
        if unmet deps → skip (reason: unmet_deps)
        else → dispatch bmad-build-converge (sub-workflow)
              converge creates story worktree, loops bmad-build-auto, polls CI, auto-merges
        on merge → journal + (issue-comment, issue done — soft-fail)
        on halts: persist, return to user, await userChoice
  → Epic boundary: mark epic in-progress on issue tracker (soft-fail)
  → Per epic: optional bmad-retrospective (if --retro)
  → Final report: Phase 4 syncs sprint-status + issue labels via bmad-issue-tracking-sync
  → Cleanup
```

## Documentation

- `CHANGELOG.md` — release notes (Keep-a-Changelog format)
- `LICENSE` — MIT
- `docs/compatibility.md` — full compat matrix (modules, BMM layouts, platforms)
- `docs/dev/orchestrator-flow.md` — Mermaid diagrams (end-to-end sequence,
  per-story lifecycle, halt/resume cycle, Phase 4 sync). Dev reference.
- `CLAUDE.md` — dev guide for working on this repo (test recipe, layout
  rules, architecture notes). Not user-facing.

## License

MIT. See `LICENSE`.
