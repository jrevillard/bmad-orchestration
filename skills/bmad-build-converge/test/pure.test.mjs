// Test for pure functions defined inside scripts/bmad-build-converge.js.
// Same vm-based extraction pattern as bmad-prd-orchestrate's test suite —
// Workflow-tool scripts can't be imported (top-level `await main()`), so we
// extract each named function via vm.runInNewContext and unit-test in isolation.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '../scripts/bmad-build-converge.js');

/**
 * Extract a top-level `const NAME = (args) => { ... }` (arrow) or
 * `function NAME(args) { ... }` (declaration) from the script source. Throws
 * if not found.
 */
function extractFunction(source, name) {
  const startRe = new RegExp(`(?:const\\s+${name}\\s*=|function\\s+${name})\\s*\\(`);
  const m = source.match(startRe);
  if (!m) throw new Error(`function ${name} not found in script source`);
  const start = m.index;
  let depth = 0; let i = source.indexOf('(', start);
  for (; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') { depth--; if (depth === 0) break; }
  }
  let bodyStart;
  const arrowIdx = source.indexOf('=>', i + 1);
  if (arrowIdx !== -1 && arrowIdx < i + 50) bodyStart = arrowIdx + 2;
  else { const braceIdx = source.indexOf('{', i + 1); bodyStart = braceIdx + 1; }
  depth = 1; i = bodyStart;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${name}`);
  const body = source.slice(start, i);
  return vm.runInNewContext(`(${body}\n)`, {}, { filename: `${name}.js` });
}

const source = readFileSync(SCRIPT_PATH, 'utf8');

// ============================================================================
// base64Encode(input) → string
// Pure-JS UTF-8 → base64 encoder. Workflow scripts lack `Buffer` and `btoa`,
// so this is the canonical implementation. Pure: input string → output
// string, no side effects.
// ============================================================================

test('base64Encode encodes ASCII', () => {
  const fn = extractFunction(source, 'base64Encode');
  assert.equal(fn(''), '');
  assert.equal(fn('a'), 'YQ==');
  assert.equal(fn('hello'), 'aGVsbG8=');
  assert.equal(fn('hello world'), 'aGVsbG8gd29ybGQ=');
});

test('base64Encode encodes UTF-8 multi-byte sequences', () => {
  const fn = extractFunction(source, 'base64Encode');
  // "héllo" → 5 chars, 6 bytes (é is 2 bytes in UTF-8)
  assert.equal(fn('héllo'), 'aMOpbGxv');
  // "日本語" → 3 chars, 9 bytes (each is 3 bytes)
  assert.equal(fn('日本語'), '5pel5pys6Kqe');
});

test('base64Encode handles boundary lengths', () => {
  const fn = extractFunction(source, 'base64Encode');
  // 1-byte input → 4 chars with 2 padding '='
  assert.equal(fn('a'), 'YQ==');
  // 2-byte input → 4 chars with 1 padding '='
  assert.equal(fn('ab'), 'YWI=');
  // 3-byte input → 4 chars, no padding
  assert.equal(fn('abc'), 'YWJj');
});

test('base64Encode round-trips with atob equivalent', () => {
  const fn = extractFunction(source, 'base64Encode');
  // Compare against Node.js Buffer (UTF-8 → base64).
  const samples = ['', 'x', 'xy', 'xyz', 'xyzw', 'hello world', 'café', '🚀 launch'];
  for (const s of samples) {
    const expected = Buffer.from(s, 'utf8').toString('base64');
    assert.equal(fn(s), expected, `mismatch for ${JSON.stringify(s)}`);
  }
});

// ============================================================================
// toRepoRelativePath(specPath, worktreePath, repoRoot) → string
// Strips the worktree path prefix (preferred) or repo root prefix (fallback)
// from specPath to produce a portable, repo-root-relative path for the MR
// description. Pure: string manipulation, no side effects.
// ============================================================================

test('toRepoRelativePath strips worktree prefix', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  assert.equal(fn('/home/jerome/proj/.worktrees/feat-1-prd/_bmad-output/implementation-artifacts/stories/1-1-test.md', '/home/jerome/proj/.worktrees/feat-1-prd', '/home/jerome/proj'), '_bmad-output/implementation-artifacts/stories/1-1-test.md');
});

test('toRepoRelativePath strips repo root prefix as fallback', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // Worktree doesn't match → fall back to repo root.
  assert.equal(fn('/home/jerome/proj/_bmad-output/foo.md', '/different/worktree', '/home/jerome/proj'), '_bmad-output/foo.md');
});

test('toRepoRelativePath returns specPath when neither prefix matches', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // Neither worktree nor repo root prefix matches → return as-is (defensive).
  assert.equal(fn('/elsewhere/path.md', '/wt', '/repo'), '/elsewhere/path.md');
});

test('toRepoRelativePath prefers worktree over repo root when both match', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // Worktree is a sub-path of repo root → worktree prefix should strip first.
  // Worktree prefix wins when it matches; repo root fallback doesn't run.
  assert.equal(fn('/home/jerome/proj/.wt/_bmad/x.md', '/home/jerome/proj/.wt', '/home/jerome/proj'), '_bmad/x.md');
});

test('toRepoRelativePath uses repo root when worktree does NOT match', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // Spec is inside repo root but NOT inside worktree → repo root fallback.
  assert.equal(fn('/home/jerome/proj/_bmad-output/x.md', '/home/jerome/proj/.wt', '/home/jerome/proj'), '_bmad-output/x.md');
});

test('toRepoRelativePath handles empty/falsy specPath', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // specPath is falsy → returns '' (defensive guard at return).
  assert.equal(fn(null, '/wt', '/repo'), '');
  assert.equal(fn(undefined, '/wt', '/repo'), '');
  assert.equal(fn('', '/wt', '/repo'), '');
});

test('toRepoRelativePath uses repo root when worktree is empty', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  // worktreePath empty → skips worktree check, tries repo root. specPath is
  // inside repo root → strips it. (Old buggy code returned the path unchanged;
  // fixed to actually use the repo root fallback when worktree is unavailable.)
  assert.equal(fn('/home/repo/_bmad/x.md', '', '/home/repo'), '_bmad/x.md');
});

// ============================================================================
// formatMRDescriptionPlaceholder(storyKey) → string
// Pure: returns the placeholder body written to the MR description file when
// the spec doesn't exist at MR-create time (normal case — bmad-build-auto
// creates the spec during Build, post-MR-create). Reviewers see this until
// the full spec is pushed (post-build, after bmad-build-auto's spec commit).
// ============================================================================

test('formatMRDescriptionPlaceholder has required structure', () => {
  const fn = extractFunction(source, 'formatMRDescriptionPlaceholder');
  const out = fn('1-3-login-form');
  // YAML frontmatter delimiters so platforms render it as a collapsible.
  assert.match(out, /^---\n/);
  assert.match(out, /\n---\n?$/);
  // References story key + spec path so reviewers know where the real spec lives.
  assert.match(out, /Story 1-3-login-form/);
  assert.match(out, /1-3-login-form\.md/);
  assert.match(out, /_bmad-output\/implementation-artifacts\/stories/);
});

test('formatMRDescriptionPlaceholder handles kebab-suffix story keys', () => {
  const fn = extractFunction(source, 'formatMRDescriptionPlaceholder');
  const out = fn('3-4-automatic-department-routing');
  assert.match(out, /Story 3-4-automatic-department-routing/);
  assert.match(out, /3-4-automatic-department-routing\.md/);
});

// ============================================================================
// shouldAcceptStoryStatus(status) → boolean
// Guard for converge setup: only certain statuses allow setup to proceed.
// Accept: backlog (no spec yet — bmad-build-auto will create), ready-for-dev
// (spec committed, ready to implement), in-progress (resume), review
// (re-attempting after review). Reject: done, awaiting-operator, blocked.
// Pure: single-status decision, no Workflow globals.
// ============================================================================

test('shouldAcceptStoryStatus accepts the 4 documented statuses', () => {
  const fn = extractFunction(source, 'shouldAcceptStoryStatus');
  assert.equal(fn('backlog'), true);
  assert.equal(fn('ready-for-dev'), true);
  assert.equal(fn('in-progress'), true);
  assert.equal(fn('review'), true);
});

test('shouldAcceptStoryStatus rejects terminal/deferred statuses', () => {
  const fn = extractFunction(source, 'shouldAcceptStoryStatus');
  assert.equal(fn('done'), false);
  assert.equal(fn('awaiting-operator'), false);
  assert.equal(fn('blocked'), false);
});

test('shouldAcceptStoryStatus rejects unknown statuses (defensive)', () => {
  const fn = extractFunction(source, 'shouldAcceptStoryStatus');
  // Unknown status (typo, custom status) → reject (don't risk starting work on
  // a story we don't understand).
  assert.equal(fn('in_progress'), false);    // underscore variant — different
  assert.equal(fn('reviewing'), false);
  assert.equal(fn(''), false);
  assert.equal(fn(undefined), false);
});

// ============================================================================
// buildDispatchMarker(storyKey, dispatchSeq) → string
// Builds the per-dispatch marker used to disambiguate concurrent dispatches.
// Pure: input string + number → marker string. Sanitizes storyKey by
// replacing non-alphanumeric chars with `_` so the marker is shell-safe.
// ============================================================================

test('buildDispatchMarker produces unique markers per dispatchSeq', () => {
  const fn = extractFunction(source, 'buildDispatchMarker');
  assert.notEqual(fn('1-1', 1), fn('1-1', 2));
  assert.notEqual(fn('1-1', 100), fn('2-1', 100));
});

test('buildDispatchMarker preserves alphanumerics, dashes, underscores', () => {
  const fn = extractFunction(source, 'buildDispatchMarker');
  const m = fn('1-3-login_form', 1);
  assert.match(m, /^BMADBC_1-3-login_form_1$/);
});

test('buildDispatchMarker sanitizes unsafe shell chars to _', () => {
  const fn = extractFunction(source, 'buildDispatchMarker');
  // Story keys with dots, slashes, or other shell-special chars → sanitized.
  // Use a clearly unsafe char that REPLACE in the function actually targets.
  assert.match(fn('1.3-foo', 1), /^BMADBC_1_3-foo_1$/);
  assert.match(fn('1/3-foo', 1), /^BMADBC_1_3-foo_1$/);
});

test('buildDispatchMarker uses BMADBC prefix (orchestrator convention)', () => {
  const fn = extractFunction(source, 'buildDispatchMarker');
  // Marker prefix identifies orchestrator-owned temp files in /tmp.
  assert.match(fn('any-key', 0), /^BMADBC_/);
});

// ============================================================================
// parseDispatchEnvelope(stdoutText) → { structured_output } | { error }
// Parses claude -p --output-format stream-json output. Returns the
// structured_output from the last `result` event, or { error } if no
// envelope is found. Handles NDJSON (multi-line), single-object JSON,
// and JSON-array forms (backward compat). Pure: string in, object out.
// ============================================================================

test('parseDispatchEnvelope parses NDJSON — finds last result event', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const stdout = [
    JSON.stringify({ type: 'system', message: 'starting' }),
    JSON.stringify({ type: 'assistant', message: { content: 'thinking' } }),
    JSON.stringify({ type: 'result', structured_output: { foo: 'bar' } }),
  ].join('\n');
  const out = fn(stdout);
  // Spread to clone into host Array.prototype (vm sandbox Array.prototype differs).
  assert.deepEqual({...out}, { foo: 'bar' });
});

test('parseDispatchEnvelope prefers last result event over earlier ones', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const stdout = [
    JSON.stringify({ type: 'result', structured_output: { first: true } }),
    JSON.stringify({ type: 'system', message: 'still going' }),
    JSON.stringify({ type: 'result', structured_output: { second: true } }),
  ].join('\n');
  const out = fn(stdout);
  assert.deepEqual({...out}, { second: true });
});

test('parseDispatchEnvelope accepts events with structured_output directly (no type field)', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const stdout = JSON.stringify({ structured_output: { x: 1 } });
  const out = fn(stdout);
  assert.deepEqual({...out}, { x: 1 });
});

test('parseDispatchEnvelope handles single-object JSON (no newlines)', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const out = fn(JSON.stringify({ structured_output: { ok: true } }));
  assert.deepEqual({...out}, { ok: true });
});

test('parseDispatchEnvelope handles JSON-array form (backward compat)', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const arr = [
    { type: 'system', message: 'init' },
    { type: 'result', structured_output: { fromArray: true } },
  ];
  const out = fn(JSON.stringify(arr));
  assert.deepEqual({...out}, { fromArray: true });
});

test('parseDispatchEnvelope strips trailing EXIT_CODE= marker', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  // Wrapper bash script may append `EXIT_CODE=0` after the JSON.
  const stdout = JSON.stringify({ structured_output: { ok: true } }) + '\nEXIT_CODE=0';
  const out = fn(stdout);
  assert.deepEqual({...out}, { ok: true });
});

test('parseDispatchEnvelope returns error when no envelope found', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const out = fn('just plain text with no json');
  assert.ok(out.error, 'expected error');
  assert.match(out.error, /missing structured_output/);
});

test('parseDispatchEnvelope returns error on empty input', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  const out = fn('');
  assert.ok(out.error);
});

test('parseDispatchEnvelope skips non-JSON lines in NDJSON', () => {
  const fn = extractFunction(source, 'parseDispatchEnvelope');
  // Mixed garbage + valid JSON lines.
  const stdout = [
    'garbage line that is not JSON',
    '',
    JSON.stringify({ type: 'result', structured_output: { survived: true } }),
  ].join('\n');
  const out = fn(stdout);
  assert.deepEqual({...out}, { survived: true });
});

// ============================================================================
// buildMergeCheckCommand(setup) → string
// Returns the bash command to check if origin/<storyBranch> is an ancestor
// of origin/<baseBranch> (i.e. branch was merged into base). Caller executes
// via dispatchViaClaudeP. Pure: string construction, no I/O.
// ============================================================================

test('buildMergeCheckCommand includes merge-base --is-ancestor check', () => {
  const fn = extractFunction(source, 'buildMergeCheckCommand');
  const cmd = fn({
    baseBranch: 'feat/test-loop-v2/prd',
    storyBranch: 'feat/test-loop-v2/1-2-add-pyproject-toml',
    prdWorktreePath: '/home/user/prd-worktree',
  });
  assert.match(cmd, /merge-base --is-ancestor/);
  assert.match(cmd, /origin\/feat\/test-loop-v2\/1-2-add-pyproject-toml/);
  assert.match(cmd, /origin\/feat\/test-loop-v2\/prd/);
  assert.match(cmd, /echo MERGED \|\| echo OPEN/);
});

test('buildMergeCheckCommand returns empty string if baseBranch missing', () => {
  const fn = extractFunction(source, 'buildMergeCheckCommand');
  assert.equal(fn({ storyBranch: 'feat/x' }), '');
  assert.equal(fn({ baseBranch: '', storyBranch: 'feat/x' }), '');
  assert.equal(fn(null), '');
});

test('buildMergeCheckCommand falls back to repoRoot when prdWorktreePath missing', () => {
  const fn = extractFunction(source, 'buildMergeCheckCommand');
  const cmd = fn({
    baseBranch: 'main',
    storyBranch: 'feat/x',
    repoRoot: '/home/user/repo',
  });
  // Should use repoRoot as the cwd for git commands.
  assert.match(cmd, /git -C '\/home\/user\/repo'/);
});

// ============================================================================
// shouldShortCircuitOnAlreadyMerged(stdout) → boolean
// Pure decision: true iff stdout is exactly 'MERGED' (trimmed). Used by
// build-converge's early-return-when-already-merged path. Extracted so the
// agent()-call path can be unit-tested without mocking the Workflow
// runtime. Tests cover all the edge cases the reviewer flagged.
// ============================================================================

test('shouldShortCircuitOnAlreadyMerged returns true for exact MERGED', () => {
  const fn = extractFunction(source, 'shouldShortCircuitOnAlreadyMerged');
  assert.equal(fn('MERGED'), true);
});

test('shouldShortCircuitOnAlreadyMerged is case-insensitive (LLM may normalize case)', () => {
  const fn = extractFunction(source, 'shouldShortCircuitOnAlreadyMerged');
  assert.equal(fn('merged'), true);
  assert.equal(fn('Merged'), true);
  assert.equal(fn('MERGED'), true);
});

test('shouldShortCircuitOnAlreadyMerged returns false for OPEN', () => {
  const fn = extractFunction(source, 'shouldShortCircuitOnAlreadyMerged');
  assert.equal(fn('OPEN'), false);
  assert.equal(fn('OPEN\n'), false);
});

test('shouldShortCircuitOnAlreadyMerged returns false for non-string inputs (the crash case)', () => {
  const fn = extractFunction(source, 'shouldShortCircuitOnAlreadyMerged');
  // These are the exact shapes that crashed build-converge pre-fix
  // (when dispatchViaClaudeP without schema returned {error: '...'}).
  // After the fix (agent() with schema + shouldShortCircuitOnAlreadyMerged
  // guard), these all return false → no short-circuit → fall through.
  assert.equal(fn(undefined), false);
  assert.equal(fn(null), false);
  assert.equal(fn({ stdout: 'MERGED' }), false);  // object, not string
  assert.equal(fn({ error: 'claude -p envelope missing structured_output' }), false);
  assert.equal(fn(123), false);
  assert.equal(fn(true), false);
  assert.equal(fn(''), false);
});
