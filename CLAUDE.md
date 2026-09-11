# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **BMad Skills-as-modules** distribution (module key `bmad-orchestration`). Two skills ship here, installed into consumer projects via `npx skills add`. There is no build, lint, or test step — the workflow `.js` files are shipped as-is and executed by Claude Code's Workflow tool at consumer-runtime.

## Architecture

**Two skills, one module, sibling install.**

- `skills/bmad-prd-orchestrate/` — PRD meta-orchestrator. Discovers stories, drives each through the converge sub-workflow, single-writes `sprint-status.yaml`, halts at decision points.
- `skills/bmad-build-converge/` — Single-story sub-workflow. Runs `bmad-build-auto` until the story converges, polls CI, fixes CI failures, auto-merges the MR/PR. Usable standalone or as the orchestrator's loop body.

Both skills share the same module key (`bmad-orchestration`) and version (`1.0.0`) declared in their `module-manifest.toml`. The `update_source` and `knowledge` fields must be **byte-identical** between the two — the BMad installer enforces this (see `setup.py:818-820` in the upstream `bmad-issue-tracking` repo).

**Cross-skill dispatch contract.** The orchestrator's SKILL.md dispatcher passes `args.buildConvergeScriptPath` (resolved as `<skill_root_parent>/bmad-build-converge/scripts/bmad-build-converge.js`). The orchestrator script reads this arg and calls `workflow({ scriptPath: convergeScriptPath }, {...})`. The two skills MUST install in the same `npx skills add` invocation (they share the parent dir at install time). If you change either script's path, update both `SKILL.md` dispatcher blocks.

**Helper scripts** (`write-state.sh`, `orchestrate-helper.sh`, `ci-monitor.sh`) live in each skill's `scripts/` folder. Passed via `args.helpersDir` so the JS finds them at runtime regardless of install location. Each skill has its own copy (not shared) — keep them in sync if you edit one.

## Runtime dependency: `bmad-issue-tracking` module

The orchestrator and converge scripts read `_bmad/custom/issue-tracking.yaml` (created by `bmad-issue-tracking-setup`). They dispatch MR/PR operations via `Skill: bmad-issue-tracking-sync` using `BMAD_MR_*` env vars (ACTION, SOURCE_BRANCH, TARGET_BRANCH, TITLE, DESCRIPTION_FILE, REPO, IID, SQUASH, PIPELINE_ID). The atomic contracts live in `bmad-issue-tracking-setup/assets/workflows/common/` (ensure-mr, find-mr, get-mr-pipeline, get-failed-jobs, merge-mr).

Compatibility tracks the consumer's `bmad-issue-tracking` version:
- v2.x → BMM 6.11+ (legacy `_bmad/{bmm,bmb,...}/` layout)
- v3.x → BMM 6.12+ (flat `_bmad/{method,toolbox}/` layout)

When bumping this module, verify against the consumer's installed `bmad-issue-tracking` version — atomic contracts evolve.

## Local development install

```bash
# From a consumer project (e.g. bmad-test-tracking):
npx skills add /absolute/path/to/bmad-orchestration --skill bmad-build-converge --skill bmad-prd-orchestrate -a claude-code -y
```

The install drops copies into `.claude/skills/`, `.agents/skills/`, and other agent dirs. For live iteration against source changes, `npx skills add` produces snapshots (not symlinks) for cross-repo sources — re-run on each source change, or symlink manually.

## Pre-commit check

Both scripts are wrapped in `const main = async () => { ... }; await main();` after `export const meta`. This pattern:
- Makes top-level `await main()` legal in ESM (`--input-type=module` lets `node --check` pass with exit 0).
- Wraps all `return` statements inside `main()` so they're inside an async function (legal in both Workflow runtime AND `node --check --input-type=module`).
- Keeps sub-agents alive at runtime: the Workflow tool wraps the script body in `async () => { ... }`, so the top-level `await main()` suspends the wrapper until `main()` resolves. Spawning `void (async () => { ... })();` would return synchronously → Workflow wrapper resolves → tear down → sub-agents killed ~26ms after spawn.

Pre-commit validation:

```bash
node --check --input-type=module < skills/bmad-prd-orchestrate/scripts/bmad-prd-orchestrate.js
node --check --input-type=module < skills/bmad-build-converge/scripts/bmad-build-converge.js
```

Exit 0 = parse OK, safe to commit. CI does not run on this repo; this manual check is the only gate. For all other `.js` files in the repo, plain `node --check <file>` is fine.

## Known gotchas (in-flight)

- **Wrap pattern is fixed.** `const main = async () => { ... }; await main();` after `export const meta` in both scripts. Do NOT replace with `void (async () => { ... })();` — that returns synchronously and the Workflow tool tears down sub-agents ~26ms after spawn. The `await main()` at top level keeps the Workflow tool's wrapper suspended until main resolves, so sub-agents (setup agent in particular) stay alive.
- **Unescaped backticks inside template literals.** `bmad-prd-orchestrate.js` agent prompts use template literals that reference shell commands. Backticks inside an agent-prompt template literal MUST be escaped as `\`` (same as every other shell-command reference in the same prompt) — otherwise they close the outer literal early and the JS parser fails on `missing ) after argument list`.
- **MR create flow assumes `find-mr` succeeds after `ensure-mr`.** The atomic `ensure-mr` returns no `mr_iid` (per its YAML header), so the orchestrator's mr-create agent follows up with `BMAD_MR_ACTION=find-mr` to resolve it. Don't skip the find-mr call.
- **First-pipeline race.** `get-mr-pipeline` immediately after MR creation may return empty (pipeline not yet triggered by push). Treated as "no pipeline yet" (`pipelineId=0`, `pipelineStatus="none"`) — CI loop picks up the real pipeline on next poll.
