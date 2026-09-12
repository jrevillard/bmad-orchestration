# Orchestrator flow — reference diagrams

These diagrams capture the **expected behavior** at every step. Use them when
debugging or refactoring — any drift between the diagrams and the code is a
bug. All diagrams are Mermaid (GitHub-renderable, no extra tooling).

## 1. End-to-end sequence — "already merged" scenario

The scenario that motivated most of the recent fixes (1-1, 1-2 merged
externally; orchestrator must pick that up correctly).

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Skill as bmad-issue-tracking<br/>SKILL.md dispatcher
    participant Orch as bmad-prd-orchestrate
    participant Build as bmad-build-converge
    participant GH as GitHub/GitLab<br/>issue tracker

    User->>Skill: Q1-Q5 (Resume run / Scope / HITL / Retro / Dep inference)
    Skill->>Orch: Workflow({ scriptPath: bmad-prd-orchestrate.js, args: { ... } })
    Note over Orch: Phase 1: loadState() → resume data
    Orch->>Orch: Phase 1: setup agent (worktree, prdWorktreePath, ...)
    Orch->>Orch: Phase 1: writeState (persist)
    Orch->>Orch: Phase 2: plan agent (storyQueue, deps, inferred)
    Orch->>Orch: Phase 2: writeState (persist plan)
    Note over Orch: userChoice='confirm_deps' → applyUserChoice → state.inferred set
    Orch->>Orch: Phase 2: writeState (persist confirmed)
    Orch->>Orch: Phase 3: enter per-story loop

    loop For each story in state.storyQueue
        Orch->>Orch: read sprint-status (status + deps)
        Orch->>Build: Workflow({ scriptPath: bmad-build-converge.js, args: { storyKey, ... } })
        Note over Build: Phase 1: setup agent
        Build->>Build: merge-check (git merge-base --is-ancestor)
        alt Branch already merged (1-1, 1-2 case)
            Build-->>Orch: { converged: true, merge: { merged: true, alreadyMerged: true }, ... }
            Note over Orch: isConverged(convergeResult) → true (merge.merged OR converged)
            Orch->>Orch: state.completed.push(sk)
            Orch->>Orch: state = removeFromState(state, sk) [cleanup stale blocked/halts]
            Orch->>Orch: appendJournal 'converged' (via: 'merge')
        else Branch not yet merged (normal path)
            Build->>Build: Phase 1: setup agent
            Build->>Build: Phase 2: mr-create (finds existing commits ahead, creates MR)
            Build->>Build: Phase A: convergence loop (build + ci)
            Build->>Build: Phase B: ci gate
            Build->>Build: Phase C: merge
            Build->>Build: Phase D: cleanup
            Build-->>Orch: { converged: true, merge: { merged: true, ... }, ... }
            Orch->>Orch: state.completed.push(sk)
            Orch->>Orch: state = removeFromState(state, sk)
            Orch->>Orch: appendJournal 'converged' (via: 'converged')
        end
    end

    Note over Orch: Phase 4: Final report
    Orch->>Orch: sprint-status-sync agent (with try/catch)
    Orch->>Orch: bash: sprint_plan.py generate --set <key>=done (advances YAML)
    alt YAML advanced > 0
        Orch->>Orch: git add + commit + push origin
        Note over Orch: For each completed story AND each done epic:
        Orch->>Build: Skill: bmad-issue-tracking-sync<br/>BMAD_ISSUE_ACTION=set-status<br/>BMAD_ISSUE_KEY="<key>"<br/>BMAD_ISSUE_NEW_STATUS="done"<br/>BMAD_ISSUE_CLOSE=false
        Build->>GH: Update label (status:done, remove status:backlog)
        Build-->>Orch: { issue_id }
        Orch->>Orch: labelsSynced++ (count)
    end
    Orch->>Orch: appendJournal 'phase4_sprint_status_sync' (includes labelsSynced)

    alt --retro=true AND epic advanced
        Orch->>Build: Skill: bmad-retrospective
    end

    Orch-->>Skill: return { ... }
    Skill-->>User: display results
```

### Key invariants

1. **Workflow() is lowercase** (`workflow({...})`) — capital `Workflow` is the
   main-conversation tool, throws `ReferenceError` from sub-workflow context.
2. **`isConverged()` accepts EITHER** `converged:true` OR `merge.merged:true`.
3. **build-converge merge-check uses `git merge-base --is-ancestor`**, then
   case-insensitive check on stdout (`MERGED` / `merged`).
4. **Each story's spec file lives in `_bmad-output/implementation-artifacts/stories/<key>.md`**.
5. **Phase 4 labels sync is REQUIRED**, not optional — without it, completed
   stories stay labeled `status:backlog` while YAML says `done` (the bug we
   fixed).

## 2. Per-story lifecycle (orchestrator's per-story loop)

```mermaid
stateDiagram-v2
    [*] --> Queued : state.storyQueue.push(sk)
    Queued --> SetupRunning : Workflow(bmad-build-converge)
    SetupRunning --> MergedAlready : setup returned OK + merge-check=MERGED
    SetupRunning --> ConvergenceRunning : setup returned OK, MERGED check=false
    SetupRunning --> LaunchFailed : Workflow() threw OR convergeResult=null
    SetupRunning --> MRConflict : convergeResult.aborted is truthy
    ConvergenceRunning --> CIMonitor : build converged → CI gate
    ConvergenceRunning --> BuildFailed : convergedSha=null after maxIterations
    CIMonitor --> Merged : monitor.status='success' + merge.merged=true
    CIMonitor --> CIHardFail : monitor.status !== 'success'
    CIMonitor --> MergeBlocked : monitor.status='success' BUT merge.merged=false
    MergedAlready --> Completed : orchestrator isConverged() → state.completed.push
    Merged --> Completed
    Completed --> Queued : shift, next story
    CIHardFail --> Blocked : state.blocked.push + journal 'halt_ci_hardfail'
    MergeBlocked --> Blocked : state.blocked.push + journal 'halt_merge_blocked'
    BuildFailed --> Blocked : state.blocked.push + journal 'halt_build_phase_failed'
    LaunchFailed --> Blocked : state.blocked.push + journal 'halt_launch_failure'
    MRConflict --> Blocked : state.blocked.push + journal 'halt_merge_conflict'
    Blocked --> Queued : operator picks retry_blocked → front of queue
    Blocked --> Skipped : operator picks skip_blocked → moved to skipped[]
```

### Key invariants

- **Completed** is reached only via `isConverged(convergeResult) === true`,
  which means EITHER `converged === true` OR `merge.merged === true`.
- **Blocked** is reached only via one of: launch_failure, ci_hardfail,
  merge_blocked, merge_conflict, or build_phase_failed. Each pushes to
  `state.blocked` AND `state.halts` (with matching `reason`) AND journals
  `halt_<reason>`.
- **Skipped** is reached only via `userChoice='skip_blocked'` → moves blocked
  stories to `state.skipped[]` (not deleted).
- **removeFromState(state, sk)** is called every time a story enters
  `state.completed` — cleans stale entries from a previous failed attempt.

## 3. Halt / resume cycle

```mermaid
stateDiagram-v2
    [*] --> Running : Workflow() dispatched
    Running --> Halted : halt reason in {dep_inference_confirm, launch_failure,<br/>ci_hardfail, merge_blocked, merge_conflict,<br/>epic_boundary, periodic_review, final_complete}
    Halted --> Running : resume with userChoice
    Running --> Completed : main() returns final report
    Completed --> [*]

    note right of Halted
      halts[] contains the reason + story + iteration
      haltReasonsByReason = {
        dep_inference_confirm → userOptions = [confirm_deps, proceed_without_inference, abort_prd]
        launch_failure, ci_hardfail, merge_blocked, merge_conflict,
        epic_boundary, final_complete → userOptions = [continue, retry_blocked, skip_blocked, abort_prd, fix_then_resume]
      }
      pickReHaltReason(state.halts) → latest entry's reason (NOT always dep_inference_confirm)
    end note

    note right of Running
      canHalt via:
      - userChoice halt (abort_prd)
      - infra launch failure (workflow() throws)
      - mr create abort (convergeResult.aborted)
      - ci hard fail (monitor.status !== 'success')
      - merge blocked (monitor.status='success' AND merge.merged=false)
      - epic boundary (hitlEveryEpic=true)
      - periodic_review (hitlEvery > 0)
      - final_complete (after all stories)
    end note
```

### Key invariants

- **Re-halt picks the LATEST halt** (not always `dep_inference_confirm`).
  Bug we fixed: previous code always re-halted `dep_inference_confirm`,
  leaving operators no way to use `skip_blocked` after a `launch_failure`.
- **`userChoice` handler** (in `applyUserChoice`) transforms the
  `planResult.inferred` graph without touching other fields.
- **`skip_blocked`** moves all blocked stories to `skipped[]` and clears
  `blocked[]` + drops matching halt entries (state hygiene).
- **`moveBlockedToSkipped`** is the pure helper for the `skip_blocked`
  mutation.

## 4. Phase 4 sync — sprint-status vs issue labels

```mermaid
flowchart TD
    A[Phase 4 sprint-status-sync agent dispatched] --> B{advanced > 0?}
    B -- no --> Z1[Skip commit+push, return labelsSynced:0]
    B -- yes --> C[Run sprint_plan.py generate --set &lt;key&gt;=done]
    C --> D{YAML modified?}
    D -- no --> Z2[Skip commit+push]
    D -- yes --> E[git add + commit + push origin]
    E --> F[For each completed story AND each advanced epic]
    F --> G[Invoke Skill: bmad-issue-tracking-sync<br/>BMAD_ISSUE_ACTION=set-status<br/>BMAD_ISSUE_KEY=&lt;key&gt;<br/>BMAD_ISSUE_NEW_STATUS=done]
    G --> H{issue found?}
    H -- yes --> I[gh/glab update label status:done]
    H -- no --> J[Log warn, continue]
    I --> K[labelsSynced++]
    J --> K
    K --> L{more entities?}
    L -- yes --> F
    L -- no --> M[appendJournal phase4_sprint_status_sync<br/>includes labelsSynced]

    style G fill:#e1f5ff
    style M fill:#e1ffe1
```

### Key invariants

- **Both** the YAML file AND the issue labels must advance. YAML without
  label-sync = drift between source-of-truth and UI.
- **Soft-fail per entity** — one missing issue doesn't block the rest.
  `labelsSynced` counts only entities where the Skill returned a non-null
  `issue_id`.
- **`allowedTools: ['Skill', 'Bash']`** passed by the orchestrator — runtime
  enforces the constraint (the prompt is a hint, not enforcement).
- **try/catch around the sync call** — if the Skill global is unavailable
  (ReferenceError) or the call fails, the orchestrator catches and continues
  with safe defaults (`labelsSynced: 0`). The PRD never halts on label-sync.
