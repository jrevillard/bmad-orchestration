---
name: bmad-prd-orchestrate
description: 'PRD-level meta-orchestrator: drives all stories across all epics with quality-gate convergence + CI + auto-merge. Generic across any BMAD PRD.'
---

# PRD Meta-Orchestrator

Drives `bmad-build-converge` across every story in every epic of a PRD, with single-writer discipline on `sprint-status.yaml` and operator halts at decision points. Pauses for human input on dependency inference, blocked stories, awaiting-operator status, and per-epic retrospectives.

## Before dispatching — discover runs, then ask operator

### Step 1 — discover incomplete runs

Run `ls -1 <prdWorktreePath>/_bmad-output/implementation-artifacts/orchestrate-runs/` (the prd worktree is the one on a `feat/*/prd` branch — discover via `git worktree list --porcelain`). For each entry that is a directory AND contains a `state.json` whose `halts[]` is non-empty OR whose `storyQueue` is non-empty (i.e. not at `final_complete`), treat it as a resumable run. Capture its `<timestamp>` dir name and the `prdKey` from its `state.json`.

### Step 2 — ask questions (one `AskUserQuestion` batch)

Order is conditional on Step 1. Each row below is always asked unless marked **(omit if no runs)**.

| Order | Header | Asked | Options | Maps to |
|---|---|---|---|---|
| 1 | `Resume` | **only if Step 1 found ≥1 run** | one option per discovered run (label: `<timestamp> — <prdKey> · <N> completed · <M> blocked`) · `Fresh run` | `resume: <timestamp>` or omit (fresh) |
| next | `Scope` | always | `Full PRD` · `Single epic` (follow-up: which?) · `Single story` (follow-up: which?) | `prdKey` + `epicKey`/`storyKey` |
| next | `HITL` | always | `Final only` (default) · `Every epic` · `Every story` · `Off` | `hitlFinalOnly` / `hitlEveryEpic` / `hitlEvery: 1` / both false |
| next | `Retro` | always | `Off` (default) · `Per epic` (halt + invoke `bmad-retrospective`) | `retro: true` |
| next | `Dep inference` | always | `Confirm` (default — halt at `dep_inference_confirm` for operator to review inferred edges) · `Auto-accept` (run inference, auto-apply inferred edges without halting) · `Use declared only` (skip inference, use only `depends_on` fields from PRD) | `inferDeps=true` + `autoAcceptDeps=true` / `inferDeps=true` / `noInfer=true` |

If no resumable runs → `Resume` row is omitted and the batch starts at `Scope`.
If ≥1 resumable runs → `Resume` is asked first; `Scope`/`HITL`/`Retro` follow.

Defaults if user skips: scope=full PRD, HITL=final only, retro=off, dep inference=Confirm, `maxRetries=3`.

## Prerequisites (consumer project)

- BMad installed with `bmad-sprint-planning`, `bmad-build-auto`, `bmad-retrospective` (upstream skills)
- `bmad-issue-tracking` module installed (provides `_bmad/custom/issue-tracking.yaml`)
- `_bmad/custom/issue-tracking.yaml` configured (platform, host, project, worktree_base, branch_patterns)
- `glab` CLI authenticated
- `bmad-build-converge` skill installed in the same module (ships together — auto-resolved at dispatch)

## Dispatch

Before the `Workflow()` call, compute the dispatch args:

```js
// timestamp: per-run unique identifier.
// - Fresh run: generate `YYYYMMDD-HHMMSS-XXXX` where the suffix is a unique
//   tag (e.g., short process id or a counter) — keeps run-dir names sortable
//   and collision-free across same-second dispatches.
// - Resume: pass the `<timestamp>` of the discovered run (from Step 1).
// `Date.now()` is FORBIDDEN inside the script (breaks resume), so the
// timestamp MUST come from the dispatcher (where it's safe to call).
const freshTimestamp = `<YYYYMMDD-HHMMSS>-<uniqueSuffix>`; // compute before calling Workflow()

Workflow({
  scriptPath: "<skill_root>/scripts/bmad-prd-orchestrate.js",
  args: {
    helpersDir: "<skill_root>/scripts/",
    buildConvergeScriptPath: "<skill_root_parent>/bmad-build-converge/scripts/bmad-build-converge.js",
    // Optional: pass any of these to override
    prdKey,
    hitlEvery,           // ask operator at every story boundary
    hitlEveryEpic,       // ask operator at every epic boundary (independent of retro)
    hitlFinalOnly,       // ask only at final completion (default)
    inferDeps,           // run LLM-based dependency inference (default true)
    noInfer,             // skip inference (use only declared deps)
    retro,               // invoke bmad-retrospective per epic
    maxRetries,          // integer: re-queue each ci_hardfail halt up to N times before blocking (default 3; 0 = never retry)
    autoAcceptDeps,      // run dependency inference but skip the dep_inference_confirm halt (default false → halt to confirm)
    resume,              // resume a halted run by runId (omitted for fresh runs)
    userChoice,          // operator response on halt: continue | retry_blocked | skip_blocked | abort_prd | fix_then_resume | confirm_deps | proceed_without_inference
    maxIterations,
    timestamp: resume || freshTimestamp,  // resume target OR fresh run identifier
  },
});
```

`<skill_root>` resolves to wherever `npx skills add` placed this skill (typically `.claude/skills/bmad-prd-orchestrate/` or `.agents/skills/bmad-prd-orchestrate/`). `<skill_root_parent>` is one level up — where the sibling `bmad-build-converge/` skill also lives.

## Inputs (optional args)

| Arg | Default | Effect |
|---|---|---|
| `prdKey` | discovered from worktree | Constrain the run to a specific PRD |
| `hitlEvery` | false | Operator halt at every story boundary |
| `hitlEveryEpic` | false | Operator halt at every epic boundary (independent of retro) |
| `hitlFinalOnly` | true | Operator halt only at final completion |
| `inferDeps` | true | Run dependency inference on first dispatch |
| `noInfer` | false | Skip inference (overrides `inferDeps`) |
| `retro` | false | Invoke `bmad-retrospective` per completed epic |
| `maxRetries` | `3` | Integer: re-queue each `ci_hardfail` halt up to N times before blocking. `0` = never retry (block immediately). Higher = more tolerant of transient CI failures. |
| `resume` | undefined | Resume a halted run by runId |
| `userChoice` | undefined | Operator response on halt |
| `maxIterations` | undefined | Bound story attempts per loop |
| `timestamp` | auto-generated fresh | Resume target (specific run dir) OR fresh-run identifier (`YYYYMMDD-HHMMSS-XXXX`) — dispatcher MUST compute before calling `Workflow()`. The script's `'unknown'` fallback exists as defense-in-depth but should never be reached in practice. |

## Halts

The workflow halts and waits for operator input (`userChoice`) at:
- `dep_inference_confirm` — first-run dependency inference
- `awaiting_operator` — story parked on external action
- `blocked` — story cannot progress without intervention
- `epic_boundary` — when `retro` enabled OR `hitlEveryEpic` is true
- `final_complete` — all stories reached terminal status

## Outputs

```
<prdWorktreePath>/_bmad-output/implementation-artifacts/orchestrate-runs/<timestamp>/
├── state.json          # run state (resume anchor)
├── deps.json           # inferred + declared dependencies
└── journal.jsonl       # phase-by-phase journal
```

`<timestamp>` is `YYYYMMDD-HHMMSS-XXXX` (date + monotonic). On resume, pass the `timestamp` arg.

## Companion skill

`/bmad-build-converge` is the sub-workflow this orchestrator dispatches. Install both in the same `npx skills add` invocation; they share the `bmad-orchestration` module key.
