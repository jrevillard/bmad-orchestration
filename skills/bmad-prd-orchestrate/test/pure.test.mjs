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
function extractFunction(source, name, deps = []) {
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
  // `deps` names sibling top-level functions the extracted one calls. Production
  // code composes helpers (renderSpecDiscovery → specPathCandidates →
  // extractStoryId) and a bare vm context has none of them, so extract them too
  // and inject as globals. Prefer this over inlining a rule just to stay
  // extractable — the same option exists in the converge suite's harness.
  const ctx = {};
  for (const dep of deps) ctx[dep] = extractFunction(source, dep);
  return vm.runInNewContext(`(${body}\n)`, ctx, { filename: `${name}.js` });
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

test('extractEpicKey falls back to sk when no dash', () => {
  const fn = extractFunction(source, 'extractEpicKey');
  // Bare key like '1' (no dash, no suffix) → returns the key itself.
  assert.equal(fn('1'), '1');
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

test('isEpicTransition returns boolean type', () => {
  const fn = extractFunction(source, 'isEpicTransition');
  const extractEpicKey = extractFunction(source, 'extractEpicKey');
  assert.equal(typeof fn(null, extractEpicKey('1-1')), 'boolean');
  assert.equal(typeof fn(extractEpicKey('1-1'), extractEpicKey('1-2')), 'boolean');
  assert.equal(typeof fn(extractEpicKey('1-1'), extractEpicKey('2-1')), 'boolean');
});

// ============================================================================
// shouldHaltAtEpicTransition(hitlEveryEpic, lastEpic, currentEpic) → boolean
// Combines the hitlEveryEpic flag with the transition check. Halts at epic
// boundary ONLY when (a) the operator opted in to epic-boundary halts AND
// (b) the epic is actually changing (not the first iteration where
// lastEpic=null). Pure decision.
// ============================================================================

test('shouldHaltAtEpicTransition halts on transition when flag is on', () => {
  const fn = extractFunction(source, 'shouldHaltAtEpicTransition');
  assert.equal(fn(true, '1', '2'), true);
  assert.equal(fn(true, '4', '5'), true);
});

test('shouldHaltAtEpicTransition does NOT halt on first iteration even with flag on', () => {
  const fn = extractFunction(source, 'shouldHaltAtEpicTransition');
  // lastEpic=null → no transition from a real previous epic → don't halt.
  assert.equal(fn(true, null, '1'), false);
  assert.equal(fn(true, null, '4'), false);
});

test('shouldHaltAtEpicTransition does NOT halt within same epic', () => {
  const fn = extractFunction(source, 'shouldHaltAtEpicTransition');
  assert.equal(fn(true, '1', '1'), false);
  assert.equal(fn(true, '4', '4'), false);
});

test('shouldHaltAtEpicTransition does NOT halt when flag is off', () => {
  const fn = extractFunction(source, 'shouldHaltAtEpicTransition');
  // Even on transition, no halt if operator didn't opt in.
  assert.equal(fn(false, '1', '2'), false);
  assert.equal(fn(false, '4', '5'), false);
  // First iteration with flag off also no halt (consistent with default).
  assert.equal(fn(false, null, '1'), false);
});

test('shouldHaltAtEpicTransition is purely boolean', () => {
  const fn = extractFunction(source, 'shouldHaltAtEpicTransition');
  assert.equal(typeof fn(true, '1', '2'), 'boolean');
  assert.equal(typeof fn(false, '1', '2'), 'boolean');
  assert.equal(typeof fn(true, null, '1'), 'boolean');
});

// ============================================================================
// parseMaxRetries(rawValue) → integer
// Parses the args.maxRetries arg with the documented default (3) and the
// 0 = never-retry special case. Pure — no Workflow globals. Used by the
// orchestrator's args parsing block at script top.
// ============================================================================

test('parseMaxRetries returns 3 when rawValue is undefined', () => {
  const fn = extractFunction(source, 'parseMaxRetries');
  assert.equal(fn(undefined), 3);
});

test('parseMaxRetries returns 3 when rawValue is null', () => {
  const fn = extractFunction(source, 'parseMaxRetries');
  assert.equal(fn(null), 3);
});

test('parseMaxRetries returns 0 (never retry) when rawValue is 0', () => {
  const fn = extractFunction(source, 'parseMaxRetries');
  assert.equal(fn(0), 0);
  assert.equal(fn('0'), 0);
});

test('parseMaxRetries parses string numbers', () => {
  const fn = extractFunction(source, 'parseMaxRetries');
  assert.equal(fn('5'), 5);
  assert.equal(fn('10'), 10);
});

test('parseMaxRetries rejects negative numbers (treated as default)', () => {
  const fn = extractFunction(source, 'parseMaxRetries');
  // Negative retries don't make sense — fall back to default (3).
  assert.equal(fn(-1), 3);
});

// ============================================================================
// removeFromState(state, storyKey) → state
// Removes a storyKey from state.blocked and state.halts. Used when a story
// converges or is otherwise resolved — keeps state consistent (converged
// story shouldn't still appear as blocked). Pure: returns new state object.
// ============================================================================

test('removeFromState drops story from blocked array', () => {
  const fn = extractFunction(source, 'removeFromState');
  const state = {
    blocked: [
      { story: '1-1', reason: 'launch_failure' },
      { story: '1-2', reason: 'ci_hardfail' },
    ],
    halts: [],
  };
  const out = fn(state, '1-1');
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].story, '1-2');
});

test('removeFromState drops story from halts array', () => {
  const fn = extractFunction(source, 'removeFromState');
  const state = {
    blocked: [],
    halts: [
      { reason: 'launch_failure', story: '1-1', iteration: 1 },
      { reason: 'ci_hardfail', story: '1-2', iteration: 2 },
    ],
  };
  const out = fn(state, '1-1');
  assert.equal(out.halts.length, 1);
  assert.equal(out.halts[0].story, '1-2');
});

test('removeFromState handles string-form blocked entries', () => {
  const fn = extractFunction(source, 'removeFromState');
  // Older format: blocked entries are bare strings (not objects).
  const state = {
    blocked: ['1-1', '1-2', '1-3'],
    halts: [],
  };
  const out = fn(state, '1-2');
  assert.deepEqual([...out.blocked], ['1-1', '1-3']);
});

test('removeFromState leaves state unchanged if story not present', () => {
  const fn = extractFunction(source, 'removeFromState');
  const state = {
    blocked: [{ story: '1-1', reason: 'launch_failure' }],
    halts: [{ reason: 'launch_failure', story: '1-1', iteration: 1 }],
  };
  const out = fn(state, '9-9');
  assert.equal(out.blocked.length, 1);
  assert.equal(out.halts.length, 1);
});

test('removeFromState preserves other state fields', () => {
  const fn = extractFunction(source, 'removeFromState');
  const state = {
    storyQueue: ['1-2', '1-3'],
    completed: ['1-0'],
    blocked: [{ story: '1-1' }],
    halts: [],
    iterationCount: 5,
  };
  const out = fn(state, '1-1');
  // blocked updated, everything else untouched
  assert.equal(out.blocked.length, 0);
  assert.deepEqual([...out.storyQueue], ['1-2', '1-3']);
  assert.deepEqual([...out.completed], ['1-0']);
  assert.equal(out.iterationCount, 5);
});

// ============================================================================
// pickReHaltReason(halts) → string
// Returns the most recent halt reason (last entry in array — chronological).
// Used by the resume-without-userChoice path to re-halt at the LATEST actual
// halt instead of always dep_inference_confirm. Pure: string selection.
// ============================================================================

test('pickReHaltReason returns last halt reason (most recent)', () => {
  const fn = extractFunction(source, 'pickReHaltReason');
  const halts = [
    { reason: 'dep_inference_confirm', story: null },
    { reason: 'launch_failure', story: '1-2', iteration: 2 },
    { reason: 'ci_hardfail', story: '1-3', iteration: 3 },
  ];
  assert.equal(fn(halts), 'ci_hardfail');
});

test('pickReHaltReason falls back to dep_inference_confirm on empty halts', () => {
  const fn = extractFunction(source, 'pickReHaltReason');
  assert.equal(fn([]), 'dep_inference_confirm');
  assert.equal(fn(null), 'dep_inference_confirm');
  assert.equal(fn(undefined), 'dep_inference_confirm');
});

test('pickReHaltReason handles halt entries without reason field', () => {
  const fn = extractFunction(source, 'pickReHaltReason');
  // Last entry has no reason → falls back.
  const halts = [{ reason: 'launch_failure' }, { /* no reason */ }];
  assert.equal(fn(halts), 'dep_inference_confirm');
});

// ============================================================================
// userOptionsForHaltReason(reason) → string[]
// Maps halt reason to its appropriate userOptions list. dep_inference_confirm
// has a custom 3-option list (confirm_deps/proceed_without_inference/abort_prd);
// all other error halts share the 5-option list (continue/retry_blocked/
// skip_blocked/abort_prd/fix_then_resume).
// ============================================================================

test('userOptionsForHaltReason returns dep_inference-specific list for dep_inference_confirm', () => {
  const fn = extractFunction(source, 'userOptionsForHaltReason');
  const out = fn('dep_inference_confirm');
  assert.deepEqual([...out], ['confirm_deps', 'proceed_without_inference', 'abort_prd']);
});

test('userOptionsForHaltReason returns 5-option list for error halts', () => {
  const fn = extractFunction(source, 'userOptionsForHaltReason');
  for (const reason of ['launch_failure', 'ci_hardfail', 'merge_blocked', 'merge_conflict', 'epic_boundary', 'final_complete']) {
    const out = fn(reason);
    assert.deepEqual([...out], ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume'], `for reason ${reason}`);
  }
});

test('userOptionsForHaltReason falls back to 5-option list for unknown reason', () => {
  const fn = extractFunction(source, 'userOptionsForHaltReason');
  const out = fn('something_new_we_dont_know_about');
  assert.deepEqual([...out], ['continue', 'retry_blocked', 'skip_blocked', 'abort_prd', 'fix_then_resume']);
});

// ============================================================================
// moveBlockedToSkipped(state) → state
// On userChoice='skip_blocked': moves blocked stories to skipped[] and clears
// blocked[]. Also drops matching halt entries. Pure: returns new state.
// ============================================================================

test('moveBlockedToSkipped moves blocked objects to skipped with reason', () => {
  const fn = extractFunction(source, 'moveBlockedToSkipped');
  const state = {
    blocked: [
      { story: '1-2', reason: 'launch_failure' },
      { story: '2-3', reason: 'ci_hardfail' },
    ],
    halts: [{ reason: 'launch_failure', story: '1-2' }],
    skipped: [],
  };
  const out = fn(state);
  assert.equal(out.blocked.length, 0);
  assert.equal(out.skipped.length, 2);
  // Order: in input order. Use JSON round-trip to escape vm sandbox prototype
  // (assert.deepEqual strict-equal checks prototypes; spread doesn't help for
  // nested objects).
  assert.equal(JSON.stringify(out.skipped[0]), JSON.stringify({ story: '1-2', reason: 'launch_failure' }));
  assert.equal(JSON.stringify(out.skipped[1]), JSON.stringify({ story: '2-3', reason: 'ci_hardfail' }));
  // Matching halt dropped.
  assert.equal(out.halts.length, 0);
});

test('moveBlockedToSkipped handles string-form blocked entries', () => {
  const fn = extractFunction(source, 'moveBlockedToSkipped');
  const state = {
    blocked: ['1-1', '2-1'],  // legacy string format
    halts: [],
    skipped: [],
  };
  const out = fn(state);
  assert.equal(out.blocked.length, 0);
  // String entries → reason undefined. JSON round-trip to escape vm sandbox
  // prototypes for assert.deepEqual matching.
  assert.equal(JSON.stringify(out.skipped), JSON.stringify([{ story: '1-1', reason: null }, { story: '2-1', reason: null }]));
});

test('moveBlockedToSkipped preserves non-matching halt entries', () => {
  const fn = extractFunction(source, 'moveBlockedToSkipped');
  const state = {
    blocked: [{ story: '1-1', reason: 'launch_failure' }],
    halts: [
      { reason: 'launch_failure', story: '1-1' },   // should be dropped
      { reason: 'ci_hardfail', story: '2-2' },     // preserved (different story)
    ],
    skipped: [],
  };
  const out = fn(state);
  assert.equal(out.halts.length, 1);
  assert.equal(out.halts[0].story, '2-2');
});

test('moveBlockedToSkipped preserves existing skipped entries', () => {
  const fn = extractFunction(source, 'moveBlockedToSkipped');
  const state = {
    blocked: [{ story: '1-2', reason: 'launch_failure' }],
    skipped: [{ story: '9-9', reason: 'done' }],
    halts: [],
  };
  const out = fn(state);
  assert.equal(out.skipped.length, 2);
  // Existing entry preserved, new one appended.
  assert.equal(out.skipped[0].story, '9-9');
  assert.equal(out.skipped[1].story, '1-2');
});

// ============================================================================
// safeInferredForDeps(stateObj, fallback) → array
// Returns stateObj.inferred if defined, else fallback, else []. Defends
// against JSON.stringify dropping an undefined key (deps.json = "{}").
// ============================================================================

test('safeInferredForDeps returns stateObj.inferred when defined', () => {
  const fn = extractFunction(source, 'safeInferredForDeps');
  const inferred = [{ story: '1-1', depends_on: [] }];
  assert.deepEqual([...fn({ inferred }, [])], inferred);
});

test('safeInferredForDeps falls back to fallback when stateObj.inferred undefined', () => {
  const fn = extractFunction(source, 'safeInferredForDeps');
  const fallback = [{ story: '9-9', depends_on: [] }];
  assert.deepEqual([...fn({}, fallback)], fallback);
});

test('safeInferredForDeps returns empty array when both undefined', () => {
  const fn = extractFunction(source, 'safeInferredForDeps');
  assert.deepEqual([...fn({}, null)], []);
  assert.deepEqual([...fn({}, undefined)], []);
});

test('safeInferredForDeps coerces non-array inferred to empty', () => {
  const fn = extractFunction(source, 'safeInferredForDeps');
  // Defends against state.inferred being a non-array (corrupted disk state).
  assert.deepEqual([...fn({ inferred: 'not-an-array' }, null)], []);
  assert.deepEqual([...fn({ inferred: 42 }, null)], []);
});

// ============================================================================
// isConverged(convergeResult) → boolean
// Returns true if sub-workflow merged the story — either via converged:true
// or via merge.merged:true (build phase skipped because branch had commits).
// Without this, the orchestrator blocks successful merges that bypassed
// the convergence loop. Pure: boolean derivation.
// ============================================================================

test('isConverged returns true when converged is true', () => {
  const fn = extractFunction(source, 'isConverged');
  assert.equal(fn({ converged: true }), true);
  assert.equal(fn({ converged: true, iterations: 3, finalSha: 'abc123' }), true);
});

test('isConverged returns true when merge.merged is true (even if converged false)', () => {
  const fn = extractFunction(source, 'isConverged');
  // Build phase skipped → converged=false, but merge.merged=true (branch had commits).
  const result = { converged: false, merge: { merged: true, sprintStatusDone: true } };
  assert.equal(fn(result), true);
});

test('isConverged returns false when converged false and merge not merged', () => {
  const fn = extractFunction(source, 'isConverged');
  assert.equal(fn({ converged: false }), false);
  assert.equal(fn({ converged: false, merge: { merged: false, error: 'x' } }), false);
});

test('isConverged returns false when merge.merged is missing', () => {
  const fn = extractFunction(source, 'isConverged');
  // No merge field at all → not converged.
  const result = { converged: false, setup: {}, mr: {} };
  assert.equal(fn(result), false);
});

test('isConverged returns false for null/undefined', () => {
  const fn = extractFunction(source, 'isConverged');
  assert.equal(fn(null), false);
  assert.equal(fn(undefined), false);
});

test('isConverged requires merge.merged to be strictly true', () => {
  const fn = extractFunction(source, 'isConverged');
  // Truthy non-true values should still be treated as false.
  assert.equal(fn({ converged: false, merge: { merged: 'true' } }), false);  // string 'true'
  assert.equal(fn({ converged: false, merge: { merged: 1 } }), false);
});

// ============================================================================
// buildHaltContext(reason, details, story, iterationCount, userOptions, extras)
// Returns the standard halt payload the orchestrator returns to the Workflow
// runtime. Shape:
//   { haltReason, context, resumeToken, runDir, userOptions }
// Used by launch_failure, ci_hardfail, merge_blocked, merge_conflict, etc.
// Pure: object builder, no side effects.
// ============================================================================

test('buildHaltContext returns standard halt shape', () => {
  const fn = extractFunction(source, 'buildHaltContext');
  const out = fn('test_reason', { foo: 'bar' }, 'rt-123', '/run/dir', ['continue']);
  assert.equal(out.haltReason, 'test_reason');
  assert.deepEqual({...out.context}, { foo: 'bar' });
  assert.equal(out.resumeToken, 'rt-123');
  assert.equal(out.runDir, '/run/dir');
  assert.deepEqual([...out.userOptions], ['continue']);
});

test('buildHaltContext defaults userOptions to standard resume set', () => {
  const fn = extractFunction(source, 'buildHaltContext');
  const out = fn('launch_failure', { story: '1-1' }, 'rt', '/run');
  // No userOptions arg → default list (continue, retry_blocked, skip_blocked, abort_prd, fix_then_resume).
  assert.ok(Array.isArray(out.userOptions));
  assert.ok(out.userOptions.includes('continue'));
  assert.ok(out.userOptions.includes('retry_blocked'));
  assert.ok(out.userOptions.includes('skip_blocked'));
  assert.ok(out.userOptions.includes('abort_prd'));
  assert.ok(out.userOptions.includes('fix_then_resume'));
});

test('buildHaltContext defaults context to empty object', () => {
  const fn = extractFunction(source, 'buildHaltContext');
  const out = fn('epic_boundary', null, 'rt', '/run', ['continue']);
  assert.deepEqual({...out.context}, {});
});

test('buildHaltContext preserves custom userOptions', () => {
  const fn = extractFunction(source, 'buildHaltContext');
  // Custom userOptions (e.g. dep_inference_confirm has its own list).
  const out = fn('dep_inference_confirm', {}, 'rt', '/run', ['confirm_deps', 'proceed_without_inference', 'abort_prd']);
  assert.deepEqual([...out.userOptions], ['confirm_deps', 'proceed_without_inference', 'abort_prd']);
});

// ============================================================================
// findUnmetDeps(deps, depStatuses) → string[]
// Returns the subset of `deps` whose status in `depStatuses` is NOT 'done'.
// A dep is "met" when sprint-status reports it 'done' (sprint-status is the
// ground truth across all runs — state.completed is this-run-only).
// Pure: no side effects, just a filter.
// ============================================================================

test('findUnmetDeps returns empty when all deps are done', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  assert.deepEqual([...fn(['1-1', '1-2'], { '1-1': 'done', '1-2': 'done' })], []);
});

test('findUnmetDeps returns deps whose status is not done', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  assert.deepEqual([...fn(['1-1', '1-2', '1-3'], { '1-1': 'done', '1-2': 'in-progress', '1-3': 'review' })], ['1-2', '1-3']);
});

test('findUnmetDeps returns dep when status is missing from depStatuses', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  // Missing status = treat as unmet (defensive — shouldn't happen in practice
  // if the orchestrator's all-read correctly populated every dep).
  assert.deepEqual([...fn(['1-1', '1-2'], { '1-1': 'done' })], ['1-2']);
});

test('findUnmetDeps returns all deps when no statuses provided', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  assert.deepEqual([...fn(['1-1', '1-2', '1-3'], {})], ['1-1', '1-2', '1-3']);
});

test('findUnmetDeps handles empty deps array', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  assert.deepEqual([...fn([], { '1-1': 'done' })], []);
});

test('findUnmetDeps preserves dep order', () => {
  const fn = extractFunction(source, 'findUnmetDeps');
  // Important: order must match input order so logs are deterministic and
  // journal entries can be diffed across runs.
  assert.deepEqual([...fn(['c-dep', 'a-dep', 'b-dep'], { 'a-dep': 'review', 'b-dep': 'done', 'c-dep': 'in-progress' })], ['c-dep', 'a-dep']);
});

// ============================================================================
// base64Encode(input) → string
// Pure-JS UTF-8 → base64 (Workflow runtime lacks `Buffer` + `btoa`). Used by
// writeState's bash command to safely embed state/deps JSON in a single-line
// command (heredocs were vulnerable to LLM rewriting). Tests document the
// "no Buffer" contract so a future maintainer doesn't re-introduce Buffer.from.
// ============================================================================

test('base64Encode produces standard base64 for ASCII', () => {
  const fn = extractFunction(source, 'base64Encode');
  assert.equal(fn(''), '');
  assert.equal(fn('a'), 'YQ==');
  assert.equal(fn('hello'), 'aGVsbG8=');
});

test('base64Encode matches Buffer.from(...).toString("base64") for sample inputs', () => {
  // Compare against Node's Buffer — a Buffer-using implementation would silently
  // work in tests but throw ReferenceError in Workflow runtime. This test
  // documents the canonical equivalence.
  const fn = extractFunction(source, 'base64Encode');
  for (const s of ['', 'x', 'hello world', 'café', '🚀 launch', JSON.stringify({a: 1, b: [2, 3]})]) {
    const expected = Buffer.from(s, 'utf8').toString('base64');
    assert.equal(fn(s), expected, `mismatch for ${JSON.stringify(s)}`);
  }
});

test('base64Encode does NOT reference Buffer (Workflow runtime check)', () => {
  // Static check: grep for Buffer. inside the function body. If someone
  // "optimizes" this to use Buffer.from, this test fails — catches the
  // Workflow-runtime regression at unit-test time.
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  const m = source.match(/function\s+base64Encode\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'base64Encode should be a function declaration');
  assert.ok(!/\bBuffer\b/.test(m[0]), 'base64Encode must not reference Buffer — Workflow runtime has no Buffer global');
});

// ============================================================================
// applyUserChoice(planResult, userChoice, confirmedDeps) → { planResult, halt }
// Pure transformation: takes the plan result + the operator's userChoice from
// a halted run + optional confirmedDeps (operator-edited graph), returns the
// modified planResult + whether the run should halt (aborted).
// ============================================================================

test('applyUserChoice abort_prd returns halt=true', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [{ story: '1-1', depends_on: [] }] };
  const { planResult: out, halt } = fn(planResult, 'abort_prd', null);
  assert.equal(halt, true);
  // planResult unchanged for abort
  assert.deepEqual([...out.inferred], [{ story: '1-1', depends_on: [] }]);
});

test('applyUserChoice proceed_without_inference clears inferred graph', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [{ story: '1-1', depends_on: ['1-2'] }] };
  const { planResult: out, halt } = fn(planResult, 'proceed_without_inference', null);
  assert.equal(halt, false);
  assert.deepEqual([...out.inferred], []);
});

test('applyUserChoice confirm_deps without confirmedDeps uses planResult.inferred as-is', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [{ story: '1-1', depends_on: ['1-2'] }] };
  const { planResult: out, halt } = fn(planResult, 'confirm_deps', null);
  assert.equal(halt, false);
  assert.deepEqual([...out.inferred], [{ story: '1-1', depends_on: ['1-2'] }]);
});

test('applyUserChoice confirm_deps with array confirmedDeps replaces graph', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [{ story: 'old', depends_on: [] }] };
  const edited = [{ story: '1-1', depends_on: ['1-2'] }, { story: '1-2', depends_on: [] }];
  const { planResult: out, halt } = fn(planResult, 'confirm_deps', edited);
  assert.equal(halt, false);
  assert.deepEqual([...out.inferred], edited);
});

test('applyUserChoice confirm_deps with object confirmedDeps converts to entries', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [] };
  const edited = { '1-1': ['1-2', '1-3'], '1-2': [] };
  const { planResult: out, halt } = fn(planResult, 'confirm_deps', edited);
  assert.equal(halt, false);
  assert.equal(out.inferred.length, 2);
  // Sort + spread to clone into host Array.prototype (vm sandbox issue).
  const sorted = [...out.inferred].sort((a, b) => a.story.localeCompare(b.story));
  assert.deepEqual(
    sorted.map(e => ({ story: e.story, depends_on: [...e.depends_on] })),
    [
      { story: '1-1', depends_on: ['1-2', '1-3'] },
      { story: '1-2', depends_on: [] },
    ],
  );
});

test('applyUserChoice unknown userChoice returns halt=false and planResult unchanged', () => {
  const fn = extractFunction(source, 'applyUserChoice');
  const planResult = { inferred: [{ story: '1-1', depends_on: [] }] };
  const { planResult: out, halt } = fn(planResult, 'something_weird', null);
  assert.equal(halt, false);
  assert.deepEqual([...out.inferred], [{ story: '1-1', depends_on: [] }]);
});

// ============================================================================
// describeSchema + prompt/schema alignment guards
// ============================================================================
// Agent prompts render their field list with describeSchema(SCHEMA) instead of
// hand-writing it, so evolving a schema cannot silently desync its prompt.
// These guards fail the build if that link is broken again.
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

/** Extract a top-level `const NAME = { ... };` object literal from the source. */
function extractObject(source, name) {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\{`));
  if (!m) throw new Error(`const ${name} not found in script source`);
  const start = source.indexOf('{', m.index);
  let depth = 0; let i = start;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${name}`);
  return vm.runInNewContext(`(${source.slice(start, i + 1)})`, {}, { filename: `${name}.js` });
}

const SCHEMA_NAMES = [...SCRIPT_SOURCE.matchAll(/^const ([A-Z][A-Z_]*SCHEMA) = \{/gm)].map(m => m[1]);

test('describeSchema renders name, type, required flag and description', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'describeSchema');
  const out = fn({
    type: 'object',
    properties: {
      a: { type: 'string', description: 'first' },
      b: { type: 'boolean' },
      c: { type: 'array', items: { type: 'string' }, description: 'list' },
    },
    required: ['a', 'b'],
  });
  assert.equal(out, [
    '  a (string) — first',
    '  b (boolean)',
    '  c (array<string>) [optional] — list',
  ].join('\n'));
});

test('describeSchema handles a schema with no properties', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'describeSchema');
  assert.equal(fn({ type: 'object' }), '');
  assert.equal(fn({ type: 'object', properties: {} }), '');
});

test('guard: no prompt tells the agent to return a NAMED schema', () => {
  // Naming the const instead of listing fields is exactly the drift we removed:
  // the agent either guesses or goes off to read the script (token cost, and
  // impossible for tool-restricted agents with no Read/Bash).
  assert.doesNotMatch(SCRIPT_SOURCE, /return\s+[A-Z][A-Z_]*SCHEMA/i,
    'a prompt instructs the agent to return a schema by name — render it with describeSchema(<NAME>) instead');
});

test('guard: every schema const is rendered in a prompt or used as a nested schema', () => {
  assert.ok(SCHEMA_NAMES.length > 0, 'no schema consts discovered — this guard is blind');
  for (const name of SCHEMA_NAMES) {
    const rendered = SCRIPT_SOURCE.includes(`describeSchema(${name})`);
    const nested = SCRIPT_SOURCE.includes(`items: ${name}`);
    assert.ok(rendered || nested,
      `${name} is neither rendered by describeSchema() nor nested under items: — its prompt field list would drift from the schema`);
  }
});

test('guard: every schema property has a description', () => {
  for (const name of SCHEMA_NAMES) {
    const schema = extractObject(SCRIPT_SOURCE, name);
    for (const [prop, def] of Object.entries(schema.properties || {})) {
      assert.ok(def.description && def.description.trim(),
        `${name}.${prop} has no description — the generated prompt list would omit what the field means`);
    }
  }
});

test('guard: writeState is never awaited outside persistState', () => {
  // persistState checks the returned {written} and retries. A direct
  // `await writeState(...)` anywhere else discards the result — which is how a
  // failed write stayed silent while the on-disk state drifted behind a live run.
  const start = SCRIPT_SOURCE.indexOf('async function persistState(');
  const end = SCRIPT_SOURCE.indexOf('async function writeState(');
  assert.ok(start > -1 && end > start, 'persistState/writeState not found in script source');
  const outside = SCRIPT_SOURCE.slice(0, start) + SCRIPT_SOURCE.slice(end);
  const hits = [...outside.matchAll(/await writeState\(/g)];
  assert.equal(hits.length, 0,
    `found ${hits.length} writeState call site(s) outside persistState — those ignore the {written} result`);
});

test('guard: the per-story loop persists state on every iteration', () => {
  // The loop used to write state only on halt paths, so a run that progressed
  // without halting never updated state.json (observed: 33 minutes and three
  // stories behind its own journal). Anchored on the comment so that removing
  // either the persist call or the explanation trips this guard.
  assert.match(SCRIPT_SOURCE, /\/\/ Persist after EVERY story[\s\S]{0,400}?persistOrHalt\(state\)/,
    'the per-story loop must persist via persistOrHalt(state) right after storyQueue.shift()');
});

test('guard: a failed state write stops the run', () => {
  // Sites where the run CONTINUES after persisting must go through persistOrHalt.
  // Sites that halt on the next line keep plain persistState — the run is stopping
  // anyway and the halt context is returned from memory.
  assert.ok(SCRIPT_SOURCE.includes("'state_write_failed'"),
    'persistOrHalt must build a halt context with the state_write_failed reason');
  const sites = [...SCRIPT_SOURCE.matchAll(/persistOrHalt\(/g)].length;
  assert.ok(sites >= 6,
    `expected at least 6 persistOrHalt call sites (per-story, 3 plan-phase, pre-loop, post-loop), found ${sites}`);
});

test('userOptionsForHaltReason knows state_write_failed', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'userOptionsForHaltReason');
  // Spread into a host-realm array: the vm context's Array.prototype differs, so
  // deepEqual would fail on prototype identity (same idiom as the other tests here).
  assert.deepEqual([...fn('state_write_failed')], ['continue', 'abort_prd']);
});

test('requeueCIHardfails preserves every state field', () => {
  // Regression: the caller assigns the result back to the live state, so a rebuild
  // that kept only storyQueue/completed/blocked/halts dropped skipped and
  // awaitingOperator — and the next state.skipped.push threw
  // "undefined is not an object". Reproduced a live run crash.
  const fn = extractFunction(SCRIPT_SOURCE, 'requeueCIHardfails');
  const state = {
    storyQueue: ['2-1'],
    completed: ['1-1'],
    blocked: [{ story: '1-2', reason: 'ci_hardfail' }],
    skipped: [{ story: '1-9', reason: 'unmet_deps' }],
    awaitingOperator: [{ story: '1-8' }],
    halts: [{ reason: 'ci_hardfail', story: '1-2', retries: 0 }],
    inferred: [{ story: '2-1', depends_on: [] }],
    iterationCount: 7,
    prdKey: 'test-loop-v2',
    ts: '20260912-101841',
    runId: 'r1',
  };
  const { state: out, count } = fn(state, 3);
  assert.equal(count, 1, 'the ci_hardfail story should be re-queued once');
  for (const k of ['skipped', 'awaitingOperator', 'inferred', 'iterationCount', 'prdKey', 'ts', 'runId']) {
    assert.ok(k in out && out[k] !== undefined,
      `${k} was dropped by requeueCIHardfails — the next push on it throws`);
  }
  assert.deepEqual([...out.skipped], [{ story: '1-9', reason: 'unmet_deps' }]);
  // Field-by-field for halts: they are rebuilt inside the vm context, so their
  // objects carry that realm's prototype and a strict deepEqual on them fails on
  // prototype identity despite identical structure.
  assert.equal(out.halts.length, 1);
  assert.equal(out.halts[0].story, '1-2');
  assert.equal(out.halts[0].reason, 'ci_hardfail');
  assert.equal(out.halts[0].retries, 1, 'the retry counter must be incremented');
  assert.equal(out.iterationCount, 7);
  assert.equal(out.prdKey, 'test-loop-v2');
  assert.equal(out.runId, 'r1');
});

test('normalizeStateArrays restores every missing collection field', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'normalizeStateArrays');
  const out = fn({ storyQueue: ['a'] });
  for (const k of ['storyQueue', 'completed', 'blocked', 'skipped', 'awaitingOperator', 'halts']) {
    assert.ok(Array.isArray(out[k]), `${k} must be an array after normalization`);
  }
  assert.equal(out.storyQueue.length, 1, 'existing entries must survive');
});

test('normalizeStateArrays replaces non-array values, not just missing ones', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'normalizeStateArrays');
  const out = fn({ skipped: null, awaitingOperator: 'nope', blocked: 'also wrong' });
  assert.ok(Array.isArray(out.skipped) && Array.isArray(out.awaitingOperator) && Array.isArray(out.blocked));
});

// ============================================================================
// Spec discovery + story-key validation
// ============================================================================

test('extractStoryId takes the <epic>-<story> prefix', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'extractStoryId');
  assert.equal(fn('1-3-login-form'), '1-3');
  assert.equal(fn('2-11-long-slug'), '2-11');
  assert.equal(fn('4-1-a'), '4-1');
  assert.equal(fn('1'), '1');
  assert.equal(fn(''), '');
  assert.equal(fn(null), '');
});

test('specPathCandidates orders exact, then sprint, then stories, then legacy', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'specPathCandidates');
  assert.deepEqual([...fn('2-1', '2-1-deferred-work-ledger-round-trip')], [
    '_bmad-output/implementation-artifacts/spec-2-1-deferred-work-ledger-round-trip.md',
    '_bmad-output/implementation-artifacts/spec-2-1-*.md',
    '_bmad-output/implementation-artifacts/stories/2-1-*.md',
    '_bmad-output/implementation-artifacts/2-1-deferred-work-ledger-round-trip.md',
  ]);
});

test('renderSpecPatterns emits the id-prefix patterns for many-story prompts', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'renderSpecPatterns', ['specPathCandidates']);
  const out = fn();
  assert.match(out, /spec-<storyId>-\*\.md/);
  assert.match(out, /stories\/<storyId>-\*\.md/);
  // No legacy exact-key candidate here: there is no single key to name.
  assert.doesNotMatch(out, /implementation-artifacts\/<storyId>\.md/);
});

test('renderSpecDiscovery resolves one story key', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'renderSpecDiscovery', ['extractStoryId', 'specPathCandidates']);
  const out = fn('2-1-deferred-work-ledger-round-trip');
  assert.match(out, /spec-2-1-\*\.md/);
  assert.match(out, /stories\/2-1-\*\.md/);
  assert.match(out, /2-1-deferred-work-ledger-round-trip\.md/);
});

test('specPathCandidates puts the exact name ahead of the id-prefix glob', () => {
  // A story can have SIBLING spec files (`…-blocked-attempt.md` from an intent-gap
  // escalation), which makes the prefix glob ambiguous for a story that is fine.
  // The exact candidate resolves it before the ambiguity HALT can fire.
  const fn = extractFunction(SCRIPT_SOURCE, 'specPathCandidates');
  const c = fn('1-5', '1-5-add-tests-test_hello-py-with-one-passing-test');
  assert.equal(c[0], '_bmad-output/implementation-artifacts/spec-1-5-add-tests-test_hello-py-with-one-passing-test.md');
  assert.match(c[1], /\*\.md$/);
});

test('findUnknownStoryKeys returns keys the plan never produced', () => {
  const fn = extractFunction(SCRIPT_SOURCE, 'findUnknownStoryKeys');
  const known = ['1-1-a', '1-2-b'];
  assert.deepEqual([...fn(['1-1-a', '9-9-ghost'], known)], ['9-9-ghost']);
  assert.deepEqual([...fn([], known)], []);
  assert.deepEqual([...fn(null, known)], []);
  // An empty known-set means nothing can be verified — report everything rather
  // than silently accepting it.
  assert.deepEqual([...fn(['1-1-a'], null)], ['1-1-a']);
  // Falsy entries are absent slots, not unknown keys.
  assert.deepEqual([...fn(['', null, '1-1-a'], known)], []);
});

test('findUnknownStoryKeys catches the two-identities case', () => {
  // The live failure this guards: state.json held a title-derived slug
  // (dot kept) while the plan, built from sprint-status.yaml, produced the
  // canonical key (dot rendered as a dash).
  const fn = extractFunction(SCRIPT_SOURCE, 'findUnknownStoryKeys');
  const known = ['1-5-add-tests-test_hello-py-with-one-passing-test'];
  const fromDisk = ['1-5-add-tests-test_hello.py-with-one-passing-test'];
  assert.deepEqual([...fn(fromDisk, known)], fromDisk);
});
