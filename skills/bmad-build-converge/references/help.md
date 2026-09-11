# Module: bmad-orchestration — build-converge

See `bmad-prd-orchestrate/references/help.md` for the module-level routing pointer.

This skill is the sub-workflow of `/bmad-prd-orchestrate`. It runs:

1. Create a story worktree on `feat/<prdKey>/<storyKey>`
2. Open a draft MR/PR from the story branch to `feat/<prdKey>/prd`
3. Loop `bmad-build-auto` up to `maxIterations` (default 5) until convergence
4. Loop CI-fix iterations up to `ciMaxIterations` (default 3)
5. Auto-merge the MR/PR on green CI
6. Clean up the story worktree + branch

Generic across any BMAD PRD. The dispatch shape is documented in the workflow's `.js` `meta` block.

## Companion skill

`/bmad-prd-orchestrate` is the meta-orchestrator that dispatches this skill across all stories of a PRD. Install both together — they share the `bmad-orchestration` module key.

## Direct use

You can invoke this skill directly for a single story without the orchestrator:
```
/bmad-build-converge --storyKey 3-1-add-tests --maxIterations 5
```
This skips the PRD-level state machine, run-dir journaling, and per-epic halts. Use it when you want convergence on one story without orchestrating the rest.
