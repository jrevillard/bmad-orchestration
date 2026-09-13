export const meta = {
  name: 'bmad-prd-orchestrate',
  description: 'PRD-level meta-orchestrator: drives all stories across all epics with quality-gate convergence + CI + auto-merge. Generic across any BMAD PRD.',
  phases: [
    { title: 'Setup' },
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Epic boundary' },
    { title: 'Final report' },
    { title: 'Cleanup' },
  ],
};

const main = async () => {

// Per-script counter for unique temp filenames. Hoisted to top of main() so the
// let is initialized BEFORE Phase 2's first writeState call (line ~285). Functions
// hoist, but `let` does not — declaring writeStateCallSeq inside the function body
// AFTER first use would TDZ-fail (ReferenceError). Workflow tool forbids Date.now()
// and Math.random() (break resume), so a simple increment is the only option.
let writeStateCallSeq = 0;

// ============================================================================
// Pure helpers — kept as named function declarations (not arrow consts) so the
// test harness (test/pure.test.mjs) can extract them via vm.runInNewContext
// and unit-test in isolation. Do not reference Workflow globals (agent, phase,
// log, args) inside these — they're tested outside the Workflow runtime.
// ============================================================================

// extractEpicKey(sk) → first dash-separated segment of the canonical story key.
// Format: `<epicNum>-<storyNum>[-<suffix>]` per upstream bmad-issue-tracking
// `bmad-workflow-lang.md:451-452` (e.g. `1-3-login-form`, optional letter
// suffix `4-1-a`). Falls back to sk itself if no dash (bare epic key or empty).
function extractEpicKey(sk) {
  return (sk.split('-')[0]) || sk;
}

// extractStoryId(storyKey) → the "<epic>-<story>" prefix of a canonical key.
// bmad-build-auto names the spec `spec-<storyId>-<slug>.md`, so the id prefix is
// the only stable part of that name: the slug comes from the story title and WILL
// differ from the key (test_hello.py → test_hello-py — two identities for one
// story in a live run).
// Pure, self-contained (the vm test harness extracts it in isolation).
function extractStoryId(storyKey) {
  const parts = String(storyKey || '').split('-');
  if (parts.length >= 2 && parts[0] && parts[1]) return `${parts[0]}-${parts[1]}`;
  return parts[0] || '';
}

// specPathCandidates(storyId, storyKey) → ordered relative path patterns.
// bmad-build-auto owns the spec filename (BMAD-METHOD step-01-clarify-and-route):
//   sprint mode  → {implementation_artifacts}/spec-{slug}.md
//   stories mode → {spec_folder}/stories/{story_id}-{slug}.md
// Discover by prefix; never re-derive the slug.
// Duplicated in bmad-build-converge.js on purpose — Workflow-tool scripts cannot
// import each other, and both must render the SAME rule into their prompts.
function specPathCandidates(storyId, storyKey) {
  const base = '_bmad-output/implementation-artifacts';
  const out = [];
  // EXACT first — see bmad-build-converge.js for the full rationale: the sprint-mode
  // slug comes from the title via sprint_plan's _slug, so it matches the key in the
  // normal case, and a story can have SIBLING spec files (…-blocked-attempt.md) that
  // would make the prefix glob alone ambiguous.
  if (storyKey) out.push(`${base}/spec-${storyKey}.md`);
  if (storyId) {
    out.push(`${base}/spec-${storyId}-*.md`);       // sprint mode
    out.push(`${base}/stories/${storyId}-*.md`);    // stories mode
  }
  if (storyKey) out.push(`${base}/${storyKey}.md`); // legacy: no spec- prefix
  return out;
}

// renderSpecDiscovery(storyKey) → the discovery block rendered into agent prompts,
// generated from specPathCandidates so prompt and rule cannot drift.
function renderSpecDiscovery(storyKey) {
  return specPathCandidates(extractStoryId(storyKey), storyKey)
    .map(p => `     ${p}`).join('\n');
}

// renderSpecPatterns() → the id-prefix patterns with a literal <storyId> token, for
// prompts that iterate over MANY stories (the plan agent) rather than resolving one.
// Built from the same specPathCandidates, so the rule still has one source.
function renderSpecPatterns() {
  return specPathCandidates('<storyId>', '').map(p => `     ${p}`).join('\n');
}

// findUnknownStoryKeys(keys, known) → keys with no counterpart in `known`.
// A key persisted to state.json that the plan (built from sprint-status.yaml)
// never produced means the SAME story exists under two identities — the failure
// that put `test_hello.py-…` in state.json while everything else said
// `test_hello-py-…`. Returning them lets the caller halt with a diagnostic instead
// of dispatching a story under a name nothing else recognises.
// Pure: filter + Set, no side effects. Unit-tested (test/pure.test.mjs).
function findUnknownStoryKeys(keys, known) {
  const knownSet = new Set(known || []);
  return (keys || []).filter(k => k && !knownSet.has(k));
}

// storyKeysOf(entries) → the story key of each entry, falsy entries dropped.
// state.blocked and state.skipped do NOT hold strings: they hold {story, reason}
// objects (skipped at :1182, blocked at :1226/:1245/:1266/:1279/:1308,
// moveBlockedToSkipped at :289-295), while completed/storyQueue/awaitingOperator hold
// bare keys. Comparing the objects raw against a Set of known strings is ALWAYS
// false — which would make the state-key validator halt exactly the recovery paths
// (retry_blocked, fix_then_resume) it exists to protect.
// Same normalization idiom as removeFromState / requeueCIHardfails.
// Pure, unit-tested (test/pure.test.mjs).
function storyKeysOf(entries) {
  return (entries || [])
    .map(e => (typeof e === 'string' ? e : (e && e.story) || null))
    .filter(Boolean);
}

// base64Encode(input) → string
// Pure-JS UTF-8 → base64 encoder (Workflow runtime lacks `Buffer` + `btoa`).
// Used by writeState's bash command to safely embed state/deps JSON in a
// single-line command (heredocs were vulnerable to LLM rewriting). Keep in
// sync with the equivalent in skills/bmad-build-converge/scripts/bmad-build-converge.js
// (no shared module — Workflow-tool JS files can't import each other).
function base64Encode(input) {
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (input.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i], b2 = i + 1 < bytes.length ? bytes[i + 1] : 0, b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += A[b1 >> 2];
    out += A[((b1 & 3) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? A[((b2 & 0xf) << 2) | (b3 >> 6)] : '=';
    out += i + 2 < bytes.length ? A[(b3 & 0x3f)] : '=';
  }
  return out;
}

// isEpicTransition(lastEpic, currentEpic) → true when currentEpic differs from
// lastEpic (including first iteration where lastEpic=null → "(start)"). Pure
// comparison — no side effects.
function isEpicTransition(lastEpic, currentEpic) {
  return lastEpic !== currentEpic;
}

// shouldHaltAtEpicTransition(hitlEveryEpic, lastEpic, currentEpic) → boolean
// Combines the hitlEveryEpic flag with the transition check. Returns true
// when (a) the operator opted in to epic-boundary halts AND (b) the epic is
// actually changing (NOT first iteration — lastEpic=null means no real
// previous epic to transition from).
function shouldHaltAtEpicTransition(hitlEveryEpic, lastEpic, currentEpic) {
  return hitlEveryEpic && lastEpic !== null && currentEpic !== lastEpic;
}

// buildHaltContext(reason, context, resumeToken, runDir, userOptions) → object
// Standard halt payload returned to the Workflow runtime at every halt site.
// Pure: object builder, no side effects. The wrapper caller (the actual
// halt site in the loop) still does the state.halts.push + writeState +
// appendJournal before returning this payload.
function buildHaltContext(reason, context, resumeToken, runDir, userOptions) {
  return {
    haltReason: reason,
    context: context || {},
    resumeToken,
    runDir,
    userOptions: userOptions || ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
  };
}

// findUnmetDeps(deps, depStatuses) → array of deps whose status is not 'done'.
// A dep is "met" when sprint-status reports it 'done'. Sprint-status is the
// ground truth across all runs (state.completed is this-run-only — cross-run
// deps would falsely fail if checked against state.completed alone). Pure:
// filter, no side effects.
function findUnmetDeps(deps, depStatuses) {
  return deps.filter(d => (depStatuses || {})[d] !== 'done');
}

// normalizeStateArrays(state) → state with every collection field guaranteed to be
// an array. Three sources can omit a field: state.json written by an older version,
// an agent-authored write, and a helper that rebuilt the object. A missing field is
// not a soft degradation — it is a TypeError on first use (state.skipped.push).
// Applied at each point where state is replaced, so the invariant lives in one place.
// Pure and self-contained so the test harness can extract it in isolation
// (test/pure.test.mjs) — do not hoist the list to a module const.
function normalizeStateArrays(state) {
  const fields = ['storyQueue', 'completed', 'blocked', 'skipped', 'awaitingOperator', 'halts'];
  const out = { ...state };
  for (const k of fields) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  return out;
}

// applyUserChoice(planResult, userChoice, confirmedDeps) → { planResult, halt }
// Pure transformation of a halted run's planResult based on the operator's
// userChoice. Returns the new planResult + whether to halt (abort_prd only).
// Pure: no I/O, no agent calls — just object manipulation.
function applyUserChoice(planResult, userChoice, confirmedDeps) {
  const newPlanResult = { ...planResult, inferred: [...(planResult.inferred || [])] };
  let halt = false;
  switch (userChoice) {
    case 'abort_prd':
      halt = true;
      break;
    case 'proceed_without_inference':
      newPlanResult.inferred = [];
      break;
    case 'confirm_deps':
      if (confirmedDeps) {
        if (Array.isArray(confirmedDeps)) {
          newPlanResult.inferred = confirmedDeps;
        } else if (typeof confirmedDeps === 'object') {
          newPlanResult.inferred = Object.entries(confirmedDeps).map(([story, deps]) => ({
            story,
            depends_on: Array.isArray(deps) ? deps : [],
          }));
        }
      }
      // else: keep newPlanResult.inferred as-is (already cloned)
      break;
    default:
      // Unknown userChoice: leave planResult unchanged (orchestrator logs WARNING + falls through).
      break;
  }
  return { planResult: newPlanResult, halt };
}

const args_ = args || {};
const storyKey = args_.storyKey || null;
const epicKey = args_.epicKey || null;
const prdKey = args_.prdKey || null;
// hitlEvery: optional periodic checkpoint. 0 = no limit (default = fully autonomous).
// Error halts (convergence_escalation, ci_hardfail, launch_failure, merge_conflict, merge_blocked) are INDEPENDENT of this — they always trigger.
const hitlEvery = args_.hitlEvery === undefined ? 0 : args_.hitlEvery;
const hitlFinalOnly = args_.hitlFinalOnly || false;
const inferDeps = args_.inferDeps !== false;  // default true
const noInfer = args_.noInfer || false;
const autoAcceptDeps = args_.autoAcceptDeps === true;  // run inference but skip the dep_inference_confirm halt
const retro = args_.retro || false;
// removeFromState(state, storyKey) → state
// Removes a storyKey from state.blocked and state.halts (matching h.story).
// Called when a story converges or is otherwise resolved — keeps state
// consistent with reality (a converged story shouldn't be in blocked).
// Pure: returns new state object.
function removeFromState(state, storyKey) {
  return {
    ...state,
    blocked: (state.blocked || []).filter(b => {
      const bStory = typeof b === 'string' ? b : (b && b.story);
      return bStory !== storyKey;
    }),
    halts: (state.halts || []).filter(h => h && h.story !== storyKey),
  };
}

// pickReHaltReason(halts) → string
// Returns the most recent halt reason from state.halts (last entry in array —
// halts are appended in chronological order). Falls back to 'dep_inference_confirm'
// if no halts (rare edge case — fresh run that somehow ended up in resume path).
// Pure: string selection, no side effects.
function pickReHaltReason(halts) {
  if (!Array.isArray(halts) || halts.length === 0) return 'dep_inference_confirm';
  return halts[halts.length - 1].reason || 'dep_inference_confirm';
}

// userOptionsForHaltReason(reason) → string[]
// Maps halt reason to its appropriate userOptions list. Most error halts
// (launch_failure, ci_hardfail, merge_blocked, merge_conflict, epic_boundary,
// final_complete) share the same 5-option list. dep_inference_confirm has
// a custom 3-option list. Pure: lookup, no side effects.
function userOptionsForHaltReason(reason) {
  const byReason = {
    dep_inference_confirm: ['confirm_deps', 'proceed_without_inference', 'abort_prd'],
    launch_failure:       ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    ci_hardfail:          ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    merge_blocked:        ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    merge_conflict:       ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    epic_boundary:        ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    final_complete:       ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'],
    // State could not be persisted — the run stopped rather than proceed on state
    // that is not on disk. 'continue' retries the write.
    state_write_failed:   ['continue', 'abort_prd'],
    // state.json held a story key the plan never produced (two identities for one
    // story). 'continue' re-runs the load + validation, so it only helps once the
    // operator has fixed the key on disk.
    state_key_rejected:   ['continue', 'abort_prd'],
  };
  return byReason[reason] || ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'];
}

// moveBlockedToSkipped(state) → state
// On userChoice='skip_blocked': move all blocked stories to state.skipped[] and
// clear state.blocked. Also drop matching halt entries (the halts that caused
// the blocks are now resolved — operator chose skip). Pure: returns new state.
function moveBlockedToSkipped(state) {
  const skipped = (state.blocked || []).map(b => {
    const bStory = typeof b === 'string' ? b : (b && b.story);
    const bReason = typeof b === 'string' ? null : (b && b.reason);
    return bStory ? { story: bStory, reason: bReason } : null;
  }).filter(Boolean);
  return {
    ...state,
    skipped: [...(state.skipped || []), ...skipped],
    blocked: [],
    halts: (state.halts || []).filter(h => !skipped.some(s => s.story === h.story)),
  };
}

// safeInferredForDeps(stateObj, fallback) → array
// Returns stateObj.inferred if defined, else fallback, else []. Defends
// against JSON.stringify dropping an undefined key (which would silently
// turn deps.json into '{}').
function safeInferredForDeps(stateObj, fallback) {
  if (stateObj && Array.isArray(stateObj.inferred)) return stateObj.inferred;
  if (fallback && Array.isArray(fallback)) return fallback;
  return [];
}

// isConverged(convergeResult) → boolean
// Returns true if the converge sub-workflow successfully merged the story —
// either via the normal converged flag OR via an explicit merge.merged=true
// when the build phase was skipped (branch already had commits ahead).
// Without this, the orchestrator blocks successful merges that bypass the
// convergence loop (e.g. when mr-create finds existing commits and merges
// directly). Pure: boolean derivation from result shape.
function isConverged(convergeResult) {
  if (!convergeResult) return false;
  if (convergeResult.converged === true) return true;
  if (convergeResult.merge && convergeResult.merge.merged === true) return true;
  return false;
}

// parseMaxRetries(rawValue) → integer
// Parses the args.maxRetries arg. Default 3. 0 = never retry. Negative or
// unparseable → fall back to default (defensive). Pure — no Workflow globals.
function parseMaxRetries(rawValue) {
  if (rawValue === undefined || rawValue === null) return 3;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

// maxRetries: number of times to re-queue each ci_hardfail halt before blocking (default 3, 0 = never retry).
const maxRetries = parseMaxRetries(args_.maxRetries);
// hitlEveryEpic: halt at every epic boundary (independent of retro — retro also halts at epic boundary, but invokes bmad-retrospective; this is halt-only).
const hitlEveryEpic = args_.hitlEveryEpic === true;
// convergeScriptPathArg: pre-resolved candidate path passed to the setup agent prompt (interpolated at dispatch — agents have no JS scope).
const convergeScriptPathArg = args_.buildConvergeScriptPath || '';
const resume = args_.resume || null;
const userChoice = args_.userChoice || null;
const confirmedDeps = args_.confirmedDeps || null;
const maxIterations = args_.maxIterations || 5;
const cleanup = args_.cleanup || false;
const timestamp = args_.timestamp || 'unknown';
// runDir + convergeScriptPath are derived AFTER Setup (so the discovery step
// can fail fast without leaving stale run-dir references in code).

// Schema `description` fields are NOT decorative: describeSchema() renders them
// into the agent prompt, so each prompt's field list is generated from the
// schema instead of being written by hand. Edit the schema, and the prompt
// follows. Guarded by test/pure.test.mjs.

const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    repoRoot: { type: 'string', description: 'git rev-parse --show-toplevel' },
    prdWorktreePath: { type: 'string', description: 'worktree whose branch matches feat/*/prd' },
    prdKey: { type: 'string', description: 'the <prdKey> segment of that branch' },
    baseBranch: { type: 'string', description: 'feat/<prdKey>/prd — passed to converge as its base' },
    prdBranch: { type: 'string', description: 'same value as baseBranch; the branch sprint-status is pushed to' },
    sprintStatusPath: { type: 'string', description: 'absolute path to sprint-status.yaml inside the PRD worktree' },
    issueTrackingConfig: { type: 'object', description: 'parsed _bmad/custom/issue-tracking.yaml, passed through to converge' },
    convergeScriptPath: { type: 'string', description: 'absolute path to bmad-build-converge.js, resolved as <skill_root_parent>/bmad-build-converge/scripts/bmad-build-converge.js' },
  },
  required: ['repoRoot', 'prdWorktreePath', 'prdKey', 'baseBranch', 'prdBranch', 'sprintStatusPath', 'issueTrackingConfig', 'convergeScriptPath'],
};

const DEP_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    story: { type: 'string', description: 'the story key' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'story keys this one must wait for' },
  },
  required: ['story', 'depends_on'],
};

const WRITE_STATE_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean', description: 'true only when BOTH state.json and deps.json verified non-zero' },
    path: { type: 'string', description: 'the state.json path that was written' },
  },
  required: ['written', 'path'],
};

// describeSchema(schema) → the prompt-ready field list for a JSON schema.
// Single source of truth for "what must this agent return": the prompt renders
// this instead of hand-writing a field list, so a schema change cannot drift
// away from its prompt. Duplicated in bmad-build-converge.js — Workflow-tool
// scripts cannot import each other (same reason base64Encode is duplicated).
function describeSchema(schema) {
  const required = schema.required || [];
  return Object.entries(schema.properties || {}).map(([name, prop]) => {
    let type = prop.type || 'any';
    if (type === 'array' && prop.items && prop.items.type) type = `array<${prop.items.type}>`;
    const optional = required.includes(name) ? '' : ' [optional]';
    const note = prop.description ? ` — ${prop.description}` : '';
    return `  ${name} (${type})${optional}${note}`;
  }).join('\n');
}

// ============================================================================
// PHASE 1: SETUP — discover repo, PRD worktree, config, project_key
// ============================================================================
phase('Setup')
log('Discovering repo + PRD worktree + config...')
const setup = await agent(
  `You are the setup agent for bmad-prd-orchestrate.

TIMESTAMP: ${timestamp}

STEPS:
1. Discover BARE repo (not the worktree):
   a. \`git rev-parse --git-dir\` returns the path to .git (e.g. '.git' from inside a worktree, or '/path/to/bare/.git' from the bare repo).
   b. The BARE repo root = parent of --git-dir. Use this script to derive it:
      \`GIT_DIR=$(git rev-parse --git-dir); if [ "$GIT_DIR" = ".git" ]; then REPO_ROOT=$(cd .. && pwd); else REPO_ROOT=$(dirname "$GIT_DIR"); fi; echo "$REPO_ROOT"\`
   c. SETUP.repoRoot = the bare repo root (NOT the worktree path). \`git rev-parse --show-toplevel\` is WRONG — it returns the worktree path, not the bare repo. The converge sub-workflow's scriptPath is computed as \`repoRoot + '/.claude/workflows/bmad-build-converge.js'\` — if repoRoot is the worktree, the file isn't there.
2. Find PRD worktree (worktree on a 'feat/*/prd' branch):
   a. Run \`git worktree list --porcelain\`
   b. Parse output: each entry starts with 'worktree <path>', followed by 'branch refs/heads/<name>'.
   c. Find the entry whose branch matches pattern 'refs/heads/feat/*/prd'. Extract prdKey (the * in feat/*/prd).
3. Read _bmad/custom/issue-tracking.yaml from prdWorktreePath. Required fields: git_platform, host, project, worktree_base, branch_patterns.prd, branch_patterns.story.
4. Resolve convergeScriptPath — the bmad-build-converge.js file MUST exist for Phase 3 dispatch to work.
   a. Prefer the candidate path below (set by the SKILL.md dispatcher at install time; ships together in the same module). Verify it exists with \`ls -1 <candidate> 2>/dev/null && echo EXISTS\`.
   b. If the candidate is empty or the path doesn't resolve, return convergeScriptPath="" so Phase 3 fails fast with a clear error instead of throwing mid-loop.
   c. Candidate path: \`${convergeScriptPathArg}\`
5. baseBranch = 'feat/<prdKey>/prd'. prdBranch = baseBranch.
6. sprintStatusPath = prdWorktreePath + '/_bmad-output/implementation-artifacts/sprint-status.yaml'.
7. Initialize run dir (THE RUN DIR IS THE ONLY PERMITTED WRITE LOCATION):
   a. Compute runDir = prdWorktreePath + '/_bmad-output/implementation-artifacts/orchestrate-runs/${timestamp}'
   b. mkdir -p <runDir>
   c. Write <runDir>/state.json with the JSON object below. Replace the placeholder <discovered-prd-key> with the actual prdKey from step 2c:
      { "runId": "${timestamp}", "ts": "${timestamp}", "prdKey": "<discovered-prd-key>", "storyQueue": [], "completed": [], "blocked": [], "skipped": [], "awaitingOperator": [], "halts": [] }
   d. Append to <runDir>/journal.jsonl: {"ts":"${timestamp}","event":"setup_complete","prdKey":"<discovered-prd-key>"}
8. Return JSON with EXACTLY these fields (do NOT go read the script to discover
   them — this list IS the contract; every phase below depends on it):
${describeSchema(SETUP_SCHEMA)}

CONSTRAINTS:
- DO NOT modify prdWorktreePath or any other tracked file outside the run dir.
- The run dir is the SOLE permitted write location.
- DO NOT modify any tracked file in prdWorktreePath or elsewhere in the repo.`,
  { label: `setup-${timestamp}`, phase: 'Setup', schema: SETUP_SCHEMA, agentType: 'general-purpose' }
)
if (!setup || !setup.prdWorktreePath) {
  return { aborted: true, stage: 'setup', error: 'setup agent failed' }
}

// Derive runDir from the setup agent's discovery output rather than hardcoding
// any specific PRD worktree path. The optional prdKey arg is only honored if
// it matches the discovered value (else we log a warning and use discovery).
const runDir = setup.prdWorktreePath + '/_bmad-output/implementation-artifacts/orchestrate-runs/' + timestamp;
// convergeScriptPath: the bmad-build-converge sub-workflow file. Setup agent
// verifies which path exists (worktree path first, bare-repo fallback) and
// returns the resolvable path. Empty string = both candidates missing — Phase 3
// fails fast with a clear log line instead of throwing inside workflow().
const convergeScriptPath = setup.convergeScriptPath || convergeScriptPathArg || '';
if (prdKey && prdKey !== setup.prdKey) {
  log(`WARNING: args.prdKey (${prdKey}) != discovered prdKey (${setup.prdKey}); using discovered value`)
} else if (prdKey) {
  log(`prdKey arg matches discovered: ${setup.prdKey}`)
}
log(`convergeScriptPath=${convergeScriptPath || '(NOT FOUND — Phase 3 will fail)'}`)

log(`Discovered: prdKey=${setup.prdKey}, prdBranch=${setup.prdBranch}`)
log(`runDir=${runDir} | convergeScriptPath=${convergeScriptPath}`)

// On resume, load the previously persisted inference graph BEFORE Phase 2 so
// the plan agent can compare its fresh inference against the prior one and
// surface any delta to the operator. Without this, every resume recomputes
// from scratch and silently overwrites the operator's earlier confirmation.
let previousInference = null;
if (resume) {
  const prevState = await agent(
    `Read ${runDir}/state.json and return its parsed JSON object.
If the file does not exist (first-run / wiped state), return { "missing": true }.
Use the Read tool, parse JSON, return the parsed object as-is.`,
    { label: `state-load-plan`, phase: 'Plan', schema: {
      type: 'object', additionalProperties: true,
    }, agentType: 'general-purpose' }
  );
  if (prevState && typeof prevState === 'object' && !prevState.missing && Array.isArray(prevState.inferred)) {
    previousInference = prevState.inferred;
    log(`Loaded previous inference graph (${previousInference.length} edges) for resume comparison`)
  }
}

// ============================================================================
// PHASE 2: PLAN — story queue + dep inference
// ============================================================================
phase('Plan')
log('Building story queue + inferring deps...')
const planResult = await agent(
  `You are the plan agent for bmad-prd-orchestrate.

SETUP: ${JSON.stringify(setup)}
RUN_DIR: ${runDir}
INFER_DEPS: ${inferDeps}, NO_INFER: ${noInfer}
EPIC_FILTER: ${epicKey || 'all'}, STORY_FILTER: ${storyKey || 'all'}
PREVIOUS_INFERENCE: ${previousInference ? JSON.stringify(previousInference) : 'null'}

STEPS:
1. Read ${setup.sprintStatusPath}.
2. Build numeric → canonical story key lookup:
   a. The sprint-status has TWO different ID forms:
      - epics[N].stories[] uses NUMERIC ids like "<epic-num>.<story-num>"
      - development_status keys are CANONICAL like "<epic-num>-<story-num><suffix>-..."
   b. Walk development_status keys; for each canonical key extract the leading "<epic-num>-<story-num>[a-z]?" prefix. A numeric id matches the canonical form by that prefix.
   c. The canonical key is the storyQueue / completed / blocked / etc. entry. The numeric id is only used to walk epics[N].stories[] in epic order.
3. Compute storyQueue:
   a. Iterate sprint-status.epics in order. For each epic:
      - Skip if epicFilter set and epic.id != epicFilter.
      - Epic dep check: if epic.depends_on contains epic IDs, that dep is satisfied ONLY when EVERY story in the dep epic has development_status[canonicalKey] === 'done'. DERIVE this — do NOT read epic.status (stays "backlog" forever even when all stories done).
      - If unsatisfied, mark epic as blocked (skip its stories, add to skipped[] with reason: 'epic_blocked').
      - Otherwise, iterate epic.stories (numeric ids) in order. For each numeric id:
        - Resolve canonical key via the lookup from step 2.
        - Skip if storyFilter set and canonical != storyFilter.
        - Read status from development_status[canonicalKey].
        - If status == 'done': add canonicalKey to completed[].
        - If status in ('backlog', 'in-progress', 'review', 'blocked', 'ready-for-dev'): add canonicalKey to storyQueue.
        - If status == 'awaiting-operator': add canonicalKey to awaitingOperator[] (skip in queue).
4. Seed intra-epic sequential dependencies BEFORE inference:
   For each epic that contributes stories to storyQueue:
     - Walk storyQueue entries from this epic in their epic-order (epics[N].stories[] order).
     - For each story at index > 0: seed inferred entry {story, depends_on: [previousStoryCanonical]}.
     - First story (index 0) seeds as {story, depends_on: []}.
   This default chain ensures stories execute in order unless overridden.
5. If inferDeps AND NOT noInfer:
   a. For each story in storyQueue, DISCOVER its spec — never build the filename from
      the key. bmad-build-auto chooses the name, and its slug comes from the story
      title, so it differs from the key (test_hello.py → test_hello-py). Paths are
      relative to <prdWorktreePath>; first hit wins:
${renderSpecPatterns()}
      Replace <storyId> with the story key's first two dash-separated segments
      (2-1-deferred-work-ledger-round-trip → 2-1). Two matches in one pattern →
      HALT with the candidates listed. No match → the story simply has no spec yet:
      skip its depends_on extraction, do NOT invent a path, do NOT fail the plan.
   b. Extract depends_on from spec frontmatter if present.
   c. If absent, scan spec body for story key mentions (regex: /\\b\\d+-\\d+[a-z]?\\b/g) and "depends on story X" phrasing.
   d. Apply overrides: for each story, merge frontmatter depends_on over the seed (override = union, seed entries stay if not overridden). Use CANONICAL keys throughout (both story and depends_on fields).
   e. PREVIOUS_INFERENCE comparison (only when PREVIOUS_INFERENCE is non-null):
      - Build a {story -> sorted depends_on} map from PREVIOUS_INFERENCE and from your fresh inference.
      - For each story present in BOTH maps where depends_on differs, list the story + old deps + new deps in a "delta" note in your reply text (not in the JSON schema).
      - If the user wants to keep the previous graph despite the delta, the orchestrator passes confirmedDeps on resume; your fresh inference is only used when no previous exists.
6. Write ${runDir}/deps.json with { "inferred": <graph> }.
7. Append to ${runDir}/journal.jsonl: {"ts":"${timestamp}","event":"plan_complete","storyQueueSize":<n>,"inferredEdges":<m>}
8. Return JSON matching the schema: { storyQueue, completed, blocked, skipped, awaitingOperator, inferred: [{story, depends_on}, ...] }

CONSTRAINTS:
- Read-only on sprint-status. Do NOT modify.
- Do NOT modify any spec file.
- All storyQueue / completed / blocked / skipped / awaitingOperator entries MUST be CANONICAL keys.
- inferred entries MUST use CANONICAL keys in BOTH story and depends_on fields.`,
  { label: `plan-${timestamp}`, phase: 'Plan', schema: {
    type: 'object',
    properties: {
      storyQueue: { type: 'array', items: { type: 'string' } },
      completed: { type: 'array', items: { type: 'string' } },
      blocked: { type: 'array', items: { type: 'string' } },
      skipped: { type: 'array', items: { type: 'string' } },
      awaitingOperator: { type: 'array', items: { type: 'string' } },
      inferred: { type: 'array', items: DEP_ENTRY_SCHEMA },
    },
    required: ['storyQueue', 'completed', 'blocked', 'skipped', 'awaitingOperator', 'inferred'],
  }, agentType: 'general-purpose' }
)
if (!planResult) {
  return { aborted: true, stage: 'plan', error: 'plan agent failed' }
}
log(`Queue: ${planResult.storyQueue.length} stories, ${planResult.inferred.length} inferred edges`)

// ============================================================================
// STATE PERSIST + RESUME HANDLING
// The persisted state.json is the single source of truth for resuming a
// halted run; the operator's userChoice on resume mutates that state before
// Phase 3 begins iteration.
// ============================================================================
// Plan-phase state writer: builds the post-Plan state object and delegates to
// the unified writeState (defined in Phase 3) for the coupled atomic write.
// Phase 3's writeState handles BOTH state.json and deps.json in lockstep.
const buildPlanState = () => ({
  runId: timestamp,
  ts: timestamp,
  prdKey: setup.prdKey,
  section: 'plan',  // differentiates Phase 2 (plan) vs Phase 3 (loop) writeState labels
  storyQueue: planResult.storyQueue,
  completed: planResult.completed,
  blocked: planResult.blocked,
  skipped: planResult.skipped,
  awaitingOperator: planResult.awaitingOperator,
  halts: [],
  inferred: planResult.inferred,
});

// Resume handling: when an operator resumes a halted run with a userChoice
// (e.g. confirm_deps, proceed_without_inference, abort_prd), apply that
// choice BEFORE the fresh-run halt block below so a resumed run never
// re-prompts the dep-inference confirmation that was already given.
if (userChoice) {
  // Use pure helper to apply the operator's userChoice (test/pure.test.mjs).
  // `halt` from the helper is the single source of truth for whether this
  // resume ends the run (currently only abort_prd halts, but new halting
  // userChoices can extend the helper's switch without touching this wrapper).
  const { planResult: newPR, halt } = applyUserChoice(planResult, userChoice, confirmedDeps);
  planResult.inferred = newPR.inferred;
  if (halt) {
    log(`Halting per userChoice=${userChoice}`);
    return { aborted: true, haltReason: 'aborted', timestamp, runDir };
  }
  if (userChoice === 'confirm_deps') {
    log(confirmedDeps
      ? `Resuming with confirm_deps (+ edited confirmedDeps entries: ${Array.isArray(confirmedDeps) ? confirmedDeps.length : Object.keys(confirmedDeps).length})`
      : `Resuming with confirm_deps (using inferred graph as-is, entries: ${planResult.inferred?.length || 0})`);
    if (confirmedDeps) log(`Updated inferred to ${planResult.inferred.length} confirmed entries`);
    const wsHalt = await persistOrHalt(buildPlanState());
    if (wsHalt) return wsHalt;
  } else if (userChoice === 'proceed_without_inference') {
    log(`Resuming with proceed_without_inference (clearing inferred graph)`);
    const wsHalt = await persistOrHalt(buildPlanState());
    if (wsHalt) return wsHalt;
  } else {
    log(`WARNING: unrecognized userChoice=${userChoice}; falling through to Phase 3`);
    const wsHalt = await persistOrHalt(buildPlanState());
    if (wsHalt) return wsHalt;
  }
} else if (resume) {
  // Resume token without userChoice → re-halt with the LATEST halt from
  // state.halts (not always dep_inference_confirm — the previous behavior
  // re-halted dep_inference_confirm even when a launch_failure / ci_hardfail
  // was the actual pending halt, leaving the operator no way to recover
  // via skip_blocked / fix_then_resume). Pick the most recent halt entry
  // (last in array — halts are appended in order); fall back to
  // dep_inference_confirm if state.halts is empty (rare edge case).
  log(`Resume token provided but no userChoice; re-halting`)
  await persistState(buildPlanState())
  const reHaltReason = pickReHaltReason(state.halts);
  const userOptions = userOptionsForHaltReason(reHaltReason);
  const latestHalt = (state.halts && state.halts.length > 0) ? state.halts[state.halts.length - 1] : null;
  return buildHaltContext(
    reHaltReason,
    { latestHalt, previousHalts: state.halts, inferred: planResult.inferred, storyQueue: planResult.storyQueue },
    timestamp, runDir, userOptions
  );
} else if (inferDeps && !noInfer && !autoAcceptDeps && planResult.inferred.length > 0) {
  // First-run halt to confirm inferred graph
  log('Halting to confirm inferred dependency graph...')
  await persistState(buildPlanState())
  return buildHaltContext(
    'dep_inference_confirm',
    { inferred: planResult.inferred, storyQueue: planResult.storyQueue },
    timestamp, runDir, ['confirm_deps', 'proceed_without_inference', 'abort_prd']
  )
} else {
  // No inferred deps — persist and fall through to Phase 3
  log('No inferred deps — persisting state and falling through to Phase 3')
  const wsHalt = await persistOrHalt(buildPlanState());
  if (wsHalt) return wsHalt;
}

// DEBUG: diagnostic — was Phase 3 supposed to start here?
log(`PHASE 3 GATE: userChoice=${JSON.stringify(userChoice)} resume=${JSON.stringify(resume)} inferDeps=${inferDeps} noInfer=${noInfer} autoAcceptDeps=${autoAcceptDeps} inferred.length=${planResult.inferred?.length || 0}`)

// ============================================================================
// PHASE 3: EXECUTE — per-story loop with dep-check + converge dispatch
// ============================================================================
try {
  phase('Execute')
} catch (e) {
  log(`PHASE 3 GATE FAILED at phase('Execute'): ${e}`)
  throw e
}
log('Starting execute loop...')

// State init (snapshot of planResult; will be overwritten by loadState on resume)
let state = {
  runId: timestamp,
  ts: timestamp,
  prdKey: setup.prdKey,
  storyQueue: planResult.storyQueue,
  completed: planResult.completed,
  blocked: planResult.blocked,
  skipped: planResult.skipped,
  awaitingOperator: planResult.awaitingOperator,
  halts: [],
  iterationCount: 0,
  inferred: planResult.inferred,  // keep graph available across resumes
}

// State persistence helpers (Phase 3 owns these; Task 2 inlined a parallel helper for plan-time).
// Declared as function declarations so they hoist — Phase 2 already calls writeState
// before this source position executes (TDZ on `const` would otherwise throw).
// persistState(stateObj) → boolean
// writeState + verification. writeState returns the agent's {written, path}, and
// every call site used to discard it: a failed write was completely silent — no
// log, no journal, no halt — while the run carried on with state on disk that no
// longer matched reality. A live run was observed 33 minutes and three stories
// behind its own journal for exactly this reason.
//
// Retries once (the write goes through an LLM agent, so a single transient
// failure is plausible), then journals state_write_failed and returns false.
// Deliberately does NOT halt: sprint-status is the planning ground truth, so a
// stale state file costs a redundant re-dispatch, not correctness — while halting
// on a flaky agent would stop the whole PRD.
async function persistState(stateObj) {
  let res = await writeState(stateObj);
  if (res && res.written === true) return true;
  log(`State persist returned ${JSON.stringify(res)} — retrying once`)
  res = await writeState(stateObj);
  if (res && res.written === true) return true;
  log(`WARNING: state persist failed twice (${JSON.stringify(res)}) — resume state is stale`)
  await appendJournal({ event: 'state_write_failed', result: res || null });
  return false;
}

// persistOrHalt(stateObj) → halt context | null
// Persist state, and when the write cannot be made durable, STOP: return a halt
// context instead of letting the run continue on in-memory state that is not on
// disk. Continuing is how a resume ends up re-running stories that already
// converged or already blocked.
//
// Call sites read:  const h = persistOrHaltOrNull(state); if (h) return h;
//   (the real call is this function awaited — written as a plain call above so the
//   call-site count guard in test/pure.test.mjs does not count this comment as one)
// Sites that are about to halt anyway (they return buildHaltContext on the very
// next line) keep plain persistState — the run is stopping regardless, and the
// halt context is returned from memory.
async function persistOrHalt(stateObj) {
  if (await persistState(stateObj)) return null;
  return buildHaltContext('state_write_failed', {
    completed: stateObj.completed,
    blocked: stateObj.blocked,
    skipped: stateObj.skipped,
    awaitingOperator: stateObj.awaitingOperator,
    halts: stateObj.halts,
  }, timestamp, runDir, ['continue', 'abort_prd']);
}

async function writeState(stateObj) {
  // Write state.json + deps.json atomically via base64-encoded echo + decode.
  // Base64 eliminates quoting hazards (state may contain single quotes, backticks,
  // dollar signs). Atomic via .tmp + mv. The agent's bash task is a simple
  // pipe-decode-redirect — minimal surface for the LLM to rewrite incorrectly.
  // (Previously the bash command heredoc'd raw JSON, and the LLM rewrote it
  // into `echo ... > /tmp/bmad-orch-output.txt` — wrong path, no writeState effect.)
  writeStateCallSeq++;
  // base64Encode (pure helper, test/pure.test.mjs) — NOT Buffer.from: Workflow
  // runtime has no `Buffer` global (no Node Buffer available). The pure helper
  // is the canonical implementation. Same encoding, runtime-safe.
  // Defense: ensure state.inferred is always present. If undefined (e.g. an
  // older disk state missing the field, or a caller that didn't pass it),
  // JSON.stringify would silently drop the key → deps.json becomes "{}".
  const inferredForDeps = safeInferredForDeps(stateObj, planResult.inferred);
  const stateB64 = base64Encode(JSON.stringify(stateObj));
  const depsB64 = base64Encode(JSON.stringify({ inferred: inferredForDeps }));
  const tmpState = `/tmp/bmad-orch-state-${writeStateCallSeq}.json`;
  const tmpDeps = `/tmp/bmad-orch-deps-${writeStateCallSeq}.json`;
  // Bash command writes state.json + deps.json atomically (.tmp + mv), then
  // verifies the writes succeeded by cat-ing the files. The verification
  // output prevents the LLM from hallucinating "written:false" when the
  // files are actually written successfully (a previous false-negative bug
  // where the agent reported `{"written":false,"path":"...tmp"}` despite
  // the files existing on disk — caused the orchestrator to lose track of
  // resume state). The cat outputs confirm file presence + content size;
  // agent returns based on those.
  const bashCmd = `mkdir -p '${runDir}' && echo '${stateB64}' | base64 -d > '${tmpState}.tmp' && mv '${tmpState}.tmp' '${runDir}/state.json' && echo '${depsB64}' | base64 -d > '${tmpDeps}.tmp' && mv '${tmpDeps}.tmp' '${runDir}/deps.json' && echo "VERIFY_STATE_BYTES=$(wc -c < '${runDir}/state.json')" && echo "VERIFY_DEPS_BYTES=$(wc -c < '${runDir}/deps.json')" && echo "VERIFY_STATE_HEAD=$(head -c 80 '${runDir}/state.json')"`;
  return await agent(
    `Run this exact bash command. Return its stdout verbatim. Do NOT modify, summarize, or diagnose.

CRITICAL: After running, examine the VERIFY_STATE_BYTES and VERIFY_DEPS_BYTES output lines.
- If VERIFY_STATE_BYTES is greater than 0 AND VERIFY_DEPS_BYTES is greater than 0 → return {"written": true, "path": "${runDir}/state.json"}.
- If either is 0 or missing → return {"written": false, "path": "${runDir}/state.json"} and the verify output.

DO NOT default to written:false when verify output shows non-zero bytes — the previous version of this prompt routinely hallucinated written:false despite successful writes.

Return JSON with EXACTLY these fields (path is always "${runDir}/state.json"):
${describeSchema(WRITE_STATE_SCHEMA)}

COMMAND:
${bashCmd}`,
    { label: `state-write-${stateObj.section || 'loop'}-${stateObj.iterationCount || 0}`, phase: 'Execute', schema: WRITE_STATE_SCHEMA, agentType: 'general-purpose' }
  );
}

async function appendJournal(event) {
  const entry = { ts: timestamp, ...event };
  return await agent(
    `Append one JSONL line to ${runDir}/journal.jsonl.

LINE TO APPEND (single line, no trailing newline added):
${JSON.stringify(entry)}

STEPS:
1. Use bash: \`echo '${JSON.stringify(entry)}' >> ${runDir}/journal.jsonl\`
   (single-quoted echo is safe because the JSON string itself does not contain single quotes — agent must verify).
2. Return JSON: { "appended": true }`,
    { label: `journal-${event.event || 'unknown'}`, phase: 'Execute', schema: {
      type: 'object', properties: { appended: { type: 'boolean' } }, required: ['appended'],
    }, agentType: 'general-purpose' }
  );
}

async function loadState() {
  return await agent(
    `Read ${runDir}/state.json and return its parsed JSON object.

If the file does not exist (first-run / wiped state), return { "missing": true }.

STEPS:
1. Read ${runDir}/state.json with the Read tool.
2. Parse JSON.
3. Return the parsed object as-is.`,
    { label: `state-load`, phase: 'Execute', schema: {
      type: 'object', additionalProperties: true,
    }, agentType: 'general-purpose' }
  );
}

// Cross-run CI retry helper (maxRetries semantics: integer, default 3).
// Re-queues stories whose previous attempt halted with reason='ci_hardfail'.
// Each halt entry tracks h.retries (count of past re-queues); skip if already
// at or above maxRetries. Stories already in the queue or completed are skipped
// to avoid double-dispatch.
//
// Pure: takes state + maxRetries as inputs, returns { state, count }. No
// references to closure-scoped state — unit-testable via test/pure.test.mjs.
function requeueCIHardfails(state, maxRetries) {
  if (maxRetries <= 0) return { state, count: 0 };
  // ...state is LOAD-BEARING, not tidiness. This used to rebuild the object with
  // only storyQueue/completed/blocked/halts, and the caller assigns the result back
  // to the live state — so skipped, awaitingOperator, inferred, iterationCount,
  // prdKey and ts were silently dropped on every resume, and the next
  // `state.skipped.push(...)` died with "undefined is not an object".
  const newState = {
    ...state,
    storyQueue: [...state.storyQueue],
    completed: state.completed,
    blocked: state.blocked,
    halts: state.halts ? state.halts.map(h => ({ ...h })) : [],
  };
  const queueSet = new Set(newState.storyQueue);
  const completedSet = new Set(newState.completed);
  const seen = new Set(); // de-dupe across multiple halt entries for the same story
  let count = 0;
  for (const h of newState.halts) {
    if (!h || h.reason !== 'ci_hardfail' || !h.story) continue;
    const retriesSoFar = h.retries || 0;
    if (retriesSoFar >= maxRetries) continue;
    if (seen.has(h.story)) continue;
    if (queueSet.has(h.story) || completedSet.has(h.story)) continue;
    newState.storyQueue.unshift(h.story);
    queueSet.add(h.story);
    seen.add(h.story);
    h.retries = retriesSoFar + 1;
    count++;
  }
  if (count > 0) {
    // Drop these stories from state.blocked so retry_blocked doesn't re-add them too
    newState.blocked = newState.blocked.filter(b => !seen.has(typeof b === 'string' ? b : (b && b.story) || null));
  }
  return { state: newState, count };
}

// Thin wrapper for orchestrator callers — applies the re-queue to the live
// state and logs. Not unit-tested (closure over Workflow globals).
const applyRequeueCIHardfails = () => {
  const { state: newState, count } = requeueCIHardfails(state, maxRetries);
  state = newState;
  if (count > 0) {
    log(`maxRetries=${maxRetries}: re-queued ${count} ci_hardfail stor(y/ies) at front of queue`)
  }
  return count;
};

// Resume handling — load persisted state if resume token present.
// IMPORTANT: loadState is only useful when Phase 3 halted mid-loop (so
// completed/blocked/skipped/iterationCount carry over). For the
// dep_inference_confirm → confirm_deps resume path, the state.json has
// the post-Plan-2 snapshot which is identical to the freshly-built local
// state. Skipping the load there avoids the spread-merge overwriting
// array fields with undefined / stale values (the bug that crashed run 1).
const isResumingFromInferConfirm = (resume && userChoice === 'confirm_deps' && Array.isArray(confirmedDeps) && confirmedDeps.length > 0)
if (resume) {
  if (!isResumingFromInferConfirm) {
    const loaded = await loadState();
    if (loaded && typeof loaded === 'object' && !loaded.missing) {
      state = { ...state, ...loaded };
      // Defensive: ensure all collection fields stay arrays (disk state may be missing fields)
      state = normalizeStateArrays(state);
      // Validate every key that came back from disk against the keys the plan
      // produced from sprint-status.yaml. An unknown key means the SAME story has
      // two identities — a title-derived slug instead of the sprint key — and
      // dispatching it would run a story nothing else recognises. Halt loudly:
      // verified live, state.json carried `test_hello.py-…` while sprint-status,
      // deps.json and the journal all carried `test_hello-py-…`.
      //
      // SKIPPED when the run is scoped (--epic / --story): the plan then covers a
      // SUBSET by design (see the plan prompt's EPIC_FILTER/STORY_FILTER), so "not in
      // the plan" carries no signal and every out-of-scope key on disk would look
      // unknown — turning a legitimate filtered resume into a halt.
      if (!epicKey && !storyKey) {
        const knownKeys = [
          ...(planResult.storyQueue || []), ...(planResult.completed || []),
          ...(planResult.blocked || []), ...(planResult.skipped || []),
          ...(planResult.awaitingOperator || []),
          ...((planResult.inferred || []).map(e => e && e.story).filter(Boolean)),
        ];
        // storyKeysOf unwraps the {story, reason} entries held by blocked/skipped —
        // see its comment; comparing those objects raw would always read as unknown.
        const loadedKeys = [
          ...storyKeysOf(state.storyQueue), ...storyKeysOf(state.completed),
          ...storyKeysOf(state.blocked), ...storyKeysOf(state.skipped),
          ...storyKeysOf(state.awaitingOperator),
        ];
        const unknownKeys = findUnknownStoryKeys(loadedKeys, knownKeys);
        if (unknownKeys.length > 0) {
          log(`HALT: state.json holds ${unknownKeys.length} story key(s) the plan never produced: ${unknownKeys.join(', ')}`)
          await appendJournal({ event: 'state_key_rejected', unknown: unknownKeys, knownCount: knownKeys.length });
          return buildHaltContext('state_key_rejected', {
            unknownKeys,
            knownKeysSample: knownKeys.slice(0, 20),
            hint: 'An unknown key means one story has two identities — usually a title-derived slug (spec-*.md naming) where sprint-status.yaml has the canonical key. Diff state.json against sprint-status.yaml, fix the key, then resume.',
          }, timestamp, runDir, ['continue', 'abort_prd']);
        }
      }
      log(`Resumed from ${resume}: queueSize=${state.storyQueue.length} completed=${state.completed.length} blocked=${state.blocked.length} iterationCount=${state.iterationCount}`)
    } else {
      log(`WARNING: resume=${resume} but loadState returned no usable data; proceeding with fresh state`)
    }
  } else {
    log(`Resume from dep_inference_confirm — skipping loadState (state is fresh from Plan agent)`)
  }

  // Auto-requeue CI hard-fail halts per retryPolicy, BEFORE userChoice processing
  // so the operator's userChoice can still override (e.g. abort_prd still wins).
  applyRequeueCIHardfails();
  // Belt and braces: the requeue REPLACES state, so re-assert the array invariant
  // after it. This is the exact line that undid the normalization above and crashed
  // a live run with "undefined is not an object (evaluating 'state.skipped.push')".
  state = normalizeStateArrays(state);

  // Apply userChoice (periodic HITL options)
  if (userChoice === 'continue') {
    // no-op: keep storyQueue as-is
  } else if (userChoice === 'retry_blocked') {
    // Re-add blocked stories to front of queue
    const blockedStories = state.blocked
      .map(b => typeof b === 'string' ? b : (b && b.story) ? b.story : null)
      .filter(Boolean);
    state.storyQueue = [...blockedStories, ...state.storyQueue];
    state.blocked = [];
    log(`retry_blocked: re-queued ${blockedStories.length} blocked stories at front of queue`)
  } else if (userChoice === 'skip_blocked') {
    // Move blocked stories to skipped[] (operator chose to skip, not retry).
    // Without this, blocked[] stays populated even after the PRD completes,
    // and the final state is inconsistent with reality.
    state = moveBlockedToSkipped(state);
    log(`skip_blocked: moved ${(state.skipped || []).length} blocked stories to skipped[]`)
  } else if (userChoice === 'abort_prd') {
    log('User aborted PRD; returning final report')
    await persistState(state);
    await appendJournal({ event: 'abort_prd', queueSize: state.storyQueue.length });
    return { haltReason: 'final_complete', aborted: true, context: state, runDir };
  } else if (userChoice === 'fix_then_resume') {
    // After a ci_hardfail / merge_blocked halt, the story sits at 'in-progress'
    // (set by converge setup on the story branch). User has pushed fix commits
    // to the story branch externally. We must transition the status back to
    // 'ready-for-dev' before the next converge dispatch — converge setup
    // halts on any status other than ready-for-dev or review. The status
    // transition is THIS handler's responsibility; no other code path does it.
    const blockedStories = state.blocked
      .map(b => typeof b === 'string' ? b : (b && b.story) ? b.story : null)
      .filter(Boolean);
    log(`fix_then_resume: resetting ${blockedStories.length} blocked story status(es) → ready-for-dev...`)
    const resetResult = await agent(
      `You are the fix_then_resume status-reset agent for bmad-prd-orchestrate.

PRD_WORKTREE_PATH: ${setup.prdWorktreePath}
SPRINT_STATUS_PATH: ${setup.sprintStatusPath}
BLOCKED_STORIES: ${JSON.stringify(blockedStories)}
TIMESTAMP: ${timestamp}

GOAL: Transition each blocked story's sprint-status from 'in-progress' back to
'ready-for-dev' so the next converge dispatch passes its setup gate (which
requires ready-for-dev or review). Operator has already pushed fix commits to
the story branch(es) externally — DO NOT touch any story branch.

STEPS:
1. cd ${setup.prdWorktreePath}
2. Read ${setup.sprintStatusPath}.
3. For each story in BLOCKED_STORIES:
   - Skip if development_status[<story>] is already 'ready-for-dev' or 'done'
     (idempotent — defensive against concurrent external writes).
   - Otherwise set development_status[<story>] = 'ready-for-dev'.
   - If status was anything OTHER than 'in-progress', log a WARNING in the
     journal (unexpected state — operator should know).
4. Update last_updated to "${timestamp}".
5. git add _bmad-output/implementation-artifacts/sprint-status.yaml
6. git commit -m "chore(sprint-status): fix_then_resume — reset <N> blocked stories to ready-for-dev"
7. Capture the commit SHA: \`git rev-parse HEAD\` → commitSha (used by orchestrator for SHA-based verify).
8. git push origin ${setup.prdBranch}
9. Append to ${runDir}/journal.jsonl: {"ts":"${timestamp}","event":"fix_then_resume_reset","stories":<list>,"commitSha":"<sha>","pushed":<bool>}
10. Return JSON: { reset: [<story>], skipped: [<story>], warnings: [<story>], commitSha: <sha>, committed: <bool>, pushed: <bool>, error? }`,
      { label: `fix-then-resume-reset-${timestamp}`, phase: 'Execute', schema: {
        type: 'object',
        properties: {
          reset: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          commitSha: { type: 'string' },
          committed: { type: 'boolean' },
          pushed: { type: 'boolean' },
          error: { type: 'string' },
        },
        required: ['reset', 'commitSha', 'committed', 'pushed'],
      }, agentType: 'general-purpose' }
    );

    // HALT on push failure — silent push failure leaves stale 'in-progress'
    // status, next converge dispatch halts again, operator wastes a resume
    // cycle. Better to surface the failure explicitly with a resume token.
    if (!resetResult.pushed) {
      log(`fix_then_resume push FAILED: ${resetResult.error || 'unknown'}; halting for operator review`)
      state.halts.push({ reason: 'fix_then_resume_push_failed', iteration: state.iterationCount, details: resetResult.error || null });
      await persistState(state);
      await appendJournal({ event: 'halt_fix_then_resume_push', error: resetResult.error || 'unknown' });
      return buildHaltContext('fix_then_resume_push_failed', { resetResult, completed: state.completed, blocked: state.blocked, runDir }, timestamp, runDir, ['continue', 'retry_blocked', 'abort_prd']);
    }

    // SHA-VERIFY: confirm remote prd branch tip matches the commit the reset
    // agent claims it pushed. Cheap (~200ms) — single Bash dispatch vs the
    // previous 5-15s Read agent. Catches: model hallucination on pushed:true,
    // push raced with concurrent write, file system corruption.
    const shaVerify = await agent(
      `Run this exact bash command and return its stdout verbatim:

git -C ${setup.prdWorktreePath} ls-remote origin ${setup.prdBranch} | awk '{print $1}'

Return JSON: { remoteSha: <exact stdout string>, exitCode: <integer> }. Do NOT modify, summarize, or diagnose.`,
      { label: `fix-then-resume-sha-verify-${timestamp}`, phase: 'Execute', schema: {
        type: 'object',
        properties: {
          remoteSha: { type: 'string' },
          exitCode: { type: 'integer' },
        },
        required: ['remoteSha', 'exitCode'],
      }, agentType: 'general-purpose' }
    );
    if (shaVerify.exitCode !== 0 || shaVerify.remoteSha !== resetResult.commitSha) {
      log(`fix_then_resume SHA VERIFY FAILED: local commitSha=${resetResult.commitSha} remote=${shaVerify.remoteSha} exitCode=${shaVerify.exitCode}; halting`)
      state.halts.push({ reason: 'fix_then_resume_sha_verify_failed', iteration: state.iterationCount, details: { localSha: resetResult.commitSha, remoteSha: shaVerify.remoteSha, exitCode: shaVerify.exitCode } });
      await persistState(state);
      await appendJournal({ event: 'halt_fix_then_resume_sha_verify', localSha: resetResult.commitSha, remoteSha: shaVerify.remoteSha });
      return buildHaltContext('fix_then_resume_sha_verify_failed', { resetResult, shaVerify, runDir }, timestamp, runDir, ['continue', 'retry_blocked', 'abort_prd']);
    }
    log(`fix_then_resume: ${resetResult.reset.length} story(ies) reset, remote SHA ${shaVerify.remoteSha.substring(0, 7)} verified`)
  } else {
    log(`Unknown userChoice=${userChoice}; defaulting to continue`)
  }
  await appendJournal({ event: 'resume', userChoice, queueSize: state.storyQueue.length });
}

// Persist loop state before starting iteration (resume safety)
{
  const wsHalt = await persistOrHalt(state);
  if (wsHalt) return wsHalt;
}

// Per-story loop
let lastEpic = null;
// Stories whose issue label bmad-build-converge confirmed as synced (done +
// closed) during THIS process. Anything completed but absent here gets a
// second, idempotent sync attempt from Phase 4 — converge is the primary
// writer, this is only the safety net for a soft-fail (Skill unavailable) or
// for stories already 'done' before this run ever dispatched them.
const syncedThisRun = [];
while (state.storyQueue.length > 0) {
  const sk = state.storyQueue[0];
  state.iterationCount++;

  // Epic-boundary HITL: detect transition from previous story's epic.
  // Canonical story key format per upstream bmad-issue-tracking `bmad-workflow-lang.md:451-452`:
  //   `<epicNum>-<storyNum>[-<suffix>]` (e.g. `1-3-login-form`, optional letter suffix `4-1-a` per local spec L186).
  // Epic = first dash-separated segment. storyQueue is in epic-order (L197-198), so
  // consecutive stories only share an epic when they belong to the same epic. First story sets the baseline (no halt).
  const currentEpic = extractEpicKey(sk);
  if (isEpicTransition(lastEpic, currentEpic)) {
    log(`Epic transition: ${lastEpic || '(start)'} → ${currentEpic} — marking epic as in-progress via bmad-issue-tracking-sync`)
    // Mark the new epic as in-progress on the issue tracker. First iteration
    // (lastEpic=null) marks the very first epic; subsequent transitions mark each
    // subsequent epic. Soft-fail: if the issue isn't found, log and continue
    // (don't block the build over missing tracker sync).
    let epicStatusError = null;
    try {
      await agent(
        `Mark the epic "${currentEpic}" as in-progress for PRD "${setup.prdKey}" via the Skill.

Invoke the Skill with these env vars (one shot, no other actions):
   BMAD_ISSUE_ACTION=set-status \\
   BMAD_ISSUE_KEY="epic-${currentEpic}" \\
   BMAD_ISSUE_PRD_KEY="${setup.prdKey}" \\
   BMAD_ISSUE_NEW_STATUS="in-progress" \\
   BMAD_ISSUE_CLOSE=false \\
       Skill: bmad-issue-tracking-sync

BMAD_ISSUE_KEY must be the canonical epic sprint key "epic-<N>" — never the bare
number. find-issue does a substring search scoped only by the PRD label, so a
bare "1" matches every story issue of the epic and the first hit would be
updated instead of the epic issue. The epic issue body carries the sprint key
"Sprint Key: epic-<N>", which makes "epic-<N>" an unambiguous search text.
CLOSE=false maps to REOPEN in update-issue-status — intentional here (the epic
issue must be open while its stories are being built).

Capture { issue_id } from stdout. If the Skill reports the issue was not found, set issue_id=null and return normally (do not halt). Soft-fail by design — a missing epic issue must not block the build.`,
        // One shot, no other actions (see the prompt). No Bash here, so unlike
        // the git-backed agents this restriction actually holds: the agent
        // cannot touch the repo or spawn anything.
        { label: `epic-status-${currentEpic}`, phase: 'Execute', schema: { type: 'object', properties: { issue_id: { type: 'string' } } }, agentType: 'general-purpose', allowedTools: ['Skill'] }
      );
    } catch (e) {
      epicStatusError = String(e);
      log(`Epic status sync failed for ${currentEpic}: ${epicStatusError} — continuing build (soft-fail)`);
    }
    // Always journal — operators reviewing a halted run via journal.jsonl
    // need a signal that the issue tracker was attempted, regardless of outcome.
    await appendJournal({ event: epicStatusError ? 'epic_in_progress_failed' : 'epic_in_progress', epic: currentEpic, iteration: state.iterationCount, error: epicStatusError || undefined });
  }
  if (shouldHaltAtEpicTransition(hitlEveryEpic, lastEpic, currentEpic)) {
    log(`Epic-boundary HITL: ${lastEpic} → ${currentEpic} at iteration ${state.iterationCount}`)
    state.halts.push({ reason: 'epic_boundary', iteration: state.iterationCount, details: { from: lastEpic, to: currentEpic } });
    await persistState(state);
    await appendJournal({ event: 'halt_epic_boundary', iteration: state.iterationCount, from: lastEpic, to: currentEpic });
    return buildHaltContext(
      'epic_boundary',
      { from: lastEpic, to: currentEpic, completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator },
      timestamp, runDir
    );
  }
  lastEpic = currentEpic;

  log(`--- Iteration ${state.iterationCount}: story ${sk} (queue remaining: ${state.storyQueue.length}) ---`)

  // Read current sprint-status (status may have moved between plan and now)
  // Grouped sprint-status read: bash helper returns BOTH current story status
  // AND every dep status in one call. Replaces the previous 2 separate
  // general-purpose agents (read-status + dep-check) — saves a system prompt
  // per loop iter. The helper does the YAML grep, agent is transport.
  const inferredEdge = planResult.inferred.find(e => e.story === sk);
  const deps = inferredEdge ? inferredEdge.depends_on : [];
  const bashReadCmd = `"${args_.helpersDir || ''}orchestrate-helper.sh" all-read '${setup.sprintStatusPath}' '${sk}' '${deps.join(',')}'`;
  const allRead = await agent(
    `Run this exact bash command. Return its stdout verbatim. Do NOT modify, summarize, or diagnose.

COMMAND:
${bashReadCmd}`,
    { label: `all-read-${sk}`, phase: 'Execute', schema: {
      type: 'object',
      properties: {
        currentStatus: { type: 'string' },
        depStatuses: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['currentStatus', 'depStatuses'],
    }, agentType: 'general-purpose' }
  );
  const currentStatus = allRead.currentStatus;
  const depStatusCheck = { statuses: allRead.depStatuses };

  // awaiting-operator parking (do NOT execute — park in awaitingOperator[], continue)
  if (currentStatus === 'awaiting-operator') {
    log(`Story ${sk} in awaiting-operator; parking (not executing)`)
    state.awaitingOperator.push(sk);
    state.storyQueue.shift();
    const parkHalt = await persistOrHalt(state);
    if (parkHalt) return parkHalt;
    continue;
  }

  // already done: skip re-execution (defensive — covers races with external status writes)
  if (currentStatus === 'done') {
    log(`Story ${sk} already done per sprint-status; marking completed`)
    state.completed.push(sk);
    state = removeFromState(state, sk);
    state.storyQueue.shift();
    const doneHalt = await persistOrHalt(state);
    if (doneHalt) return doneHalt;
    continue;
  }

  // Dep check: a dep is "met" when sprint-status reports it 'done'. Local
  // state.completed only tracks THIS run's completions — cross-run deps
  // (story completed in a previous orchestrate session) would falsely fail
  // if checked against state.completed alone. Sprint-status is the ground
  // truth for the entire PRD across all runs.
  const unmetDeps = findUnmetDeps(deps, depStatusCheck.statuses);
  if (unmetDeps.length > 0) {
    log(`Story ${sk} has unmet deps: ${unmetDeps.join(', ')}; skipping`)
    state.skipped.push({ story: sk, reason: 'unmet_deps', deps: unmetDeps });
    state.storyQueue.shift();
    await appendJournal({ event: 'skip', storyKey: sk, reason: 'unmet_deps', deps: unmetDeps });
    const skipHalt = await persistOrHalt(state);
    if (skipHalt) return skipHalt;
    continue;
  }

  // Dispatch bmad-build-converge sub-workflow (1 level nesting)
  log(`Dispatching bmad-build-converge for ${sk}...`)
  await appendJournal({ event: 'dispatch', storyKey: sk, iteration: state.iterationCount });
  let convergeResult = null;
  let launchError = null;
  try {
    // workflow(nameOrRef, args?) is a 2-arg call: first is the name/scriptPath ref,
    // second is the args object. Lowercase `workflow` is the runtime-injected
    // sub-workflow dispatcher (`Workflow` capital-W is the main-conversation tool
    // and throws ReferenceError here). It returns whatever the sub-workflow
    // script returns — which REQUIRES the sub-workflow to end with a top-level
    // `return await main();` (a bare `await main();` discards the value → this
    // call yields undefined → false launch_failure below).
    convergeResult = await workflow({ scriptPath: convergeScriptPath }, {
      storyKey: sk,
      maxIterations,
      timestamp: timestamp + '-' + sk,
      helpersDir: args_.helpersDir || '',  // forward so sub-workflow's CI check can find ci-monitor.sh
      // orchestrated: tells the sub-workflow that Phase 4 owns the sprint-status
      // done transition, so it must not push that file itself. Pushing it made
      // every closely-spaced merge rebase against a moving shared branch.
      orchestrated: true,
      // scriptPath: lets the sub-workflow's setup agent stamp the running revision
      // into the run log (convergeScriptSha) — mid-run redeploys were otherwise
      // invisible and made one run's stories behave differently.
      scriptPath: convergeScriptPath,
    });
  } catch (e) {
    launchError = String(e);
  }

  // Handle launch failure — either workflow() threw (infrastructure error) OR it
  // returned a falsy value (e.g. the sub-workflow's return value was discarded,
  // or the sub-workflow crashed). Both mean we cannot proceed with this story.
  // Continuing would waste N doomed sub-workflow attempts before the operator
  // sees the real problem, so halt immediately.
  if (launchError || !convergeResult) {
    log(`Sub-workflow launch failed for ${sk}: ${launchError}`)
    state.blocked.push({ story: sk, reason: 'launch_failed', details: launchError });
    state.storyQueue.shift();
    state.halts.push({ reason: 'launch_failure', story: sk, iteration: state.iterationCount, details: launchError });
    await persistState(state);
    await appendJournal({ event: 'halt_launch_failure', storyKey: sk, iteration: state.iterationCount, error: launchError });
    return buildHaltContext(
      'launch_failure',
      { story: sk, error: launchError, completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator },
      timestamp, runDir
    );
  }

  // MR-creation failure: the converge sub-workflow returns converged:true with
  // an aborted field populated when MR creation itself fails (no pipeline was
  // ever launched). Treat as merge_conflict — the story needs operator review.
  if (convergeResult.aborted) {
    log(`Sub-workflow halted for ${sk}: ${convergeResult.aborted}`)
    // Also push to state.blocked so retry_blocked re-queues this story on resume
    // (the story is left at storyQueue[0] so the natural shift below would lose it).
    state.blocked.push({ story: sk, reason: 'merge_conflict', details: String(convergeResult.aborted) });
    state.halts.push({ reason: 'merge_conflict', story: sk, iteration: state.iterationCount, details: String(convergeResult.aborted) });
    state.storyQueue.shift();
    await persistState(state);
    await appendJournal({ event: 'halt_merge_conflict', storyKey: sk, iteration: state.iterationCount, details: String(convergeResult.aborted) });
    return buildHaltContext(
      'merge_conflict',
      { story: sk, completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator, details: String(convergeResult.aborted) },
      timestamp, runDir
    );
  }

  // CI hard-fail: converge returns converged:true even when CI failed (its
  // internal retry loop already exhausted transient retries). Treat any non-
  // success monitor.status as a hard fail — halt instead of silently marking
  // completed. Also catches merge blocked by a CI rule such as the merge-train
  // gate (status: 'success' but merge.merged: false).
  const ciStatus = convergeResult.monitor && convergeResult.monitor.status;
  const mergeBlocked = convergeResult.merge && convergeResult.merge.merged === false;
  if (ciStatus && ciStatus !== 'success') {
    log(`CI hard-fail for ${sk}: monitor.status=${ciStatus}`)
    state.blocked.push({ story: sk, reason: 'ci_hardfail', details: { ciStatus, failedJobs: convergeResult.monitor.failedJobs, retries: convergeResult.monitor.retries, transient: convergeResult.monitor.transient } });
    state.halts.push({ reason: 'ci_hardfail', story: sk, iteration: state.iterationCount, details: { ciStatus, failedJobs: convergeResult.monitor.failedJobs } });
    state.storyQueue.shift();
    await persistState(state);
    await appendJournal({ event: 'halt_ci_hardfail', storyKey: sk, iteration: state.iterationCount, ciStatus });
    return buildHaltContext(
      'ci_hardfail',
      { story: sk, ciStatus, failedJobs: convergeResult.monitor.failedJobs, completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator },
      timestamp, runDir
    );
  }
  if (mergeBlocked) {
    log(`Merge blocked for ${sk}: ${convergeResult.merge.error || 'unknown'}`)
    state.blocked.push({ story: sk, reason: 'merge_blocked', details: convergeResult.merge.error || null });
    state.halts.push({ reason: 'merge_blocked', story: sk, iteration: state.iterationCount, details: convergeResult.merge.error || null });
    state.storyQueue.shift();
    await persistState(state);
    await appendJournal({ event: 'halt_merge_blocked', storyKey: sk, iteration: state.iterationCount, error: convergeResult.merge.error });
    return buildHaltContext(
      'merge_blocked',
      { story: sk, error: convergeResult.merge.error, completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator },
      timestamp, runDir
    );
  }

  // Apply result
  if (isConverged(convergeResult)) {
    state.completed.push(sk);
    // Cleanup: converged story may be stale-pending in blocked/halts from
    // an earlier failure. removeFromState keeps state consistent with reality.
    state = removeFromState(state, sk);
    const convergedVia = convergeResult.converged === true ? 'converged' : 'merge';
    log(`Story ${sk} converged via ${convergedVia} (iter ${convergeResult.iterations || 0}, finalSha=${(convergeResult.finalSha || '').substring(0, 7)})`)
    // Track whether converge confirmed the story issue sync (done + closed).
    // When it did not (soft-fail, issue not found yet), Phase 4 retries it.
    const storyIssueSynced = !!(convergeResult.merge && convergeResult.merge.issueStatusSynced === true);
    if (storyIssueSynced) syncedThisRun.push(sk);
    await appendJournal({ event: 'converged', storyKey: sk, iteration: state.iterationCount, via: convergedVia, storyIssueSynced, convergeScriptSha: convergeResult.setup && convergeResult.setup.convergeScriptSha || '' });
    if (!storyIssueSynced) {
      log(`Story ${sk} issue NOT synced by converge (soft-fail) — Phase 4 will retry the done+close sync`)
    }
  } else {
    state.blocked.push({ story: sk, reason: convergeResult.escalateReason || 'not_converged' });
    log(`Story ${sk} blocked: ${convergeResult.escalateReason || 'not_converged'}`)
    await appendJournal({ event: 'blocked', storyKey: sk, iteration: state.iterationCount, reason: convergeResult.escalateReason || 'not_converged' });
  }

  state.storyQueue.shift();

  // Persist after EVERY story, including the three paths that `continue` early —
  // awaiting-operator parking, already-done, and unmet-dep skipping each mutate
  // state and used to jump straight back to the loop head. Previously the loop wrote
  // state only on halt paths, so a run that progressed without halting never updated
  // state.json: a live run was observed 33 minutes and three stories behind its own
  // journal (completed missing a converged story, blocked missing a blocked one),
  // which is exactly what makes a resume re-run finished work.
  const loopWriteHalt = await persistOrHalt(state);
  if (loopWriteHalt) return loopWriteHalt;

  // Periodic HITL halt
  if (!hitlFinalOnly && hitlEvery > 0 && state.iterationCount % hitlEvery === 0) {
    log(`Periodic HITL checkpoint at iteration ${state.iterationCount}`)
    state.halts.push({ reason: 'periodic_review', iteration: state.iterationCount });
    await persistState(state);
    await appendJournal({ event: 'halt_periodic', iteration: state.iterationCount });
    return buildHaltContext(
      'periodic_review',
      { completed: state.completed, blocked: state.blocked, skipped: state.skipped, awaitingOperator: state.awaitingOperator },
      timestamp, runDir
    );
  }
}

// Loop exited cleanly: queue empty
log(`Execute loop complete: completed=${state.completed.length} blocked=${state.blocked.length} skipped=${state.skipped.length} awaitingOperator=${state.awaitingOperator.length}`)
{
  const wsHalt = await persistOrHalt(state);
  if (wsHalt) return wsHalt;
}
await appendJournal({ event: 'execute_complete', completed: state.completed.length, blocked: state.blocked.length, skipped: state.skipped.length, awaitingOperator: state.awaitingOperator.length, halts: state.halts.length });

// ============================================================================
// PHASE 4: EPIC BOUNDARY — sprint-status sync + optional retrospective
// ============================================================================
phase('Epic boundary')
log('Syncing sprint-status: completed stories → done (orchestrator is sole writer of the PRD-branch YAML done transition; story issue labels are owned by converge merge)...')

// 4.1 Sprint-status sync (ALWAYS — the orchestrator is the sole writer of the
// sprint-status YAML done transition on the PRD branch). After each story MR
// merges into the PRD branch, sprint-status.yaml holds `in-progress` (committed
// by the converge setup agent onto the story branch, propagated via MR merge).
// The orchestrator advances the YAML to `done` here so the file's terminal
// state is correct.
//
// TRACKER ownership (distinct from the YAML): the converge merge agent owns the
// story issue lifecycle (in-progress at setup, done + closed at merge). This
// Phase 4 sync touches EPIC issues — marking an epic done + closed once every
// one of its stories is done — plus a SAFETY NET over STORIES_NEEDING_SYNC
// (stories whose converge-side sync soft-failed, or that were already 'done'
// before this run). That list is empty on the happy path.
//
// Implementation note: sprint_plan.py has no `advance` subcommand. The brief
// references an `advance` subcommand, but the script's actual subcommands are
// generate/status/validate (see .claude/skills/bmad-sprint-planning/SKILL.md).
// `generate --set <key>=<status>` is the documented equivalent: re-parses the
// epics, merges with existing statuses (preserving in-progress, etc.), and the
// `--set` flag forces the targeted keys to the desired status.
// Soft-fail around Phase 4 sync — if the sync throws (e.g. Skill global
// unavailable, network error, prompt misread), the orchestrator MUST
// continue with the rest of Phase 4. The sync is informational; the PRD
// progress shouldn't depend on label-syncing succeeding.
let sprintStatusSync;
let sprintStatusSyncError = null;
// Safety net for story issue labels (see syncedThisRun). Covers:
//   - stories this run converged but whose converge-side sync soft-failed
//     (Skill unavailable, issue not found yet) — otherwise the label would stay
//     at status:in-progress forever while sprint-status.yaml says done;
//   - stories already 'done' before this run, so converge never dispatched them.
// Converge stays the primary writer — this list is empty on the happy path, so
// Phase 4 usually issues zero story syncs. It is intentionally NOT persisted:
// after a resume it re-covers every already-done story, which costs a few
// redundant idempotent Skill calls (done+close on an already-done issue) but
// can never leave a label out of sync.
const storiesNeedingSync = state.completed.filter(sk => !syncedThisRun.includes(sk));
try {
  sprintStatusSync = await agent(
  `You are the sprint-status sync agent for bmad-prd-orchestrate (Phase 4).

PRD_WORKTREE_PATH: ${setup.prdWorktreePath}
SPRINT_STATUS_PATH: ${setup.sprintStatusPath}
COMPLETED_STORIES: ${JSON.stringify(state.completed)}
STORIES_NEEDING_SYNC: ${JSON.stringify(storiesNeedingSync)}
TIMESTAMP: ${timestamp}

GOAL: Advance sprint-status.yaml on the PRD branch so every converged story
      is 'done' and every epic whose stories are all done is 'done' too.
      Then commit + push so the remote reflects the final state.

STEPS:
1. cd ${setup.prdWorktreePath}
2. Discover an epic file under ${setup.prdWorktreePath}/_bmad-output/planning-artifacts/:
   - Prefer 'epics.md' or any 'epics*.md' / 'epic-*.md' file in that dir.
   - If multiple match, use the first one (the script tolerates any valid epics file).
3. Read ${setup.sprintStatusPath} to extract 'project' and 'generated' fields (preserve them).
4. Build the --set flags:
   - For each <key> in COMPLETED_STORIES: add --set <key>=done
   - For each epic-N in the file: if EVERY story belonging to epic-N has status 'done', add --set epic-N=done
   (Numeric → canonical mapping: a story canonical key begins with the epic number prefix; epic-N's stories are those whose canonical key starts with that prefix.)
5. Run ONE batched invocation (avoids partial-write races):
   python3 ${setup.repoRoot}/.claude/skills/bmad-sprint-planning/scripts/sprint_plan.py generate \\
     --epic-file <EPIC_FILE> \\
     --status-file ${setup.sprintStatusPath} \\
     --stories-dir ${setup.prdWorktreePath}/_bmad-output/implementation-artifacts/stories \\
     (KNOWN GAP: that directory does not exist in sprint mode, and sprint_plan.py:271
      guards its scan with is_dir(), so the spec-existence -> ready-for-dev upgrade is
      skipped SILENTLY. Even if it existed, sprint_plan.py:278 matches f"{key}.md",
      not the producer's spec-<id>-<slug>.md. Fixing it belongs upstream in
      bmad-sprint-planning — do NOT "fix" it here by pointing at another directory,
      the filename match would still miss.) \\
     --project "<project_name>" \\
     --date "${timestamp}" \\
     <all --set flags>
   The script emits a JSON report — verify it returned {"ok": true, ...}.
6. If the status file was modified (advanced > 0):
   - git -C ${setup.prdWorktreePath} add _bmad-output/implementation-artifacts/sprint-status.yaml
   - git -C ${setup.prdWorktreePath} commit -m "chore(sprint-status): Phase 4 sync — <N> stories + <M> epics to done"
   - git -C ${setup.prdWorktreePath} push origin ${setup.prdBranch}
7. SYNC EPIC ISSUE LABELS (mandatory when advancedEpics is non-empty — without
   this, a finished epic stays at status:backlog while its stories are done).
   The orchestrator owns ONLY epic issues: story issues are synced by
   bmad-build-converge (in-progress at setup, done + closed at merge), so do
   NOT touch story issues here. Done BEFORE the return spec in step 9 so
   labelsSynced is always populated. For each epic in advancedEpics, invoke the
   Skill (one shot):
       BMAD_ISSUE_ACTION=set-status \\
       BMAD_ISSUE_KEY="<epic-N>" \\
       BMAD_ISSUE_PRD_KEY="${setup.prdKey}" \\
       BMAD_ISSUE_NEW_STATUS="done" \\
       BMAD_ISSUE_CLOSE=true \\
           Skill: bmad-issue-tracking-sync
   BMAD_ISSUE_KEY must be the canonical epic sprint key "epic-<N>" (e.g. "epic-2"),
   NEVER the bare number — find-issue does a substring search scoped only by the
   PRD label, so "2" would match story issues and the first hit would be closed
   by mistake. The epic issue body carries the sprint key "Sprint Key: epic-<N>".
   advancedEpics already contains only epics whose EVERY story is 'done' (step 4).
   CLOSE=true closes the epic issue; the Skill's update-issue-status atomic drops
   any existing status label first (platform separator: status:: on GitLab,
   status: on GitHub). Capture { issue_id }. Soft-fail any individual issue not
   found (don't block the rest). labelsSynced = number of epics for which the
   Skill returned a non-null issue_id (NOT-found do NOT count). If Skill global is
   unavailable (ReferenceError) OR setup.prdKey is empty, skip all invocations and
   set labelsSynced: 0 — do not throw.

   THEN the STORY safety net — ALWAYS, before deciding to skip anything, even when
   advancedEpics is empty: for each story key in STORIES_NEEDING_SYNC, invoke the
   same Skill with the STORY key:
       BMAD_ISSUE_ACTION=set-status \\
       BMAD_ISSUE_KEY="<story-key>" \\
       BMAD_ISSUE_PRD_KEY="${setup.prdKey}" \\
       BMAD_ISSUE_NEW_STATUS="done" \\
       BMAD_ISSUE_CLOSE=true \\
           Skill: bmad-issue-tracking-sync
   STORIES_NEEDING_SYNC contains stories whose converge-side sync soft-failed, plus
   stories already 'done' before this run (so converge never dispatched them). It is
   normally EMPTY — converge owns the story done label and already synced the happy
   path — so this loop usually does nothing. Same soft-fail rule per story.
   labelsSynced = epics synced + these stories combined.
8. If advanced == 0 (everything already done — rare idempotent rerun):
   - Skip the sprint-status commit + push. Return committed=false, pushed=false.
   - STILL return every required field: advancedEpics (use [] when nothing
     advanced) and the real labelsSynced count from step 7 — an early return that
     omits them violates the return schema.
9. Return JSON: { advanced: <int>, advancedEpics: [<epic-N>], committed: <bool>, pushed: <bool>, projectName: <string>, labelsSynced: <int> }
   Every advancedEpics entry MUST be the canonical sprint key "epic-N" (e.g.
   "epic-2") — NEVER the bare number N. Downstream consumers depend on it: the
   retro agent parses /^epic-(\d+)$/ and WARN-skips anything else, and step 7
   passes the key straight to BMAD_ISSUE_KEY (where a bare number would
   substring-match story issues and close the wrong one).

CONSTRAINTS:
- ONLY write to ${setup.prdWorktreePath}/_bmad-output/implementation-artifacts/sprint-status.yaml.
- DO NOT modify any other tracked file.
- DO NOT skip commit + push when advanced > 0 — without it the remote stays stale.
- You are the SOLE writer of the sprint-status YAML done transition on the PRD
  branch. Story ISSUE labels are owned by bmad-build-converge (in-progress at
  setup, done + closed at merge) — do NOT re-sync the stories it already synced.
  You sync EPIC issues (done + closed) when all of the epic's stories are done,
  PLUS the STORIES_NEEDING_SYNC safety net (stories converge could not sync, or
  that were already done before this run).`,
  { label: `sprint-status-sync-${timestamp}`, phase: 'Epic boundary', schema: {
    type: 'object',
    properties: {
      advanced: { type: 'integer' },
      advancedEpics: { type: 'array', items: { type: 'string' } },
      committed: { type: 'boolean' },
      pushed: { type: 'boolean' },
      projectName: { type: 'string' },
      labelsSynced: { type: 'integer' },
    },
    required: ['advanced', 'advancedEpics', 'committed', 'pushed', 'labelsSynced'],
  }, agentType: 'general-purpose', allowedTools: ['Skill', 'Bash'] }
);
} catch (e) {
  sprintStatusSyncError = String(e);
  log(`Phase 4 sprint-status sync failed: ${sprintStatusSyncError} — continuing with rest of Phase 4`)
  sprintStatusSync = { advanced: 0, advancedEpics: [], committed: false, pushed: false, projectName: '', labelsSynced: 0 };
}
if (sprintStatusSyncError) {
  await appendJournal({ event: 'phase4_sprint_status_sync_failed', error: sprintStatusSyncError });
}

log(`Sprint-status sync: ${sprintStatusSync.advanced} stories → done, ${sprintStatusSync.advancedEpics.length} epics → done (committed=${sprintStatusSync.committed}, pushed=${sprintStatusSync.pushed})`)
await appendJournal({
  event: 'phase4_sprint_status_sync',
  advanced: sprintStatusSync.advanced,
  advancedEpics: sprintStatusSync.advancedEpics,
  committed: sprintStatusSync.committed,
  pushed: sprintStatusSync.pushed,
  labelsSynced: sprintStatusSync.labelsSynced,
});

// 4.2 Optional retrospective at epic boundaries (--retro flag).
// Only fires when (a) --retro=true AND (b) at least one epic advanced to done.
if (retro && sprintStatusSync.advancedEpics.length > 0) {
  // Determine which retros still need to run (skip epics whose retro is already 'done').
  const retroCheck = await agent(
    `Read ${setup.sprintStatusPath}.

For each of these epic keys: ${JSON.stringify(sprintStatusSync.advancedEpics)}
Find the corresponding retro key 'epic-N-retrospective'.

Return JSON: { retrosNeeded: [<epicKey>] }
where <epicKey> entries are the epics whose retro key is NOT 'done' (i.e., the retro still needs to run).`,
    { label: `retro-check-${timestamp}`, phase: 'Epic boundary', schema: {
      type: 'object',
      properties: { retrosNeeded: { type: 'array', items: { type: 'string' } } },
      required: ['retrosNeeded'],
    }, agentType: 'general-purpose' }
  );

  const retrosNeeded = retroCheck.retrosNeeded || [];

  if (retrosNeeded.length === 0) {
    log('All epics already have done retros; skipping retro dispatch')
    await appendJournal({ event: 'phase4_retro_skip', reason: 'all_done' });
  } else if (userChoice !== 'proceed_retro' && userChoice !== 'skip_retro') {
    // Halt for user approval before invoking retros (the brief mandates a manual gate here).
    log(`Halting for retro approval: ${retrosNeeded.length} epic(s) ready for retrospective...`)
    await persistState(state);
    await appendJournal({ event: 'halt_epic_retro', epics: retrosNeeded });
    return buildHaltContext('epic_retro', { retrosNeeded, completed: state.completed, blocked: state.blocked, runDir }, timestamp, runDir, ['proceed_retro', 'skip_retro', 'abort_prd']);
  } else if (userChoice === 'skip_retro') {
    log('Retro skipped per userChoice')
    await appendJournal({ event: 'phase4_retro_skip', reason: 'user_choice', epics: retrosNeeded });
  } else {
    // userChoice === 'proceed_retro': invoke one retro per epic. The skill is the
    // SOLE writer of the retro key status and action_items — the agent only verifies.
    log(`Invoking bmad-retrospective for ${retrosNeeded.length} epic(s)...`)
    const retrosCompleted = [];
    for (const epicKey of retrosNeeded) {
      // Extract numeric N from 'epic-N' so we can pass -H <N> to the skill.
      const epicNumMatch = /^epic-(\d+)$/.exec(epicKey);
      if (!epicNumMatch) {
        log(`WARNING: skipping malformed epicKey ${epicKey} (expected 'epic-N')`)
        continue;
      }
      const epicNum = epicNumMatch[1];

      const retroResult = await agent(
        `You are the retro dispatch agent for bmad-prd-orchestrate (Phase 4).

EPIC_KEY: ${epicKey}
EPIC_NUM: ${epicNum}
PRD_WORKTREE_PATH: ${setup.prdWorktreePath}
TIMESTAMP: ${timestamp}

GOAL: Invoke bmad-retrospective in headless mode for epic ${epicNum}.

STEPS:
1. cd ${setup.prdWorktreePath}
2. Invoke the bmad-retrospective skill in headless mode (the stable orchestrator-facing interface per SKILL.md):
   \`Skill: bmad-retrospective -H ${epicNum}\`
   Pass the numeric epic id; the skill handles discovery + sprint-status update + action items.
3. After the skill returns, re-read ${setup.sprintStatusPath}.
4. Verify development_status['epic-${epicNum}-retrospective'] === 'done'.
   - If not done: HALT — return retroDone=false with the failing field.
5. If the status file was modified during the retro (or to record an assumption),
   commit + push:
   - git -C ${setup.prdWorktreePath} add _bmad-output/implementation-artifacts/sprint-status.yaml
   - git -C ${setup.prdWorktreePath} commit -m "chore(sprint-status): retro for ${epicKey} done"
   - git -C ${setup.prdWorktreePath} push origin ${setup.prdBranch}
6. Return JSON: { epicKey: '${epicKey}', retroDone: <bool>, committed: <bool>, pushed: <bool>, actionItemsCount: <int> }

CONSTRAINTS:
- ONLY write to ${setup.prdWorktreePath}/_bmad-output/implementation-artifacts/sprint-status.yaml.
- The bmad-retrospective skill is the SOLE writer of the retro key status and action_items.
- DO NOT manually edit action_items.`,
        { label: `retro-${epicKey}-${timestamp}`, phase: 'Epic boundary', schema: {
          type: 'object',
          properties: {
            epicKey: { type: 'string' },
            retroDone: { type: 'boolean' },
            committed: { type: 'boolean' },
            pushed: { type: 'boolean' },
            actionItemsCount: { type: 'integer' },
          },
          required: ['epicKey', 'retroDone', 'committed'],
        }, agentType: 'general-purpose' }
      );

      log(`Retro for ${epicKey}: done=${retroResult.retroDone} committed=${retroResult.committed}`)
      if (retroResult.retroDone) {
        retrosCompleted.push(epicKey);
      }
    }
    await appendJournal({
      event: 'phase4_retro_complete',
      epics: retrosCompleted,
      attempted: retrosNeeded.length,
    });
  }
} else if (retro) {
  log('Retro requested but no completed epics found; skipping retro')
  await appendJournal({ event: 'phase4_retro_skip', reason: 'no_completed_epics' });
} else {
  log('Retro not requested (--retro not set)')
}

// ============================================================================
// PHASE 5: FINAL REPORT
// ============================================================================
phase('Final report')
log('Generating final report...')
const finalReport = {
  runId: timestamp,
  prdKey: setup.prdKey,
  completed: state.completed,
  blocked: state.blocked,
  skipped: state.skipped,
  awaitingOperator: state.awaitingOperator,
  halts: state.halts,
  iterations: state.iterationCount,
  haltReason: 'final_complete',
}
// Deliberately NOT persistOrHalt: the run is over and the report below is the
// deliverable. State was already made durable after the loop, so a failure here
// costs nothing — halting would throw away a completed run's results.
await persistState(state);
await appendJournal({
  event: 'final_complete',
  completed: state.completed.length,
  blocked: state.blocked.length,
  skipped: state.skipped.length,
  awaitingOperator: state.awaitingOperator.length,
  iterations: state.iterationCount,
});

// ============================================================================
// PHASE 6: CLEANUP (--cleanup flag)
// ============================================================================
phase('Cleanup')
if (cleanup) {
  log(`Removing run dir ${runDir}...`)
  await agent(
    `rm -rf ${runDir}. Return { removed: true, path: "${runDir}" }.

CONSTRAINTS:
- ONLY remove ${runDir}. Verify it has no symlinks that could escape before removing.
- DO NOT touch any file outside ${runDir}.
- If ${runDir} does not exist, return removed=false, path="${runDir}".`,
    { label: `cleanup-${timestamp}`, phase: 'Cleanup', schema: {
      type: 'object',
      properties: {
        removed: { type: 'boolean' },
        path: { type: 'string' },
      },
      required: ['removed', 'path'],
    }, agentType: 'general-purpose' }
  );
} else {
  log('Cleanup not requested (--cleanup not set); run dir preserved at ' + runDir)
}

return finalReport;

};

// `return await main();` — TOP-LEVEL return is REQUIRED here.
// The Workflow runtime wraps this script body in an async function; a bare
// `await main();` discards main()'s return value. Top-level `return` is legal
// at runtime but illegal in ESM — `node --check --input-type=module` flags it
// (expected; see the sed-strip validation recipe in CLAUDE.md).
return await main();
