// Note: the meta is static at script-load time, so 'storyKey' can't be
// inlined. The 'name' field is fixed ('bmad-build-converge'); the
// 'description' shows the generic flow. To make the running story
// visible, check args.storyKey after the workflow starts.
//
// IMPORTANT: Workflow tool requires `export const meta = {...}` as the
// FIRST statement. No static imports allowed above it. No fs usage
// (dispatchViaClaudeP creates its temp file via the bash wrapper agent).
export const meta = {
  name: 'bmad-build-converge',
  description: 'Single-story bmad-build with quality-gate convergence loop + CI gate + auto-merge. Generic across any BMAD PRD: discovers repo, PRD worktree, issue-tracking config, and project_key from sprint-status.yaml. The story being processed is passed via args.storyKey (logged at Setup).',
  phases: [
    { title: 'Setup' },
    { title: 'Create MR' },
    { title: 'Build with convergence' },
    { title: 'Auto-merge' },
    { title: 'Cleanup' },
  ],
};

const main = async () => {

const storyKey = args.storyKey;
if (!storyKey) throw new Error('args.storyKey required');
// maxIterations: REVIEW convergence budget (build + post-build per iter; no CI wait).
// ciMaxIterations: CI-FIX budget (separate counter; only consumed after build converges).
const maxIterations = args.maxIterations || 5;
const ciMaxIterations = args.ciMaxIterations || 3;
const timestamp = args.timestamp || 'unknown';
// Wall-clock anchor for elapsed-time checks. Caller passes a fixed timestamp
// (workflow tool rejects Date.now() inside scripts — they break resume).
// Falls back to 0 if omitted; safety caps still work but use elapsed-since-script-start.
const now = args.now || 0;
// On resume (e.g., after CI failure halted the workflow), the orchestrator re-invokes
// the sub-workflow with args.ciFailure describing the previous CI failure. The build
// agent passes this to bmad-build-auto's reviewers so the next iteration targets
// the actual CI failure rather than guessing.
let ciFailure = args.ciFailure || null;
// lastCIStatus is set inside the convergence loop and read after the loop
// to drive the auto-merge decision + the final log line. Must be declared
// at the same scope as the loop (not inside it) so it survives loop exit.
let lastCIStatus = null;

const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    storyKey: { type: 'string' },
    repoRoot: { type: 'string' },
    prdWorktreePath: { type: 'string' },
    prdKey: { type: 'string' },
    baseBranch: { type: 'string' },
    storyBranch: { type: 'string' },
    worktreePath: { type: 'string' },
    baselineSha: { type: 'string' },
    resumedFromBranch: { type: 'boolean' },
    sprintStatusUpdated: { type: 'boolean' },
    sprintStatusPath: { type: 'string' },
    specPath: { type: 'string' },
    prdBranch: { type: 'string' },
    // mrRepo = host + '/' + project from issue-tracking.yaml. Constructed by
    // SETUP agent so downstream phases (mr-create) don't have to re-parse the
    // config or re-read it from disk. Used as BMAD_MR_REPO for Skill: bmad-issue-tracking-sync.
    mrRepo: { type: 'string' },
  },
  required: ['storyKey', 'repoRoot', 'prdWorktreePath', 'prdKey', 'baseBranch', 'storyBranch',
             'worktreePath', 'baselineSha', 'resumedFromBranch', 'sprintStatusUpdated',
             'sprintStatusPath', 'specPath', 'prdBranch', 'mrRepo'],
};

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    storyKey: { type: 'string' },
    iteration: { type: 'integer' },
    newSha: { type: 'string' },
    followupReviewRecommended: { type: 'boolean' },
    patchesApplied: { type: 'integer' },
    itemsDeferred: { type: 'integer' },
    scoreFormula: { type: 'string' },
    specStatus: { type: 'string' },
    pushed: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['storyKey', 'iteration', 'newSha', 'followupReviewRecommended', 'specStatus', 'pushed'],
};

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    storyKey: { type: 'string' },
    mrIid: { type: 'integer' },
    merged: { type: 'boolean' },
    sprintStatusDone: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['storyKey', 'mrIid', 'merged', 'sprintStatusDone'],
};

const CLEANUP_SCHEMA = {
  type: 'object',
  properties: {
    removedWorktrees: { type: 'array', items: { type: 'string' } },
    deletedBranches: { type: 'array', items: { type: 'string' } },
    keptWorktrees: { type: 'array', items: { type: 'string' } },
    keptBranches: { type: 'array', items: { type: 'string' } },
    prunedRefs: { type: 'integer' },
    removedLogs: { type: 'array', items: { type: 'string' } },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['removedWorktrees', 'deletedBranches', 'keptWorktrees', 'keptBranches', 'prunedRefs', 'removedLogs', 'errors'],
};


// ============================================================================
// base64Encode: pure-JS UTF-8 → base64 (workflow scripts lack Buffer + btoa).
// ============================================================================

// toRepoRelativePath(specPath, worktreePath, repoRoot) → string
// Strips the worktree path prefix (preferred) or repo root prefix (fallback)
// from specPath to produce a portable, repo-root-relative path for the MR
// description. Pure: string manipulation, no side effects.
function toRepoRelativePath(specPath, worktreePath, repoRoot) {
  // Only strip worktree prefix if worktreePath is a non-empty string.
  // Otherwise wtPrefix='/' which would match the leading slash of any
  // absolute path and slice it off.
  if (specPath && worktreePath && typeof worktreePath === 'string' && worktreePath.length > 0) {
    const wtPrefix = worktreePath + '/';
    if (specPath.startsWith(wtPrefix)) {
      return specPath.slice(wtPrefix.length);
    }
  }
  if (specPath && repoRoot && typeof repoRoot === 'string' && repoRoot.length > 0) {
    const repoPrefix = repoRoot + '/';
    if (specPath.startsWith(repoPrefix)) {
      return specPath.slice(repoPrefix.length);
    }
  }
  return specPath || '';
}

// formatMRDescriptionPlaceholder(storyKey) → string
// Placeholder body for the MR description file when the spec doesn't exist at
// MR-create time (normal case — bmad-build-auto creates the spec during Build).
// Reviewers see this until the full spec is committed post-build. YAML
// frontmatter makes the body render as a collapsible on most platforms.
function formatMRDescriptionPlaceholder(storyKey) {
  return [
    '---',
    `Story ${storyKey} — auto-generated by bmad-build-converge.`,
    `Full spec committed to the branch at _bmad-output/implementation-artifacts/stories/${storyKey}.md.`,
    '---',
  ].join('\n');
}

// shouldAcceptStoryStatus(status) → boolean
// Guard for converge setup: only certain statuses allow setup to proceed.
// Accept backlog/ready-for-dev/in-progress/review. Reject done/awaiting-operator/
// blocked (terminal or deferred). Defensive reject for unknown values.
// Pure: single-status decision, no Workflow globals.
function shouldAcceptStoryStatus(status) {
  return status === 'backlog' || status === 'ready-for-dev' || status === 'in-progress' || status === 'review';
}

// buildDispatchMarker(storyKey, dispatchSeq) → string
// Per-dispatch unique marker (used as bash variable name + /tmp filename base).
// Sanitizes storyKey by replacing non-[a-zA-Z0-9_-] chars with `_` so the
// marker is shell-safe. Pure: input → marker, no side effects.
function buildDispatchMarker(storyKey, dispatchSeq) {
  const safeStoryKey = (storyKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `BMADBC_${safeStoryKey}_${dispatchSeq}`;
}

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

// ============================================================================
// dispatchViaClaudeP: replace agent() with `claude -p` subprocess.
//
// `claude -p` runs in a primary Claude Code session, which has full Skill
// tool access AND can dispatch its own subagents. The Workflow tool's nested
// agent() context blocks subagent dispatch (step-03 of bmad-build-auto bails
// with "no subagents"). Spawning claude -p unblocks that.
//
// Only the Build phase uses this helper (it invokes Skill: bmad-build-auto).
// Other phases keep using agent() — they don't dispatch subagents.
//
// Transport: prompt → base64 → bash `echo | base64 -d > /tmp/...` → `cat | claude -p -`.
// Avoids shell quoting hell (apostrophes, backticks, $vars in prompts).
//
// cwd: optional. When omitted, the bash-agent wrapping claude -p uses its
// own CWD. Build always passes cwd=setup.worktreePath.
// ============================================================================
// Per-run counter for marker uniqueness. Workflow tool forbids
// Date.now()/Math.random() (they break resume), so use a simple increment.
let dispatchSeq = 0;

async function dispatchViaClaudeP(opts) {
  const { label, phase, prompt, schema, cwd, allowedTools, maxBudgetUsd } = opts;
  dispatchSeq++;
  const marker = buildDispatchMarker(storyKey, dispatchSeq);
  // JSON schema can't be inlined as '...' inside the bash -c '...' command —
  // the single quotes would clash. Pass via SCHEMA env var (set BEFORE nohup,
  // inherited by the inner bash). The inner bash -c references $SCHEMA.
  // (Caught by another agent: nested single quotes broke the command.)
  const schemaEnvArg = schema ? ' --json-schema "$SCHEMA"' : '';
  const schemaEnvPrefix = schema ? `SCHEMA='${JSON.stringify(schema)}' ` : '';
  const modelArg = '';
  const promptB64 = base64Encode(prompt);
  const promptFile = `/tmp/bmad-bc-${marker}.txt`;
  const stdoutFile = `/tmp/bmad-bc-${marker}.stdout`;
  const stderrFile = `/tmp/bmad-bc-${marker}.stderr`;
  // Single Bash call: launches claude -p detached via nohup + waits up to 9 min
  // by polling the SPECIFIC PID via kill -0 (no pgrep pattern = no self-match —
  // the previous bug). If 9 min elapsed without PID exit, prints POLLING_REQUIRED
  // and the wrapper falls back to Read-polling the stdout file (Read tool has
  // no Bash timeout limit). claude -p with nohup survives even when Bash tool
  // kills the outer bash at its 10-min cap.
  //
  // This worked for story 5-11 (completed via this exact pattern, with the
  // wrapper recovering by manually reading the output file after a self-matching
  // pgrep loop hung). The fix: pass the EXACT PID to watch, no pattern matching.
  const cmd = `cd '${cwd || '.'}' && printf '%s' '${promptB64}' | base64 -d > '${promptFile}' && ${schemaEnvPrefix}nohup bash -c 'cat ${promptFile} | claude -p -${modelArg} --output-format stream-json --verbose --permission-mode bypassPermissions --allowed-tools ${allowedTools}${schemaEnvArg} > ${stdoutFile} 2> ${stderrFile}; echo EXIT_CODE=$? >> ${stdoutFile}' > /dev/null 2>&1 & PID=$!; echo PID=$PID; START=$(date +%s); trap 'echo "WRAPPER_BASH_EXIT_AT=$(date +%s) reason=$?"' EXIT; while true; do if ! kill -0 $PID 2>/dev/null; then cat '${stdoutFile}'; echo "WRAPPER_BASH_EXIT_AT=$(date +%s) reason=pid_dead"; break; fi; ELAPSED=$(($(date +%s) - START)); if [ $ELAPSED -gt 540 ]; then echo 'POLLING_REQUIRED STDOUT=${stdoutFile}'; echo "WRAPPER_BASH_EXIT_AT=$(date +%s) reason=polling_timeout"; break; fi; sleep 5; done`;
  const wrapperResult = await agent(
    `PROHIBITIONS:

- DO NOT write polling loops using ps/pgrep/sleep. Use the EXACT PID given in the bash output.
- DO NOT re-invoke claude -p manually.
- DO NOT modify the COMMAND.

TASK:

Run the COMMAND below. It launches claude -p detached and polls its specific
PID for up to 9 minutes. If 9 min elapses, it returns POLLING_REQUIRED — you
then fall back to Read-polling the stdout file.

STEPS:

1. Call Bash with:
   - command: the COMMAND below (full text)
   - timeout: 600000  (10 min max — bash polls for 9 min internally)
   - description: launch + wait claude -p
   Do not pass any other parameters.

2. Parse the Bash output:
   - If it ends with EXIT_CODE=<n>: stdout = everything BEFORE that line,
     exitCode = integer after EXIT_CODE=
   - If it starts with "POLLING_REQUIRED STDOUT=<path>": extract the path.
     Poll that file via Read tool every ~60s (use Bash "sleep 60" between
     Reads). Loop until the file ends with EXIT_CODE=<n>. Max ~10 Reads.
     When found, parse as above.
   - If empty or unrecognized: DO NOT fast-fail. claude -p may still be
     running detached (the nohup'd bash + claude -p survive Bash tool
     timeouts; --verbose wrote progress to stderr). Read-poll the stdout
     file via the Read tool until EXIT_CODE appears:
     - The file path is /tmp/bmad-bc-BMADBC_<storyKey>_<N>.stdout (the
       marker is in the COMMAND below — extract it from the command string).
     - claude -p with --verbose emits progress events. Whether they go
       to stdout, stderr, or both is env-dependent — don't assume. Check
       BOTH stdout and stderr mtimes; claude -p is alive if EITHER file
       grew within the last 30 minutes.
     - The stdout file path is /tmp/bmad-bc-BMADBC_<storyKey>_<N>.stdout
       (extract from the COMMAND below — look for "stdoutFile=" or the
       redirect target). The stderr file is the same basename with
       ".stderr" extension. Use Bash "stat -c '%Y' $stdoutFile" and
       "stat -c '%Y' $stderrFile" to get both mtimes. Compare each to
       current time: Bash "date +%s". If BOTH mtimes haven't changed in
       30 minutes (= 1800 sec), claude -p is likely hung → fast-fail
       with { stdout: "", exitCode: 1 }. DO NOT kill any process — just
       report hung and return.
     - Each loop iteration, run this single Bash check (concise, token-efficient):
         Bash command="STDOUT='<stdoutFile>'; STDERR='<stderrFile>';
         NOW=\$(date +%s); ST_M=\$(stat -c '%Y' \"\$STDOUT\" 2>/dev/null || echo 0);
         ER_M=\$(stat -c '%Y' \"\$STDERR\" 2>/dev/null || echo 0);
         STALE=\$(( NOW - (ST_M > ER_M ? ST_M : ER_M) ));
         echo \"stale_sec=\$STALE\";
         if grep -q '^EXIT_CODE=' \"\$STDOUT\" 2>/dev/null; then echo 'EXIT_CODE_FOUND'; fi"
         timeout=15000
         description="poll claude -p stdout/stderr activity"
       If \`stale_sec > 1800\` (both files silent 30+ min): fast-fail (no kill).
       If \`EXIT_CODE_FOUND\` in output: Read the FULL stdout file via Read tool,
       parse the last NDJSON \`result\` event, extract structured_output,
       return { stdout: JSON.stringify(envelope), exitCode: 0 }.
       Else: sleep 60, repeat. (NO tail during poll — only Read file once EXIT_CODE found.)

     - DO NOT kill processes. Fast-fail returns empty stdout only.

3. CRITICAL: Return ONLY EXTRACTED FIELDS, not the full stdout file.
   The StructuredOutput input limit is ~12KB. The stdout file can be
   100KB+. If you return the raw stdout, you'll be truncated and the
   orchestrator will fail to parse. Return:
     { stdout: <parsed envelope as JSON STRING, not raw stdout>,
       exitCode: <integer> }
   Parse the stdout file, find the last 'result' event (or single envelope
   object), extract its structured_output + is_error + terminal_reason +
   num_turns fields. JSON.stringify those fields as the stdout value.
   The orchestrator's parser extracts structured_output from your stdout.

COMMAND:
${cmd}`,
    { label, phase, schema: {
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        exitCode: { type: 'integer' },
      },
      required: ['exitCode', 'stdout'],
    }, agentType: 'general-purpose' }
  );

  if (!wrapperResult) return { error: 'wrapper returned no result' };
  if (wrapperResult.exitCode !== 0) return { error: `claude -p exit ${wrapperResult.exitCode}: ${wrapperResult.stdout || ''}` };

  // Defensively strip the EXIT_CODE=<n> line that the bash command appends
  // to the stdout file.
  let stdoutText = (wrapperResult.stdout || '').trim();
  stdoutText = stdoutText.replace(/\nEXIT_CODE=\d+\s*$/, '');
  // claude -p with --output-format stream-json emits NDJSON events (one
  // JSON object per line). Find the last 'result' event by splitting on
  // newlines and parsing each line. Falls back to single-object or
  // array-of-events shape for backward compat with --output-format json.
  let envelope = null;
  const lines = stdoutText.split('\n').map(l => l.trim()).filter(l => l);
  for (let i = lines.length - 1; i >= 0 && !envelope; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && ev.type === 'result') { envelope = ev; break; }
      if (ev && 'structured_output' in ev) { envelope = ev; break; }
    } catch {}
  }
  if (!envelope) {
    // Backward compat: try parsing the whole stdout as single JSON
    let parsed = null;
    try { parsed = JSON.parse(stdoutText); } catch {}
    if (parsed) {
      if (Array.isArray(parsed)) {
        envelope = [...parsed].reverse().find(e => e && e.type === 'result') || parsed[parsed.length - 1] || null;
      } else if (parsed && typeof parsed === 'object' && 'structured_output' in parsed) {
        envelope = parsed;
      }
    }
  }
  if (!envelope || typeof envelope !== 'object' || !('structured_output' in envelope)) {
    return { error: `claude -p envelope missing structured_output (got: ${stdoutText.substring(0, 500)})` };
  }
  return envelope.structured_output;
}

// ============================================================================
// PHASE 1: SETUP — discover repo, PRD worktree, config, project_key
// ============================================================================
phase('Setup')
log(`Setup for story ${storyKey} (discovering repo context)...`)
const setup = await agent(
  `You are the setup agent for story ${storyKey}.

GENERIC DISCOVERY (works for any BMAD PRD — admin-logs-victorialogs, keycloak-idp, mobile-oidc, etc.):

STEPS:
1. Discover repo + PRD worktree:
   a. \`git rev-parse --show-toplevel\` → repoRoot (bare git dir, e.g. /home/<user>/git_projects/<org>/genie-ai).
   b. \`git worktree list --porcelain\` → parse PORCELAIN format. Each entry:
      - Line 'worktree <path>' starts a new worktree section.
      - Line 'branch refs/heads/<name>' gives the checked-out branch.
      Find the worktree whose branch matches pattern 'refs/heads/feat/*/prd' (the PRD umbrella branch per _bmad/custom/issue-tracking.yaml branch_patterns.prd). That worktree is prdWorktreePath. The branch suffix after 'refs/heads/feat/' and before '/prd' is the prdKey.
   c. If no worktree matches → HALT (return error in storyKey, prdWorktreePath empty). This workflow requires a PRD umbrella branch + worktree.
2. Read config:
   a. From prdWorktreePath, read _bmad/custom/issue-tracking.yaml. Parse YAML. Required fields:
      - git_platform: gitlab
      - host: <gitlab host>
      - project: <gitlab project path, e.g. un/itu/genie-ai>
      - worktree_base: <relative path from repoRoot, typically .claude/worktrees>
      - branch_patterns.prd: "feat/{prd_key}/prd"
      - branch_patterns.story: "feat/{prd_key}/{story_key}"
   b. Verify prdKey from step 1b matches the project's git remote: \`git -C repoRoot remote -v\`. The remote URL host should match config host.
   c. Construct mrRepo = host + '/' + project (e.g. opensource.unicc.org/un/itu/genie-ai). This is the value the Skill: bmad-issue-tracking-sync expects in BMAD_MR_REPO. Return it as mrRepo in SETUP_SCHEMA so downstream phases (mr-create) can use it directly.
3. baseBranch = worktree_base-style interpolation: feat/<prd_key>/prd (matches the existing PRD branch you found).
4. Confirm story is ready:
   a. sprintStatusPath = prdWorktreePath + '/_bmad-output/implementation-artifacts/sprint-status.yaml'.
   b. Read sprintStatusPath. Find development_status[<storyKey>]. Acceptable statuses: 'backlog' (no spec yet — bmad-build-auto will create it in step 02), 'ready-for-dev' (spec committed, ready to implement), 'in-progress' (already in flight — resume case), 'review' (re-attempting after review). REJECT only 'done' (already complete) or 'awaiting-operator' / 'blocked' (deferred by operator). If rejected, HALT with sprintStatusUpdated:false.
5. Sync story branch with prd (use prdWorktreePath for rebase, NOT repoRoot — that would corrupt the main checkout):
   a. \`git -C prdWorktreePath fetch origin <baseBranch> <storyBranch>\`
   b. \`storyCount=$(git -C prdWorktreePath rev-list --count origin/<baseBranch>..origin/<storyBranch>)\`
   c. If storyCount == 0: \`git -C prdWorktreePath push --force-with-lease origin origin/<baseBranch>:refs/heads/<storyBranch>\` (resumedFromBranch=true)
   d. If storyCount > 0 (rebase to preserve unique commits):
      BRANCH=_rebase_story_${storyKey.replace(/\//g, '_')}
      \`git -C prdWorktreePath checkout -b $BRANCH origin/<storyBranch>\`
      \`git -C prdWorktreePath rebase origin/<baseBranch>\`
      \`git -C prdWorktreePath push --force-with-lease origin $BRANCH:<storyBranch>\` || \`git -C prdWorktreePath branch -D $BRANCH\`
      \`git -C prdWorktreePath branch -D $BRANCH\`
      resumedFromBranch=true
   e. If no remote story branch: \`git -C prdWorktreePath push origin origin/<baseBranch>:refs/heads/<storyBranch>\` (resumedFromBranch=false)
   f. baselineSha: \`git -C prdWorktreePath rev-parse origin/<storyBranch>\`
6. Create worktree:
   worktreePath = repoRoot + '/' + worktree_base + '/' + storyBranch-with-slashes-replaced-by-dashes.
   Example: <repoRoot>/<worktree_base>/<storyBranch-slashes-to-dashes>
   Command: \`git -C repoRoot worktree add <worktreePath> <storyBranch>\`.
7. Sync sprint-status INSIDE the story worktree (it's a tracked file; commit goes onto storyBranch):
   cd <worktreePath>
   - Update development_status[<storyKey>] = in-progress
   - Find epic-{N} where N = first numeric segment of <storyKey>. Set to in-progress if currently backlog.
   - Update last_updated to "${timestamp}"
   - git add + commit -m "chore(sprint-status): story <storyKey> → in-progress"
   - DO push this commit (so MR create phase has something to point at): \`git push origin \${storyBranch}\` (use --force-with-lease if local is ahead).
8. (NO spec edit here.) bmad-build-auto owns the spec lifecycle — its step-02-plan creates the spec at specPath from spec-template.md and manages status transitions. The setup agent only owns worktree + branch + sprint-status. SpecPath is computed and returned in SETUP_SCHEMA but the file is NOT touched at this stage. (bmad-build-auto will create it during the Build phase and overwrite any stub; a stub here would be wasted work + confuse the resume check in step-02-plan.)
9. Return SETUP_SCHEMA JSON with ALL fields filled. The other phases depend on these — incomplete context = broken workflow.

CONSTRAINTS:
- DO NOT modify prdWorktreePath (the PRD worktree). Only create the story worktree.
- DO push the sprint-status + spec commits to remote (MR create needs them).
- DO NOT skip the sprint-status sync.
- If discovery fails at any step, HALT with the failing field empty + clear error in storyKey.`,
  { label: `setup-${storyKey}`, phase: 'Setup', schema: SETUP_SCHEMA, agentType: 'general-purpose' }
)

if (!setup || !setup.worktreePath) {
  return { aborted: true, stage: 'setup', storyKey, error: 'setup agent failed or discovery incomplete' }
}
log(`Repo: ${setup.repoRoot} | PRD worktree: ${setup.prdWorktreePath} | prdKey: ${setup.prdKey}`)
log(`Story branch: ${setup.storyBranch} | Worktree: ${setup.worktreePath} | Baseline: ${setup.baselineSha}`)

// ============================================================================
// PHASE 2: CREATE MR (runs ONCE, before Build loop)
// ============================================================================
// MR exists when the Build loop's CI check runs — guarantees a single CI
// surface (MR pipeline), no branch/MR fallback path. Setup just pushed
// sprint-status + spec commits to remote, so MR creation now has a diff.
phase('Create MR')
log(`Creating MR for ${setup.storyBranch}...`)
// Compute spec path relative to repo root for the MR description (portable
// for reviewers, not a local laptop path). The spec file is committed to
// the branch at _bmad-output/... — strip the worktree prefix (or repo
// root as fallback). Uses extracted pure helper (test/pure.test.mjs).
let relSpecPath = toRepoRelativePath(setup.specPath, setup.worktreePath, setup.repoRoot);
const mrResult = await agent(
  `Create MR for branch ${setup.storyBranch} → ${setup.baseBranch}, story ${setup.storyKey}.

CONTEXT (from setup agent):
- repoRoot: ${setup.repoRoot}
- prdKey: ${setup.prdKey}
- baseBranch: ${setup.baseBranch}
- storyBranch: ${setup.storyBranch}
- worktreePath: ${setup.worktreePath}
- mrRepo: ${setup.mrRepo}  (host/project from _bmad/custom/issue-tracking.yaml — pass as-is to BMAD_MR_REPO)

OPERATE FROM: ${setup.worktreePath}

STEPS:
1. Prepare the MR description file (must be a separate file — Skill requires BMAD_MR_DESCRIPTION_FILE; cleanup will delete it):
   - IF ${relSpecPath} exists (post-build MR creation OR a pre-existing spec): copy it
     \`cp "${relSpecPath}" /tmp/bmad-mr-desc-${setup.storyKey}.md\`
   - IF ${relSpecPath} does NOT exist (normal case: spec created by bmad-build-auto during Build, not yet at MR-create time): write a placeholder
     Write /tmp/bmad-mr-desc-${setup.storyKey}.md with content from `formatMRDescriptionPlaceholder(setup.storyKey)` (pure helper, tested in test/pure.test.mjs).
   mrDescFile = /tmp/bmad-mr-desc-${setup.storyKey}.md
2. Invoke MR create via the Skill (wraps atomic find-or-create; soft-fail: if Skill errors, capture error and return without mrIid):
   BMAD_MR_ACTION=ensure-mr \\
   BMAD_MR_SOURCE_BRANCH="${setup.storyBranch}" \\
   BMAD_MR_TARGET_BRANCH="${setup.baseBranch}" \\
   BMAD_MR_TITLE="Story ${setup.storyKey} — bmad-build-converge" \\
   BMAD_MR_DESCRIPTION_FILE="${'${mrDescFile}'}" \\
   BMAD_MR_REPO="${setup.mrRepo}" \
       Skill: bmad-issue-tracking-sync
   Note: ensure-mr does NOT return mr_iid (per common/ensure-mr.yaml header — "Output variables: (none — call common/find-mr after to resolve mr_iid if needed)"). Capture { mr_url } only.
3. Resolve mr_iid via find-mr (mandatory because ensure-mr doesn't return it):
   BMAD_MR_ACTION=find-mr \\
   BMAD_MR_SOURCE_BRANCH="${setup.storyBranch}" \\
   BMAD_MR_REPO="${setup.mrRepo}" \
       Skill: bmad-issue-tracking-sync
   Capture { mr_iid } from the Skill's stdout return. If mr_iid is empty (find-mr found nothing — should not happen post-ensure-mr), set mrIid=0 and mrResult.error="find-mr returned no mr_iid after ensure-mr".
4. After the ensure-mr Skill returns: rm -f "${'${mrDescFile}'}" as BMAD_MR_DESCRIPTION_FILE cleanup (per SKILL.md "Cleanup: the Skill caller's agent does rm -f on BMAD_MR_DESCRIPTION_FILE after Skill returns"; best-effort — swallow errors). The temp file lives in /tmp — safe to delete.
5. Fetch first pipeline id (RACE-AWARE: push may not have triggered a pipeline yet; pipeline_id may be empty):
   BMAD_MR_ACTION=get-mr-pipeline BMAD_MR_IID=<captured mr_iid> BMAD_MR_REPO="${setup.mrRepo}" Skill: bmad-issue-tracking-sync.
   Capture { pipeline_id, pipeline_status }. If pipeline_id is empty, treat as "no pipeline yet" — set pipelineId=0 and pipelineStatus="none" (the CI loop will pick up the real pipeline when it polls).
6. If any Skill call soft-fails (no mr_iid returned, OR ensure-mr error), return early with the error string set (NEVER halt the build — Phase 2 fallback is to skip MR creation).

RETURN JSON: { storyKey: ${setup.storyKey}, mrIid: <mr_iid>, mrUrl: <mr_url>, pipelineId: <pipeline_id>, branch: ${setup.storyBranch}, error? }

CONSTRAINTS:
- DO NOT run CI check (Build loop's CI agent does that per iteration)
- DO NOT run Skill: bmad-build-auto (Build agent does that)
- DO NOT modify any code or spec files`,
  { label: `mr-create-${setup.storyKey}`, phase: 'Create MR', schema: {
    type: 'object',
    properties: {
      storyKey: { type: 'string' },
      mrIid: { type: 'integer' },
      mrUrl: { type: 'string' },
      pipelineId: { type: 'integer' },
      branch: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['storyKey', 'branch'],
  }, agentType: 'general-purpose' }
)

if (!mrResult || mrResult.error || !mrResult.mrIid) {
  return {
    storyKey: setup.storyKey,
    aborted: true,
    stage: 'create-mr',
    iterations: 0,
    mrResult,
    worktreePath: setup.worktreePath,
    branch: setup.storyBranch,
    error: mrResult?.error || 'no MR created',
  }
}
log(`MR !${mrResult.mrIid} created (CI will run on first push during Build loop)`)

// ============================================================================
// PHASE 3: BUILD WITH CONVERGENCE
// ============================================================================
phase('Build with convergence')
log(`Running bmad-build convergence loop (${maxIterations} review + ${ciMaxIterations} CI-fix iterations)...`)

let iteration = 0;
let ciIter = 0;
let ciWait = 0;  // INFO counter for non-terminal CI state re-polls (no budget — just for logging)
let ciWaitStartedAt = now;
const CI_WAIT_MAX_MS = 2 * 60 * 60 * 1000;  // 2h safety cap (matches wrapper bash timeout 7200000ms)
let followup = true;
let currentSha = setup.baselineSha;
let convergedSha = null;
let iterationsLog = [];
// lastSpecStatus captured across loop iterations — used by Auto-merge
// guard to skip merge for deferred/blocked stories (awaiting-operator,
// blocked). Skill may finalize spec status to one of these if human
// action is required or an unresolved issue blocked completion.
let lastSpecStatus = null;

// PHASE A: REVIEW CONVERGENCE LOOP
// Build + postBuild + push. NO CI WAIT. If build wants followup, loop immediately
// (saves ~3-5min per iter vs old behavior which polled CI between reviews).
while (followup && iteration < maxIterations) {
  iteration++;
  log(`--- Review iteration ${iteration}/${maxIterations} (baseline ${currentSha.substring(0, 7)}) ---`)

  const buildResult = await dispatchViaClaudeP({
    label: `build-iter-${iteration}`,
    phase: 'Build with convergence',
    cwd: setup.worktreePath,
    prompt: `/bmad-build-auto ${setup.storyKey}

DO NOT load the bmad-build-converge skill (would cause recursion).

${ciFailure ? `CI FAILED LAST ITER — fix it.

Pipeline: ${ciFailure.pipelineId}  Status: ${ciFailure.status}

Failed jobs:
${(ciFailure.failedJobs || []).map(j => `  - ${j.name} (exit ${j.exitCode})`).join('\n') || '  (none reported)'}

CI trace tail (last ${(ciFailure.traceTail || '').length} chars shown):
\`\`\`
${(ciFailure.traceTail || '').substring(0, 5000)}
\`\`\`
` : ''}

sprint-status.yaml is owned by the orchestrator: never write it, and never revert a change to it. A row at done or awaiting-operator is the orchestrator's own bookkeeping — not a defect to fix, and not proof that the work is verified.

If Skill HALTs (terminal status != done), return { skillCompleted: false, error: <halt reason> }. Otherwise { skillCompleted: true }.`,
    schema: {
      type: 'object',
      properties: {
        skillCompleted: { type: 'boolean' },
        error: { type: 'string' },
      },
      required: ['skillCompleted'],
    },
    allowedTools: 'Read,Write,Edit,Bash,Skill,Agent',
  });

  if (!buildResult || !buildResult.skillCompleted || buildResult.error) {
    const err = buildResult?.error || 'skill did not complete';
    log(`Build agent (Skill) failed: ${err}`)
    iterationsLog.push({ iter: iteration, error: `build: ${err}` });
    // Classify: transient (subagent kill, await timeout) → retry. Persistent
    // (intent gap, config error, explicit halt with reason) → escalate.
    const transient = /awaiting|subagent.*kill|system.*kill|timeout/i.test(err);
    if (transient && iteration < maxIterations) {
      log(`Transient build failure — retrying (iter ${iteration}/${maxIterations})`)
      followup = true;  // continue loop
    } else {
      followup = false;
      break;
    }
  }

  const postBuildResult = await agent(
    `Post-build for story ${setup.storyKey}, iter ${iteration}. Build agent already invoked Skill: bmad-build-auto and committed locally. Your job: verify deliverables + push + return BUILD_SCHEMA.

OPERATE FROM: ${setup.worktreePath} (git checkout branch ${setup.storyBranch}).

STEPS:
1. Read spec frontmatter 'files' field at ${setup.specPath}.
2. FILE-EXISTENCE CHECK (deliverable guard): for each path in 'files' field, run \`ls -1 <worktree>/<path> | head -1\`. If ANY missing → return BUILD_SCHEMA with error + pushed=false + followupReviewRecommended=true.
3. PUSH: \`git push --force-with-lease origin ${setup.storyBranch}\`.
4. Get final SHA: \`git rev-parse HEAD\`.
5. Read spec frontmatter fields: followup_review_recommended, status.

RETURN BUILD_SCHEMA:
- storyKey: ${setup.storyKey}
- iteration: ${iteration}
- newSha: <final SHA>
- followupReviewRecommended: <spec frontmatter followup_review_recommended>
- specStatus: <spec frontmatter status>
- pushed: true (after successful push)
- patchesApplied, itemsDeferred, scoreFormula: parsed from spec's '## Auto Run Result' section

CONSTRAINTS:
- DO NOT run Skill: bmad-build-auto (build agent did that)
- DO NOT create MR — Phase 2 (Create MR) already created it; you just push commits to its branch
- DO NOT modify spec file other than verifying frontmatter fields
- DO NOT run format-check / linters — CI lint job handles those (workflow stays generic)`,
    { label: `postbuild-iter-${iteration}`, phase: 'Build with convergence', schema: BUILD_SCHEMA, agentType: 'general-purpose' }
  )

  if (!postBuildResult || !postBuildResult.pushed) {
    log(`Post-build failed: ${postBuildResult?.error || 'no result'}`)
    iterationsLog.push({ iter: iteration, error: `post-build: ${postBuildResult?.error || 'unknown'}` })
    followup = false
    break
  }

  iterationsLog.push({
    iter: iteration,
    sha: postBuildResult.newSha,
    followup: postBuildResult.followupReviewRecommended,
    specStatus: postBuildResult.specStatus,
    patchesApplied: postBuildResult.patchesApplied,
    itemsDeferred: postBuildResult.itemsDeferred,
  })

  lastSpecStatus = postBuildResult.specStatus
  currentSha = postBuildResult.newSha
  followup = postBuildResult.followupReviewRecommended

  if (!followup) {
    convergedSha = postBuildResult.newSha
    log(`Build converged at iter ${iteration} (no followup). Now CI gate.`)
  } else {
    log(`Iter ${iteration}: build wants followup → re-build immediately (no CI wait)`)
  }
}

if (followup) {
  log(`HIT REVIEW CAP (${maxIterations}) without convergence — ESCALATING`)
  return {
    storyKey: setup.storyKey,
    converged: false,
    iterations: iteration,
    finalSha: currentSha,
    iterationsLog,
    ciFailure,
    escalateReason: `review convergence did not complete within ${maxIterations} iterations (last failure: ${ciFailure ? `CI pipeline ${ciFailure.pipelineId} status=${ciFailure.status}` : 'followup_review_recommended=true'})`,
    worktreePath: setup.worktreePath,
    branch: setup.storyBranch,
  }
}
if (!convergedSha) {
  // Build phase exited without converging (build/post-build failure, or build set followup=false on error).
  // followup=false alone is NOT proof of convergence — escalate instead of falling through to CI gate.
  return { storyKey: setup.storyKey, converged: false, iterations: iteration, finalSha: currentSha, iterationsLog, ciFailure, escalateReason: `build phase exited without converging (last build: ${iterationsLog[iterationsLog.length-1]?.error || 'no iteration log'})`, worktreePath: setup.worktreePath, branch: setup.storyBranch };
}

// PHASE B: CI GATE — only check CI after build converges. If CI fails, re-build
// (counter ciIter). Separate budget from review iterations.
log(`Build converged at ${convergedSha}. Starting CI gate (max ${ciMaxIterations} CI-fix iterations)...`)
let ciConverged = false;
ciFailure = null;  // reset for CI loop
while (ciIter < ciMaxIterations) {
  ciIter++;
  log(`--- CI iter ${ciIter}/${ciMaxIterations} ---`)
  const ciCheck = await agent(
    `Check CI for MR !${mrResult.mrIid} (story ${setup.storyKey}, CI iter ${ciIter}).

MR was created in Phase 2 — guaranteed to exist. Use MR pipeline only.

STEPS:
1. Get latest MR pipeline: BMAD_MR_ACTION=get-mr-pipeline BMAD_MR_REPO="${setup.mrRepo}" BMAD_MR_IID=${mrResult.mrIid} Skill: bmad-issue-tracking-sync. Capture { pipeline_id, pipeline_status }.
2. Poll status: \`Bash(command="${args.helpersDir || ''}ci-monitor.sh <pipelineId> 30", run_in_background=true)\` + \`TaskOutput(block=true, timeout=1800000)\`. Read the "TERMINAL:<status>" line.
3. If status='success': return { pipelineId, status: 'success' }.
4. If status != 'success': classify failure.
   - BMAD_MR_ACTION=get-failed-jobs BMAD_MR_REPO="${setup.mrRepo}" BMAD_PIPELINE_ID=<pipeline_id> Skill: bmad-issue-tracking-sync.
   - Capture { jobs } (newline-separated TSV per common/get-failed-jobs.yaml header — each line is "name<TAB>exit_code<TAB>trace_tail"; note snake_case exit_code field, NOT camelCase exitCode).
   - Transform into failedJobs=[{name, exitCode, excerpt: trace_tail}] + traceTail=concatenated trace_tails (best-effort).
5. Return JSON: { pipelineId, status, failedJobs: [{name, exitCode, excerpt}], traceTail: <concatenated excerpts> }`,
    { label: `ci-check-${ciIter}`, phase: 'Build with convergence', schema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'integer' },
        status: { type: 'string' },
        failedJobs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, exitCode: { type: 'integer' }, excerpt: { type: 'string' } } } },
        traceTail: { type: 'string' },
      },
      required: ['status'],
    }, agentType: 'general-purpose' }
  )

  if (!ciCheck || !ciCheck.status) {
    // Network error / GitLab API down / agent timeout. Treat as WAIT (not failure).
    ciIter--  // don't consume ciMaxIterations
    ciWait++  // info counter
    if (ciWaitStartedAt && Date.now && (Date.now() - ciWaitStartedAt > CI_WAIT_MAX_MS)) {
      log(`CI check failed repeatedly (ciWait=${ciWait}, no status returned) — wait safety cap hit, escalating`)
      ciFailure = { error: 'ci_check_timeout', waitCount: ciWait }
      break
    }
    log(`CI check failed (no status — likely network/API issue), waiting (ciWait=${ciWait})`)
    continue
  }
  lastCIStatus = ciCheck.status

  if (ciCheck.status === 'success') {
    log(`CI green ✓`)
    ciConverged = true
    break
  }

  // Non-terminal CI states (created/pending/running): wait. NO budget impact.
  // ciMaxIterations is consumed only by 'failed'/'canceled' (terminal failures).
  // ciWait is an INFO counter only — GitLab manages pipeline timeouts.
  const NON_TERMINAL = new Set(['created', 'pending', 'running'])
  if (NON_TERMINAL.has(ciCheck.status)) {
    ciIter--  // non-terminal is a WAIT (info only) — does NOT consume ciMaxIterations
    ciWait++  // info counter only — no budget, just for logging
    if (ciWaitStartedAt && Date.now && (Date.now() - ciWaitStartedAt > CI_WAIT_MAX_MS)) {
      // safety: avoid infinite loop if pipeline never reaches terminal state
      log(`CI ${ciCheck.status} — wait safety cap hit (${ciWait} waits, ${Math.round((Date.now() - ciWaitStartedAt) / 60000)}min elapsed) — escalating`)
      ciFailure = { error: 'ci_wait_timeout', status: ciCheck.status, waitCount: ciWait }
      break
    }
    log(`CI ${ciCheck.status} — waiting (ciWait=${ciWait}, ciIter=${ciIter}/${ciMaxIterations})`)
    continue
  }

  // Terminal failure → record + re-build (if budget remains)
  log(`CI failed (status=${ciCheck.status}) — re-build with CI failure context`)
  ciFailure = {
    pipelineId: ciCheck.pipelineId,
    status: ciCheck.status,
    failedJobs: ciCheck.failedJobs || [],
    traceTail: (ciCheck.traceTail || '').substring(0, 3000),
  }

  if (ciIter >= ciMaxIterations) {
    log(`CI-fix budget exhausted (${ciMaxIterations}) — escalating`)
    break
  }

  // Re-build to fix CI failures (counts as a NEW REVIEW iteration)
  log(`Re-building with ciFailure context...`)
  iteration++;
  const buildResult = await dispatchViaClaudeP({
    label: `build-iter-${iteration}`,
    phase: 'Build with convergence',
    cwd: setup.worktreePath,
    prompt: `/bmad-build-auto ${setup.storyKey}

CI FAILED LAST ITER — fix it: ${JSON.stringify(ciFailure).substring(0, 1500)}

sprint-status.yaml is owned by the orchestrator: never write it, and never revert a change to it. A row at done or awaiting-operator is the orchestrator's own bookkeeping — not a defect to fix, and not proof that the work is verified.

If Skill HALTs (terminal status != done), return { skillCompleted: false, error: <halt reason> }. Otherwise { skillCompleted: true }.`,
    schema: { type: 'object', properties: { skillCompleted: { type: 'boolean' }, error: { type: 'string' } }, required: ['skillCompleted'] },
    allowedTools: 'Read,Write,Edit,Bash,Skill,Agent',
  });

  if (!buildResult || !buildResult.skillCompleted || buildResult.error) {
    log(`Re-build failed: ${buildResult?.error || 'skill did not complete'}`)
    iterationsLog.push({ iter: iteration, error: `ci-fix build: ${buildResult?.error || 'skill did not complete'}` })
    break
  }

  const postBuildResult = await agent(
    `Post-build for story ${setup.storyKey}, iter ${iteration}. Build agent already invoked Skill: bmad-build-auto and committed locally. Your job: verify deliverables + push + return BUILD_SCHEMA.

OPERATE FROM: ${setup.worktreePath} (git checkout branch ${setup.storyBranch}).

STEPS:
1. Read spec frontmatter 'files' field at ${setup.specPath}.
2. FILE-EXISTENCE CHECK (deliverable guard): for each path in 'files' field, run \`ls -1 <worktree>/<path> | head -1\`. If ANY missing → return BUILD_SCHEMA with error + pushed=false + followupReviewRecommended=true.
3. PUSH: \`git push --force-with-lease origin ${setup.storyBranch}\`.
4. Get final SHA: \`git rev-parse HEAD\`.
5. Read spec frontmatter fields: followup_review_recommended, status.

RETURN BUILD_SCHEMA:
- storyKey: ${setup.storyKey}
- iteration: ${iteration}
- newSha: <final SHA>
- followupReviewRecommended: <spec frontmatter followup_review_recommended>
- specStatus: <spec frontmatter status>
- pushed: true (after successful push)
- patchesApplied, itemsDeferred, scoreFormula: parsed from spec's '## Auto Run Result' section

CONSTRAINTS:
- DO NOT run Skill: bmad-build-auto (build agent did that)
- DO NOT create MR — Phase 2 (Create MR) already created it; you just push commits to its branch
- DO NOT modify spec file other than verifying frontmatter fields
- DO NOT run format-check / linters — CI lint job handles those (workflow stays generic)`,
    { label: `postbuild-iter-${iteration}`, phase: 'Build with convergence', schema: BUILD_SCHEMA, agentType: 'general-purpose' }
  );

  if (!postBuildResult || !postBuildResult.pushed) {
    log(`Post-build (CI-fix) failed: ${postBuildResult?.error || 'no result'}`)
    iterationsLog.push({ iter: iteration, error: `post-build (ci-fix): ${postBuildResult?.error || 'unknown'}` })
    break
  }

  iterationsLog.push({
    iter: iteration,
    sha: postBuildResult.newSha,
    followup: postBuildResult.followupReviewRecommended,
    specStatus: postBuildResult.specStatus,
    patchesApplied: postBuildResult.patchesApplied,
    itemsDeferred: postBuildResult.itemsDeferred,
  })
  lastSpecStatus = postBuildResult.specStatus
  currentSha = postBuildResult.newSha

  // After re-build, loop back to top of CI gate to re-check CI
  log(`Re-build pushed at ${postBuildResult.newSha}. Looping back to CI check.`)
}

if (!ciConverged) {
  log(`CI gate FAILED after ${ciIter} CI-fix iterations — escalating`)
  return {
    storyKey: setup.storyKey,
    converged: false,
    iterations: iteration,
    ciIterations: ciIter,
    finalSha: currentSha,
    iterationsLog,
    ciFailure,
    escalateReason: `CI gate failed after ${ciIter} iterations (last status: ${lastCIStatus || 'unknown'})`,
    worktreePath: setup.worktreePath,
    branch: setup.storyBranch,
  }
}

log(`Story ${setup.storyKey} converged at ${convergedSha} (${iteration} review iter + ${ciIter} CI iter) — CI green`)

// ============================================================================
// PHASE 4: AUTO-MERGE
// ============================================================================
phase('Auto-merge')
let mergeResult = null;
// lastCIStatus was set inside the convergence loop (Phase 3). The merged
// Push&MR+Monitor agent is gone — the loop's CI check is the SOLE source
// of CI verdict now. If lastCIStatus is null, the loop never reached the
// CI check (push failed, build was treated as converged without CI).
//
// Auto-merge GUARD: skip merge when spec status indicates human action
// required or unresolved blocker. awaiting-operator = partial completion
// (buy domain, grant API key); blocked = skill flagged an issue.
const SPEC_STATUSES_BLOCKING_MERGE = new Set(['awaiting-operator', 'blocked']);
const canAutoMerge = lastCIStatus === 'success'
  && !SPEC_STATUSES_BLOCKING_MERGE.has(lastSpecStatus);
if (canAutoMerge) {
  log(`Auto-merging MR !${mrResult.mrIid} (CI green, spec status: ${lastSpecStatus})...`)
  mergeResult = await agent(
    `Merge MR !${mrResult.mrIid} for story ${setup.storyKey}, then sync sprint-status to done.

CONTEXT:
- prdWorktreePath: ${setup.prdWorktreePath}  (worktree on ${setup.baseBranch} — operate from here for sprint-status)
- sprintStatusPath: ${setup.sprintStatusPath}
- baseBranch: ${setup.baseBranch}
- mrRepo: ${setup.mrRepo}  (host/project from _bmad/custom/issue-tracking.yaml — the Skill routing uses this, NOT gitlabHost)
- storyKey: ${setup.storyKey}

STEPS:
1. Merge: BMAD_MR_ACTION=merge-mr BMAD_MR_REPO="${setup.mrRepo}" BMAD_MR_IID=${mrResult.mrIid} BMAD_MR_SQUASH=false Skill: bmad-issue-tracking-sync.
   Capture { merged, merge_sha, error }. If merged=false, set merged=false with error string.
2. After successful merge, sync sprint-status to done. Operate from the PRD worktree (${setup.prdWorktreePath}).
   - cd ${setup.prdWorktreePath}
   - Read ${setup.sprintStatusPath}.
   - Update development_status[${setup.storyKey}] = done.
   - Update last_updated to "${timestamp}".
   - \`git add ${setup.sprintStatusPath} && git commit -m "chore(sprint-status): story ${setup.storyKey} → done (MR !${mrResult.mrIid} merged)" && git push origin ${setup.baseBranch}\`
   - sprintStatusDone = true only if push succeeded.

Note: when invoked from bmad-prd-orchestrate, the orchestrator may re-apply the done transition in Phase 4. sprint_plan.py advance is idempotent (never-regress), so a redundant write is a no-op. The merge agent here is the SOLE WRITER for standalone (non-orchestrator) invocations.

RETURN MERGE_SCHEMA (storyKey, mrIid, merged, sprintStatusDone, error?).`,
    { label: `merge-${setup.storyKey}`, phase: 'Auto-merge', schema: MERGE_SCHEMA, agentType: 'general-purpose' }
  )
} else {
  const reason = !lastSpecStatus || !SPEC_STATUSES_BLOCKING_MERGE.has(lastSpecStatus)
    ? `CI ${lastCIStatus || 'NOT CHECKED'}`
    : `spec status "${lastSpecStatus}" (human action required or unresolved blocker)`;
  log(`${reason} — NOT auto-merging. Manual review needed.`)
  mergeResult = { storyKey: setup.storyKey, mrIid: mrResult.mrIid, merged: false, sprintStatusDone: false, error: reason }
}

log(`Merge: ${mergeResult.merged ? 'OK' : 'SKIPPED'} | Sprint-status: ${mergeResult.sprintStatusDone ? 'done' : 'pending'}`)

// ============================================================================
// PHASE 5: CLEANUP
// ============================================================================
phase('Cleanup')
log(`Cleaning up worktree ${setup.worktreePath}, branch ${setup.storyBranch} (merged=${mergeResult?.merged})...`)
const cleanup = await agent(
  `Cleanup bmad-build artifacts for story ${setup.storyKey}.

CONTEXT:
- repoRoot: ${setup.repoRoot}
- prdWorktreePath: ${setup.prdWorktreePath}
- worktreePath: ${setup.worktreePath}
- storyBranch: ${setup.storyBranch}
- mergeResult.merged: ${mergeResult?.merged === true}  ← CRITICAL: only delete worktree/branch if true

WORKING FROM: ${setup.repoRoot} (the bare git root — worktree commands work from here).

STEPS:
0. IF mergeResult.merged === true (MR successfully merged into prd branch):
   1a. Remove story worktree:
       \`git worktree remove --force ${setup.worktreePath}\`
       If already removed (MR --remove-source-branch cleaned it), skip silently.
   1b. Delete local branch if it still exists:
       \`git branch -D ${setup.storyBranch}\` (errors if missing — ignore).
   1c. Prune remote refs:
       \`git remote prune origin\`
   ELSE (merge failed, skipped, or story deferred):
   - DO NOT delete the worktree or branch — keep them for retry.
   - Report keptWorktrees=[worktreePath], keptBranches=[storyBranch] in the return.
1. ALWAYS (regardless of merge status):
   Remove orchestrator log files in ${setup.prdWorktreePath}/_bmad-output/implementation-artifacts/ matching pattern bmad-build-auto-result-*${setup.storyKey}* (only those for the just-completed story). These are always safe to remove because they're regenerated on retry.
2. Return CLEANUP_SCHEMA with:
   - removedWorktrees: [paths deleted, or empty]
   - deletedBranches: [names deleted, or empty]
   - keptWorktrees: [paths kept, or empty]
   - keptBranches: [names kept, or empty]
   - prunedRefs: count
   - removedLogs: [file paths deleted]
   - errors: [any error strings]

DO NOT remove files outside _bmad-output/.
DO NOT touch sprint-status.yaml or the spec file (those are tracked artifacts).
`,
  { label: `cleanup-${setup.storyKey}`, phase: 'Cleanup', schema: CLEANUP_SCHEMA, agentType: 'general-purpose' }
)

log(`Cleanup: worktrees=${cleanup.removedWorktrees.length} branches=${cleanup.deletedBranches.length} pruned=${cleanup.prunedRefs} logs=${cleanup.removedLogs.length}`)

// ============================================================================
// RETURN
// ============================================================================
return {
  storyKey: setup.storyKey,
  converged: true,
  iterations: iteration,
  finalSha: convergedSha,
  iterationsLog,
  setup: {
    repoRoot: setup.repoRoot,
    prdWorktreePath: setup.prdWorktreePath,
    prdKey: setup.prdKey,
    baseBranch: setup.baseBranch,
    storyBranch: setup.storyBranch,
    worktreePath: setup.worktreePath,
    baselineSha: setup.baselineSha,
  },
  mr: { mrIid: mrResult.mrIid, mrUrl: mrResult.mrUrl, pipelineId: mrResult.pipelineId },
  monitor: { status: lastCIStatus, retries: iteration > 1 ? iteration - 1 : 0, transient: false, failedJobs: ciFailure?.failedJobs || [] },
  merge: { merged: mergeResult.merged, sprintStatusDone: mergeResult.sprintStatusDone, error: mergeResult.error },
  cleanup: { worktrees: cleanup.removedWorktrees, branches: cleanup.deletedBranches, errors: cleanup.errors },
}

};

await main();
