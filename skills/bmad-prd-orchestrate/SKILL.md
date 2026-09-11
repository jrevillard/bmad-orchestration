---
name: bmad-prd-orchestrate
description: 'PRD-level meta-orchestrator: drives all stories across all epics with quality-gate convergence + CI + auto-merge. Generic across any BMAD PRD.'
---

# PRD Meta-Orchestrator

Drives `bmad-build-converge` across every story in every epic of a PRD, with single-writer discipline on `sprint-status.yaml` and operator halts at decision points. Pauses for human input on dependency inference, blocked stories, awaiting-operator status, and per-epic retrospectives.

## Prerequisites (consumer project)

- BMad installed with `bmad-sprint-planning`, `bmad-build-auto`, `bmad-retrospective` (upstream skills)
- `bmad-issue-tracking` module installed (provides `_bmad/custom/issue-tracking.yaml`)
- `_bmad/custom/issue-tracking.yaml` configured (platform, host, project, worktree_base, branch_patterns)
- `glab` CLI authenticated
- `bmad-build-converge` skill installed in the same module (ships together — auto-resolved at dispatch)

## Dispatch

```js
Workflow({
  scriptPath: "<skill_root>/scripts/bmad-prd-orchestrate.js",
  args: {
    helpersDir: "<skill_root>/scripts/",
    buildConvergeScriptPath: "<skill_root_parent>/bmad-build-converge/scripts/bmad-build-converge.js",
    // Optional: pass any of these to override
    prdKey,
    hitlEvery,           // ask operator at every story boundary
    hitlFinalOnly,       // ask only at final completion (default)
    inferDeps,           // run LLM-based dependency inference (default true)
    noInfer,             // skip inference (use only declared deps)
    retro,               // invoke bmad-retrospective per epic
    retryPolicy,         // "patient" | "fail-fast" (default "patient")
    resume,              // resume a halted run by runId
    userChoice,          // operator response on halt: continue | retry_blocked | skip_blocked | abort_prd | fix_then_resume | confirm_deps | proceed_without_inference
    maxIterations,
    timestamp,           // resume target: specific run dir
  },
});
```

`<skill_root>` resolves to wherever `npx skills add` placed this skill (typically `.claude/skills/bmad-prd-orchestrate/` or `.agents/skills/bmad-prd-orchestrate/`). `<skill_root_parent>` is one level up — where the sibling `bmad-build-converge/` skill also lives.

## Inputs (optional args)

| Arg | Default | Effect |
|---|---|---|
| `prdKey` | discovered from worktree | Constrain the run to a specific PRD |
| `hitlEvery` | false | Operator halt at every story boundary |
| `hitlFinalOnly` | true | Operator halt only at final completion |
| `inferDeps` | true | Run dependency inference on first dispatch |
| `noInfer` | false | Skip inference (overrides `inferDeps`) |
| `retro` | false | Invoke `bmad-retrospective` per completed epic |
| `retryPolicy` | `"patient"` | `"patient"` or `"fail-fast"` |
| `resume` | undefined | Resume a halted run by runId |
| `userChoice` | undefined | Operator response on halt |
| `maxIterations` | undefined | Bound story attempts per loop |
| `timestamp` | undefined | Resume target: specific run dir |

## Halts

The workflow halts and waits for operator input (`userChoice`) at:
- `dep_inference_confirm` — first-run dependency inference
- `awaiting_operator` — story parked on external action
- `blocked` — story cannot progress without intervention
- `epic_boundary` — when `retro` enabled
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
