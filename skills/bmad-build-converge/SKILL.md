---
name: bmad-build-converge
description: 'Single-story bmad-build with quality-gate convergence + CI + auto-merge. Standalone or invoked by /bmad-prd-orchestrate.'
---

# Single-Story Build with Convergence

Runs `bmad-build-auto` on a single story, looping review feedback until the story converges, polling CI, fixing CI failures up to `ciMaxIterations`, then auto-merging the MR/PR.

## Prerequisites (consumer project)

Same as `/bmad-prd-orchestrate`:
- BMad installed with `bmad-build-auto` (upstream)
- `bmad-issue-tracking` module installed (`_bmad/custom/issue-tracking.yaml` present)
- `glab` CLI authenticated

## Dispatch

```js
Workflow({
  scriptPath: "<skill_root>/scripts/bmad-build-converge.js",
  args: {
    helpersDir: "<skill_root>/scripts/",
    storyKey,             // required
    maxIterations,        // build convergence loop (default 5)
    timestamp,            // resume target: specific run dir
  },
});
```

`<skill_root>` resolves to wherever `npx skills add` placed this skill.

## Inputs

| Arg | Required | Default | Effect |
|---|---|---|---|
| `storyKey` | yes | — | Story to build (`3-1-add-tests`) |
| `maxIterations` | no | 5 | Build convergence iterations |
| `timestamp` | no | — | Resume target: existing run dir |

## Behavior (phases)

1. **Setup** — discover PRD worktree, read `issue-tracking.yaml`, create story worktree on `feat/<prdKey>/<storyKey>`, set spec status to `in-progress`.
2. **Create MR** — open draft MR/PR from story branch to `feat/<prdKey>/prd` via `glab mr create`.
3. **Build with convergence** — loop `bmad-build-auto` until the story converges (status moves to `done` cleanly). Bounded by `maxIterations`.
4. **CI fix** — poll pipeline status, dispatch CI-fix agent on failure. Bounded by `ciMaxIterations` (default 3).
5. **Auto-merge** — `glab mr merge` on green CI.
6. **Cleanup** — remove story worktree + branch.

## Output

```
<storyWorktreePath>/_bmad-output/implementation-artifacts/bmad-build-converge-runs/<timestamp>/
```

State is held in the run dir for resume. The orchestrator (`/bmad-prd-orchestrate`) handles run-dir journaling at the PRD level; standalone use creates per-story run dirs.

## Companion skill

`/bmad-prd-orchestrate` is the meta-orchestrator that dispatches this skill across all stories. Install both together — they share the `bmad-orchestration` module key.
