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

Both scripts end with `const main = async () => { ... };` followed by a **top-level
`return await main();`**. This pattern is governed by two hard runtime constraints:

- **Top-level `return` is REQUIRED.** The Workflow runtime wraps the script body in an
  async function; the wrapper's return value is what the caller's
  `workflow({ scriptPath }, args)` receives. A bare `await main();` **discards**
  `main()`'s return value → callers get `undefined` → the orchestrator's
  `!convergeResult` guard fires a false `launch_failure`. Top-level `return` is legal
  at runtime but **illegal in ESM**, so `node --check` will always flag it.
- **`void (async () => { ... })();` is FORBIDDEN.** It returns synchronously, so the
  Workflow wrapper resolves immediately → sub-agents torn down ~26ms after spawn.
  `return await main()` keeps the wrapper suspended until `main()` resolves.

Because top-level `return` can't pass `node --check`, validate by stripping that one
line for the syntax check:

```bash
for f in skills/bmad-prd-orchestrate/scripts/bmad-prd-orchestrate.js \
         skills/bmad-build-converge/scripts/bmad-build-converge.js; do
  sed 's/^return await main();$/await main();/' "$f" | node --check --input-type=module
done
```

Exit 0 = the body parses (the top-level `return` is intentional and checked by the
integration test). CI does not run on this repo; this manual check + `node --test` are
the gates. For all other `.js` files in the repo, plain `node --check <file>` is fine.

## Known gotchas (in-flight)

- **`return await main();` — never a bare `await main();`.** The bare form compiles and
  looks harmless but silently discards the return value; the failure only shows at
  runtime as a false `launch_failure`. Guarded by a source-grep test in
  `test/integration.test.mjs`.
- **Unescaped backticks inside template literals.** `bmad-prd-orchestrate.js` agent prompts use template literals that reference shell commands. Backticks inside an agent-prompt template literal MUST be escaped as `\`` (same as every other shell-command reference in the same prompt) — otherwise they close the outer literal early and the JS parser fails on `missing ) after argument list`.
- **MR create flow assumes `find-mr` succeeds after `ensure-mr`.** The atomic `ensure-mr` returns no `mr_iid` (per its YAML header), so the orchestrator's mr-create agent follows up with `BMAD_MR_ACTION=find-mr` to resolve it. Don't skip the find-mr call.
- **First-pipeline race.** `get-mr-pipeline` immediately after MR creation may return empty (pipeline not yet triggered by push). Treated as "no pipeline yet" (`pipelineId=0`, `pipelineStatus="none"`) — CI loop picks up the real pipeline on next poll.
- **Workflow-tool globals are runtime-injected, not imports.** `agent`, `phase`, `log`,
  `workflow`, `args`, `writeState`, `appendJournal` exist only inside the Workflow
  runtime. The sub-workflow dispatch global is lowercase `workflow(nameOrRef, args?)`
  (2-arg form). `Workflow` (capital W) is the main-conversation tool and throws
  `ReferenceError` from inside a workflow script.
