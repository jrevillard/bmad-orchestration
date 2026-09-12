// Static source-grep integration check for the Workflow global identifier.
//
// The lowercase-workflow bug (2026-09-12) silently made every story dispatch
// fail with launch_failure because `workflow is not a function`. The fix at
// bmad-prd-orchestrate.js:985 changed it to `Workflow` (capital W). This test
// statically scans the source to prevent the typo from regressing.
//
// We deliberately avoid vm.runInContext + mock-everything integration tests:
// the orchestrator script depends on too many Workflow globals (agent, phase,
// log, writeState, appendJournal, dispatchViaClaudeP, ...) for a clean mock.
// A focused source-grep is sufficient and reliable for the typo class.
//
// NOTE: we do NOT do block-comment stripping here — agent prompts in this
// script are template literals containing `/*` characters (e.g. ref patterns
// like `'feat/*/prd'`) which would false-positive naive block-comment
// detectors. We accept that some matches may be inside comments — what we
// verify is the ABSENCE of lowercase typos and PRESENCE of capital-W
// calls. Manual review can confirm each match is a real call site.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PATH = join(__dirname, '../scripts/bmad-prd-orchestrate.js');
const CONVERGE_PATH = join(__dirname, '../../bmad-build-converge/scripts/bmad-build-converge.js');

function countMatches(source, regex) {
  regex.lastIndex = 0;
  return (source.match(regex) || []).length;
}

test('integration: orchestrator uses workflow (lowercase) at the dispatch site', () => {
  const src = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  // The Workflow runtime exposes the sub-workflow dispatcher as `workflow`
  // (lowercase). Capital-W `Workflow` is the main-conversation's tool —
  // calling it from the orchestrator sub-workflow script throws
  // `ReferenceError: Workflow is not defined`.
  //
  // Must have at least 1 lowercase `workflow({` (the real dispatch).
  const lowerCount = src.split('workflow({').length - 1;
  assert.ok(lowerCount >= 1,
    `workflow({ not found in orchestrator source — ` +
    `Phase 3 dispatch is broken. The Workflow runtime exports workflow (lowercase).`);
  // Must have ZERO capital-W `Workflow({` — that's the main-conversation tool,
  // not callable from this context. (Mistakenly introduced 2026-09-12 by an
  // over-eager fix; reverted immediately.)
  const upperCount = src.split('Workflow({').length - 1;
  assert.equal(upperCount, 0,
    `Workflow({ (capital W) found (${upperCount} matches) — ` +
    `this would throw ReferenceError. Use workflow (lowercase).`);
});

test('integration: build-converge does NOT call workflow() (recursive nesting risk)', () => {
  // build-converge runs INSIDE the Workflow runtime. If it tried to call
  // workflow()/Workflow(), it would create infinite nesting. Both cases
  // (lowercase and capital-W) must be absent.
  const src = readFileSync(CONVERGE_PATH, 'utf8');
  const lowerCount = src.split('workflow({').length - 1;
  const upperCount = src.split('Workflow({').length - 1;
  assert.equal(lowerCount, 0, `Lowercase workflow() in build-converge: ${lowerCount}`);
  assert.equal(upperCount, 0, `build-converge must not call Workflow() (recursive). Found: ${upperCount}`);
});

test('integration: orchestrator wraps dispatch with workflow() inside try/catch (defense)', () => {
  // Verifies the launch_failure handler is in place around the workflow()
  // call. The try/catch captures any throw (TypeError, ReferenceError,
  // network error, etc.) and routes to the launch_failure halt.
  const src = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const workflowIdx = src.indexOf('await workflow({');
  assert.ok(workflowIdx > -1, 'No `await workflow({` in source');
  // The catch block for launchError should be within a few hundred chars.
  const afterWorkflow = src.slice(workflowIdx, workflowIdx + 1500);
  assert.ok(afterWorkflow.includes('catch (') || afterWorkflow.includes('catch{'),
    'No catch block found within 1500 chars of the workflow() dispatch — ' +
    'a throw would crash the orchestrator instead of triggering ' +
    'the launch_failure handler.');
  assert.ok(afterWorkflow.includes('launchError'),
    'No launchError assignment in the catch block — the handler is missing');
});

test('integration: no other Workflow-tool global typos in either script', () => {
  // For each script, verify the lowercase globals (canonical form) are
  // present at least once as a function call (with `{`). Use string.indexOf
  // — regex `\bname\s*\{` had bizarre Node behavior in earlier testing,
  // indexOf is simpler and reliable.
  //
  // NOTE: `Workflow` (capital) is intentionally NOT in either list — it's
  // a DIFFERENT function (the main-conversation tool) that throws if
  // called from the sub-workflow context. Use `workflow` (lowercase).
  for (const [path, label, expected] of [
    [ORCHESTRATOR_PATH, 'orchestrator', ['workflow', 'agent', 'phase', 'log', 'writeState', 'appendJournal', 'loadState']],
    // build-converge is the SUB-workflow — it doesn't call workflow() (would
    // recurse). It uses agent() (and dispatchViaClaudeP internally) for sub-tasks.
    [CONVERGE_PATH, 'build-converge', ['agent', 'dispatchViaClaudeP', 'phase', 'log']],
  ]) {
    const src = readFileSync(path, 'utf8');
    for (const name of expected) {
      // Use indexOf — count occurrences of `name(` in source. (Some
      // globals like `agent` are called with `await agent(\n  \`template\``
      // — newline between paren and template — so don't require `{`.)
      const pattern = `${name}(`;
      let count = 0, idx = 0;
      while ((idx = src.indexOf(pattern, idx)) !== -1) {
        count++;
        idx += pattern.length;
      }
      assert.ok(count >= 1,
        `${label}: expected at least 1 call to ${name}(), found ${count}`);
    }
  }
});

test('integration: Phase 4 sprint-status sync agent uses Skill: bmad-issue-tracking-sync', () => {
  // Regression guard: Phase 4 must sync GitHub issue labels (not just
  // sprint-status.yaml). Without this, completed stories stay at the
  // status:backlog label even after the merge — drift between sprint-status
  // (source of truth) and the issue tracker (what users see).
  const src = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  // Pattern check: skill name + env-var pattern must be present in source.
  assert.ok(src.includes('Skill: bmad-issue-tracking-sync'),
    'No Skill: bmad-issue-tracking-sync invocation found — Phase 4 does not ' +
    'sync issue labels. Without this, completed stories drift from the issue tracker.');
  assert.ok(src.includes('BMAD_ISSUE_ACTION=set-status'),
    'No BMAD_ISSUE_ACTION=set-status invocation found — Phase 4 agent missing ' +
    'the env-var protocol for issue status updates.');
  assert.ok(src.includes('labelsSynced'),
    'No labelsSynced field found — Phase 4 schema missing label-sync counter.');
});
