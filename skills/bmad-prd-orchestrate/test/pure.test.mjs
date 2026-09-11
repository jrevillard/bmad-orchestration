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
