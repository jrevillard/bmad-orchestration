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

test('toRepoRelativePath handles empty specPath', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  assert.equal(fn('', '/wt', '/repo'), '');
});

test('toRepoRelativePath handles empty specPath', () => {
  const fn = extractFunction(source, 'toRepoRelativePath');
  assert.equal(fn('', '/wt', '/repo'), '');
});

test('toRepoRelativePath handles empty specPath', () => {
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
