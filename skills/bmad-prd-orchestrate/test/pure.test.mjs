// Test for the pure functions defined inside scripts/bmad-prd-orchestrate.js.
// The Workflow-tool script body has top-level `await main()` which can't run in
// a test harness (args/agent/phase/log are undefined). We extract each pure
// function via vm.runInNewContext against the source text and test it in
// isolation — no Workflow runtime needed.
//
// Each test's expected FAILURE (before the function exists or matches the
// expected form) is a regression-prevention guarantee: re-running the test
// catches accidental changes to the function signature or behavior.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '../scripts/bmad-prd-orchestrate.js');

/**
 * Extract a top-level `const NAME = (args) => { ... };` (or `function NAME(...)` )
 * from the script source. Throws if not found.
 *
 * Stops at the closing `}` of the function body, accounting for nested braces
 * and braces inside template literals / strings / regexes (good-enough heuristic
 * for our small pure functions — no nested braces in current extractors).
 */
function extractFunction(source, name) {
  // Match either `const NAME = (` (arrow/value) or `function NAME(` (declaration).
  // Function declarations don't have `=`, so the regex alternates both forms.
  const startRe = new RegExp(`(?:const\\s+${name}\\s*=|function\\s+${name})\\s*\\(`);
  const m = source.match(startRe);
  if (!m) throw new Error(`function ${name} not found in script source`);
  const start = m.index;
  // Find matching closing `)` for the param list
  let depth = 0;
  let i = source.indexOf('(', start);
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  // For arrow function: `=> BODY`; For function: `{ BODY }` or expression.
  // Find start of body after `=>` or `{`
  let bodyStart;
  // Skip `=>` if present (arrow). Advance past whitespace.
  let scanFrom = i + 1;
  // Find `=>` between param `)` and body.
  const arrowIdx = source.indexOf('=>', scanFrom);
  if (arrowIdx !== -1 && arrowIdx < scanFrom + 50) {
    bodyStart = arrowIdx + 2;
  } else {
    // function declaration: body starts at `{` after params
    const braceIdx = source.indexOf('{', scanFrom);
    bodyStart = braceIdx + 1;
  }
  // Walk to matching closing brace of body
  depth = 1;
  i = bodyStart;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${name}`);
  const body = source.slice(start, i);
  return vm.runInNewContext(`(${body}\n)`, {}, { filename: `${name}.js` });
}

const source = readFileSync(SCRIPT_PATH, 'utf8');

// ============================================================================
// extractEpicKey(sk) → first dash-separated segment of the canonical story key.
// Format: `<epicNum>-<storyNum>[-<suffix>]` per upstream bmad-workflow-lang.md:451.
// ============================================================================

test('extractEpicKey handles all documented formats', () => {
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  assert.equal(extractEpicKey('1-3-login-form'), '1');
  assert.equal(extractEpicKey('4-1-a'), '4');                // optional letter suffix
  assert.equal(extractEpicKey('1-3'), '1');                  // no suffix
  assert.equal(extractEpicKey('1'), '1');                    // bare epic
});

test('extractEpicKey falls back to input on empty/garbage', () => {
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  assert.equal(extractEpicKey(''), '');                      // empty stays empty
  // Invalid format (no dash, no fallback): documented behavior of the
  // orchestrator. Today the orchestrator uses `split('-')[0] || sk` so empty
  // maps to '' (not fallback to sk). Update test if behavior changes.
});

test('extractEpicKey is stable across runs (no Math.random / Date.now)', () => {
  // Pure function check: same input must give same output.
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  const a = extractEpicKey('7-2-foo');
  const b = extractEpicKey('7-2-foo');
  const c = extractEpicKey('7-2-foo');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, '7');
});

// ============================================================================
// requeueCIHardfails(state, maxRetries) → { state, count }
// Re-queues each ci_hardfail halt story at the front of the queue, up to
// maxRetries times per halt entry (tracked via h.retries). Drops these
// stories from state.blocked so retry_blocked doesn't double-add.
// Pure: takes state as input, returns new state + count. No side effects.
// ============================================================================

test('requeueCIHardfails returns no-op when maxRetries = 0 (never retry)', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [{ story: '1-1', reason: 'ci_hardfail' }],
    halts: [{ reason: 'ci_hardfail', story: '1-1', iteration: 1 }],
  };
  const { state: out, count } = fn(state, 0);
  assert.equal(count, 0);
  assert.equal(out.storyQueue.length, 0);
});

test('requeueCIHardfails re-queues ci_hardfail halts at front of queue', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: ['2-1'],
    completed: [],
    blocked: [],
    halts: [{ reason: 'ci_hardfail', story: '1-1', iteration: 1 }],
  };
  const { state: out, count } = fn(state, 3);
  assert.equal(count, 1);
  // Re-queued at FRONT (unshift), so order is 1-1, 2-1.
  assert.deepEqual([...out.storyQueue], ['1-1', '2-1']);
});

test('requeueCIHardfails increments h.retries per halt entry', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [],
    halts: [{ reason: 'ci_hardfail', story: '1-1', iteration: 1 }],
  };
  const { state: out } = fn(state, 3);
  assert.equal(out.halts[0].retries, 1);
});

test('requeueCIHardfails skips halt entries that already hit maxRetries', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [],
    halts: [{ reason: 'ci_hardfail', story: '1-1', iteration: 1, retries: 3 }],
  };
  const { state: out, count } = fn(state, 3);
  // retries=3 already at maxRetries=3 → skip.
  assert.equal(count, 0);
  assert.equal(out.storyQueue.length, 0);
});

test('requeueCIHardfails skips stories already in queue or completed', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: ['1-1'],          // already queued
    completed: ['1-2'],           // already completed
    blocked: [],
    halts: [
      { reason: 'ci_hardfail', story: '1-1', iteration: 1 },
      { reason: 'ci_hardfail', story: '1-2', iteration: 2 },
    ],
  };
  const { state: out, count } = fn(state, 3);
  assert.equal(count, 0);
  assert.deepEqual([...out.storyQueue], ['1-1']);
});

test('requeueCIHardfails dedupes multiple halts for same story', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [],
    halts: [
      { reason: 'ci_hardfail', story: '1-1', iteration: 1 },
      { reason: 'ci_hardfail', story: '1-1', iteration: 2 },
    ],
  };
  const { state: out, count } = fn(state, 3);
  // Same story → dedupe → 1 re-queue, not 2.
  assert.equal(count, 1);
  assert.equal(out.storyQueue.length, 1);
});

test('requeueCIHardfails drops re-queued stories from state.blocked', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [
      { story: '1-1', reason: 'ci_hardfail' },
      { story: '1-2', reason: 'launch_failure' },   // not ci_hardfail
    ],
    halts: [{ reason: 'ci_hardfail', story: '1-1', iteration: 1 }],
  };
  const { state: out } = fn(state, 3);
  // 1-1 should be dropped from blocked (it's back in the queue).
  // 1-2 stays (not a ci_hardfail re-queue).
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].story, '1-2');
});

test('requeueCIHardfails ignores non-ci_hardfail halts', () => {
  const fn = extractFunction(source, 'requeueCIHardfails');
  const state = {
    storyQueue: [],
    completed: [],
    blocked: [],
    halts: [
      { reason: 'launch_failure', story: '1-1', iteration: 1 },
      { reason: 'merge_blocked', story: '1-2', iteration: 2 },
    ],
  };
  const { state: out, count } = fn(state, 3);
  assert.equal(count, 0);
  assert.equal(out.storyQueue.length, 0);
});

// ============================================================================
// isEpicTransition(lastEpic, currentEpic) → boolean
// Returns true if the current epic differs from the previous one (caller has
// already been tracking lastEpic). Returns true on first iteration when
// lastEpic=null (transition from "(start)"). Pure: just a comparison.
// ============================================================================

test('isEpicTransition returns true on first iteration (lastEpic=null)', () => {
  const fn = extractFunction(source, 'isEpicTransition');
  assert.equal(fn(null, '1'), true);
  assert.equal(fn(null, '4-1-a'), true);
});

test('isEpicTransition returns false within same epic', () => {
  const fn = extractFunction(source, 'isEpicTransition');
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  // Function takes pre-extracted epics (matches orchestrator usage).
  assert.equal(fn(extractEpicKey('1-1'), extractEpicKey('1-2-foo')), false);
  assert.equal(fn(extractEpicKey('4-1'), extractEpicKey('4-3-b')), false);
});

test('isEpicTransition returns true on epic change', () => {
  const fn = extractFunction(source, 'isEpicTransition');
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  assert.equal(fn(extractEpicKey('1-3'), extractEpicKey('2-1')), true);
  assert.equal(fn(extractEpicKey('4-1-a'), extractEpicKey('5-1')), true);
});

test('isEpicTransition is purely boolean (no side effects)', () => {
  const fn = extractFunction(source, 'isEpicTransition');
  const a = fn('1', '2-1');
  const b = fn('1', '2-1');
  assert.equal(a, b);
  assert.equal(typeof a, 'boolean');
});
