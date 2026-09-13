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

## Flow reference diagrams

**`docs/orchestrator-flow.md`** — Mermaid diagrams (GitHub-renderable) capturing the expected runtime behavior: end-to-end sequence, per-story lifecycle, halt/resume cycle, and Phase 4 sync. **Read these before changing orchestration logic** — any drift between the diagrams and the code is a bug. The diagrams document the **JS orchestrator** (this repo), NOT `bmad-loop` (a separate Python orchestrator — see the memory `bmad-orchestration-vs-bmad-loop`).

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

### Deploying edits to the test worktree

The live test harness lives in a consumer worktree (e.g.
`/home/jerome/git_projects/bmad-test-tracking/.claude/worktrees/prd-test-loop-v2/`).
After editing the scripts here, copy them into that worktree's `.agents/skills/` before
re-running:

```bash
TEST_WT=/home/jerome/git_projects/bmad-test-tracking/.claude/worktrees/prd-test-loop-v2
cp skills/bmad-prd-orchestrate/scripts/bmad-prd-orchestrate.js "$TEST_WT/.agents/skills/bmad-prd-orchestrate/scripts/"
cp skills/bmad-build-converge/scripts/bmad-build-converge.js   "$TEST_WT/.agents/skills/bmad-build-converge/scripts/"
# tests too, so the guard tests run against the deployed copy:
mkdir -p "$TEST_WT/.agents/skills/bmad-prd-orchestrate/test"
cp skills/bmad-prd-orchestrate/test/*.mjs "$TEST_WT/.agents/skills/bmad-prd-orchestrate/test/"
```

Only the **scripts** (and optionally tests) need deploying — the `docs/` diagrams are
developer references, not consumed at runtime.

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

## Story/spec discovery — never re-derive the filename

`bmad-build-auto` OWNS the spec filename, and its slug comes from the story TITLE via
`sprint_plan._slug` (`[^\w]+ -> '-'`, underscore preserved). So the name equals the
sprint-status key only when both were derived from the same title — `test_hello.py`
slugs to `test_hello-py`. Two slugifiers disagreeing once put `test_hello.py-…` in
`state.json` while sprint-status, deps.json and the journal all had `test_hello-py-…`:
**one story, two identities**, and a story that merged while its issue stayed `backlog`.

- `specPathCandidates()` / `extractStoryId()` encode the rule; `renderSpecDiscovery()`
  and `renderSpecPatterns()` render it INTO the agent prompts, so prompt and rule cannot
  drift (same idiom as `describeSchema`). Edit the rule once, in one place per script —
  the two scripts cannot import each other, so both copies must change together.
- Order: **exact `spec-<key>.md` first**, then `spec-<storyId>-*.md` (sprint mode), then
  `stories/<storyId>-*.md` (stories mode), then the legacy `{key}.md`.
- On several matches in ONE pattern, take the **shortest** name: escalation artifacts are
  suffixed (`…-blocked-attempt.md`, what an intent-gap exit leaves behind), so a suffix
  only ever makes a name longer. Halt only on a same-length tie.
- Two known gaps, both outside this repo: story **1-1's spec has no id prefix at all**
  (`spec-create-hello-py-with-print-hello.md`), so no candidate list finds it; and Phase
  4 passes `--stories-dir` at a directory that does not exist in sprint mode, where
  `sprint_plan.py:271` guards the scan with `is_dir()` and silently skips its
  `ready-for-dev` upgrade (its `:278` also matches `{key}.md`, not the producer's name).
  Fixing that belongs upstream in `bmad-sprint-planning`.

## State keys are validated on read — both sides

After `loadState`, every key is checked against the keys the plan produced. An unknown
key means a story has two identities, so the run **halts** (`state_key_rejected`) with
the offending key rather than dispatching a name nothing else recognises.

- `storyKeysOf()` must wrap **both** sides of the comparison. `state.blocked`/`skipped`
  hold `{story, reason}` OBJECTS while `completed`/`storyQueue` hold bare keys, and the
  plan is agent-authored so it can hold either. Normalizing one side only makes every
  real key read as unknown and halts a healthy resume — that bug shipped once in each
  direction.
- The validator is **skipped when the run is scoped** (`--epic`/`--story`): the plan then
  covers a subset by design, so "not in the plan" carries no signal.
- The pure-function tests must feed **object-form** `blocked`/`skipped` entries. Feeding
  strings only is how the Critical above passed CI.

## Interference from the module's `on_complete` hook — and the marker that fixes it

`bmad-build-auto`'s terminal hook runs the `bmad-issue-tracking` module's
`post-build-dispatch.yaml` → `post-dev-complete.yaml`, which pushes, waits for CI, writes
`ci-status.json`, updates the issue and ensures the MR. **Inside every build dispatch.**
That duplicates our own MR/CI/issue work, and worse, it re-introduces the CI wait the
convergence loop deliberately removed (PHASE A: "NO CI WAIT … saves ~3-5min per iter").
Measured from the run traces: **47 s, 55 s, 305 s** of CI waiting inside three 2-1 build
dispatches, and 151 s in a successful 1-4 dispatch — against 52-83 s for converge's own
`ci-check`.

**The channel is a FILE, not an environment variable.** The setup agent writes
`<worktreePath>/.bmad-ci-handled` (prompt step 7b). The module reads it at the FIRST step of
`common/post-build-dispatch-auto.yaml` — the hook's entry point — and stops there, so under
converge the **entire chain does nothing**: no `check-config`, no spec read, no status
routing, no phase. Absent marker → the chain runs exactly as before, so bmad-loop and every
other consumer are unchanged.

- **Never retry the env-var route.** `BMAD_SKIP_CI_WAIT` was written and reverted: the
  module's suite forbids any shell variable in a step
  (`tests/test_command_patterns.py::test_no_unresolved_shell_vars`, only awk's `NF` is
  allowed), and its separator rule additionally flags a `${X:-default}` colon. The
  workflow language simply has no env channel.
- **The marker must stay untracked.** It is not gitignored; the module already expects
  orchestrator-owned untracked files in the worktree (its hook comment names
  sprint-status.yaml and deferred-work.md). Never `git add` it, and never commit it — it
  exists only for the lifetime of the worktree, which cleanup removes.
- **`cwd` is what makes it visible**: both build dispatches pass
  `cwd: setup.worktreePath` and `dispatchViaClaudeP` `cd`s into it, so the hook's `pwd`
  (the module's `{worktree}`) is that same directory.
- Removing the hook's steps instead is not an option: they are the module's product for
  bmad-loop, whose `[verify]` command fails without the `ci-status.json` they write
  (`skills/bmad-issue-tracking-setup/scripts/bmad-loop/ci-gate/ci-status.sh:32`), and
  nothing at that level distinguishes our calls from bmad-loop's — both drive the same
  `bmad-build-auto`.
