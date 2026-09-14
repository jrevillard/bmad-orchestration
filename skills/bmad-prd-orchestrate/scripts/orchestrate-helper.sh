#!/usr/bin/env bash
# orchestrate-helper.sh — grouped state helpers for bmad-prd-orchestrate.
#
# Subcommand:
#   read-status <sprintStatusPath> <prdWorktreePath> <baseBranch>
#     → raw YAML content of sprint-status.yaml on stdout
#
# Reads the AUTHORITATIVE sprint-status from origin/<baseBranch>, NOT the prd
# worktree's working tree. Reason: the prd worktree is on baseBranch but its
# HEAD doesn't advance after every merge — converge pushes the in-progress
# sprint-status commit onto storyBranch (step 7), and the merge agent's MR
# merge pushes onto origin/<baseBranch>. The prd worktree's working tree
# stays stale until something fetches. Reading the working tree made
# `findUnmetDeps` see already-completed deps as still `backlog`, which left
# dep-chained stories stuck in `state.skipped` indefinitely (orchestration
# loop iterations 1-4 of the fresh2 run). `git show origin/<baseBranch>:path`
# is always fresh post-merge and never modifies the working tree (so it can't
# race with Phase 4's pending sprint-status writes between iterations).
#
# Fallback to `cat <path>` if the remote ref doesn't exist yet (first
# iteration of a fresh repo, or network down). That's the same stale read
# we used to have, but only in the rare "no origin ref" case — the common
# loop iteration now reads the merged state.
#
# Usage from workflow script:
#   await agent("Run bash ${helpersDir}/orchestrate-helper.sh read-status ARGS",
#     { schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }, agentType: 'general-purpose' })
#
# The JS side parses the content with parseSprintStatuses (pure function,
# unit-tested) — bash is the executor, JS owns the parse.
#
# Exit codes: 0 success, 1 bad args, 2 file not found.

set -euo pipefail

cmd="${1:-}"

case "$cmd" in
  read-status)
    [ $# -eq 4 ] || { echo "usage: read-status <sprintStatusPath> <prdWorktreePath> <baseBranch>" >&2; exit 1; }
    SP="$2"; PRDW="$3"; BASE="$4"
    [ -f "$SP" ] || { echo "{\"error\":\"sprintStatus not found: $SP\"}" >&2; exit 2; }
    # 1. Refresh origin/<baseBranch> in the prd worktree's object store. Silent
    #    (no failure on network/auth hiccups) and harmless when origin is
    #    already current — `git fetch` is idempotent on a matching SHA.
    git -C "$PRDW" fetch origin "$BASE" >/dev/null 2>&1 || true
    # 2. Path relative to the repo root for `git show`. sprintStatusPath is
    #    absolute and lives inside prdWorktreePath (per the orchestrator's
    #    setup, line 476 of bmad-prd-orchestrate.js), so strip the prefix.
    REL="${SP#"$PRDW"/}"
    # 3. Authoritative read: the file as committed on origin/<baseBranch>.
    #    Fall back to the working tree only if the remote ref doesn't exist
    #    yet (first iteration of a brand-new repo where no merge has happened).
    git -C "$PRDW" show "origin/${BASE}:${REL}" 2>/dev/null || cat "$SP"
    ;;

  *)
    echo "usage: $0 read-status <sprintStatusPath> <prdWorktreePath> <baseBranch>" >&2
    exit 1
    ;;
esac
