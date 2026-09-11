# Module: bmad-orchestration

Two Skills-as-modules skills under the same module key (`bmad-orchestration`):
- `/bmad-prd-orchestrate` — meta-orchestrator across all epics of a PRD
- `/bmad-build-converge` — single-story build + convergence loop

Claude Code Workflow tool layer on top of BMad's BMAD layout. Both skills ship self-contained (workflow `.js` + helper bash scripts in each skill's `scripts/`).

## When this module applies

When you want unattended PRD execution with quality-gate convergence, CI integration, and auto-merge. Replaces `bmad-build-auto` calls in a loop with a controlled state machine that halts on operator decisions and recovers from CRITICAL escalations.

## When this module does NOT apply

- Single-story development with no orchestration (use `bmad-build` directly).
- Repos without `_bmad/custom/issue-tracking.yaml` (workflow reads platform/host/project from this file).
- Repos without `bmad-issue-tracking` v2.x or v3.x installed (the config file is created by that module's setup skill).

## Routing

For behavior details and the dispatch contract, see the references in each skill folder:
- `bmad-prd-orchestrate/references/` and `bmad-build-converge/references/`
- Both workflows' `.js` meta blocks are the authoritative source of truth for phases + args.

This doc is a routing pointer. Skill bodies describe usage; workflows describe behavior.
