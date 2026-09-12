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

test('integration: orchestrator uses Workflow (capital W) at the dispatch site', () => {
  const src = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  // CRITICAL: lowercase `workflow({` (function-call shape) MUST NOT exist.
  // The bug from 2026-09-12 was `await workflow({ scriptPath, args })` —
  // lowercase workflow is undefined → TypeError → launch_failure on every story.
  const lowerCount = src.split('workflow({').length - 1;
  assert.equal(lowerCount, 0,
    `Lowercase 'workflow({' found (${lowerCount} matches) — ` +
    `this is the bug from 2026-09-12. The Workflow runtime exports Workflow (capital W).`);
  // Capital-W Workflow must exist at least once as a function call (with `{`).
  const upperCount = src.split('Workflow({').length - 1;
  assert.ok(upperCount >= 1,
    `Workflow({ (capital W) not found in orchestrator source. ` +
    `The Phase 3 dispatch is broken. Found: ${upperCount} 'Workflow({'`);
});

test('integration: build-converge does NOT call workflow() (recursive nesting risk)', () => {
  // build-converge runs INSIDE the Workflow runtime. If it tried to call
  // workflow()/Workflow(), it would create infinite nesting.
  const src = readFileSync(CONVERGE_PATH, 'utf8');
  const lowerCount = src.split('workflow({').length - 1;
  const upperCount = src.split('Workflow({').length - 1;
  assert.equal(lowerCount, 0, `Lowercase workflow() in build-converge: ${lowerCount}`);
  assert.equal(upperCount, 0, `build-converge must not call Workflow() (recursive). Found: ${upperCount}`);
});

test('integration: orchestrator wraps dispatch with capital-W Workflow inside try/catch (defense)', () => {
  // Verifies the launch_failure handler is in place around the Workflow call.
  // The pre-fix crash happened because Workflow() threw TypeError — the
  // try/catch captures it and routes to the launch_failure halt.
  const src = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const workflowIdx = src.indexOf('await Workflow({');
  assert.ok(workflowIdx > -1, 'No `await Workflow({` in source');
  // The catch block for launchError should be within a few hundred chars.
  const afterWorkflow = src.slice(workflowIdx, workflowIdx + 1500);
  assert.ok(afterWorkflow.includes('catch (') || afterWorkflow.includes('catch{'),
    'No catch block found within 1500 chars of the Workflow() dispatch — ' +
    'a throw from Workflow() would crash the orchestrator instead of triggering ' +
    'the launch_failure handler.');
  assert.ok(afterWorkflow.includes('launchError'),
    'No launchError assignment in the catch block — the handler is missing');
});
