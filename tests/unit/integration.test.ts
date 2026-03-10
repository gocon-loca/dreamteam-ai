/**
 * Integration tests for the supervisor -> worker -> quality-gate pipeline.
 *
 * Tests the goal lifecycle, validation gate (Gate 0), debrief parsing,
 * quality-gate classification, and work queue operations.
 *
 * Compile + run:
 *   npx tsc -p tests/tsconfig.json && node --experimental-vm-modules dist-tests/unit/integration.test.js
 *
 * Requires dist/ to already be built (pnpm build).
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Imports from pre-compiled dist/ output
// ---------------------------------------------------------------------------

import {
  addGoal,
  getGoal,
  updateGoal,
  markGoalStarted,
  markGoalCompleted,
  markGoalFailed,
  deleteGoal,
  clearCompletedGoals,
  getAllGoals,
  getPendingGoals,
  getInProgressGoals,
  isGoalUIRelated,
  parseDebrief,
  COMPLETION_SURRENDER_PATTERNS,
} from '../../dist/orchestration/goal-manager.js';
import type { Goal as GoalType, GoalStatus } from '../../dist/orchestration/goal-manager.js';

import {
  classifyGoalArchetype,
} from '../../dist/orchestration/archetypes.js';

import {
  classifyGoalType,
} from '../../dist/orchestration/model-router.js';

import {
  enqueueWorkItem,
  claimNextItem,
  completeItem,
  getActiveItems,
  getCompletedItems,
  getQueuedCount,
  archiveItem,
} from '../../dist/db/work-queue.js';

import { getDb, closeDb } from '../../dist/db/index.js';

// ---------------------------------------------------------------------------
// Test runner (same pattern as core-modules.test.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err: unknown) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`    ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Setup: back up goals.json so we can safely test CRUD
// ---------------------------------------------------------------------------

const __test_filename = fileURLToPath(import.meta.url);
const __test_dirname = dirname(__test_filename);

// goals.json lives in dist/orchestration/../../data/goals.json relative to
// the compiled goal-crud.js. From our test dir (dist-tests/unit/) we need
// the project root's data/ directory.
const PROJECT_ROOT = join(__test_dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const GOALS_FILE = join(DATA_DIR, 'goals.json');
const GOALS_BACKUP = join(DATA_DIR, 'goals.json.test-backup');

let hadGoalsFile = false;

function backupGoals(): void {
  if (existsSync(GOALS_FILE)) {
    hadGoalsFile = true;
    copyFileSync(GOALS_FILE, GOALS_BACKUP);
  }
  // Start with a clean slate for CRUD tests
  writeFileSync(GOALS_FILE, JSON.stringify({ goals: [], lastUpdated: new Date().toISOString() }, null, 2));
}

function restoreGoals(): void {
  if (hadGoalsFile) {
    copyFileSync(GOALS_BACKUP, GOALS_FILE);
    try { unlinkSync(GOALS_BACKUP); } catch { /* ignore */ }
  } else {
    // Remove the file we created
    try { unlinkSync(GOALS_FILE); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Helper: make a minimal Goal object for classification tests (no disk I/O)
// ---------------------------------------------------------------------------

function makeGoal(title: string, description?: string): GoalType {
  return {
    title,
    description,
    project: 'test',
    id: 'test-1',
    status: 'pending' as GoalStatus,
    assumptions: [],
    iterations: 0,
    createdAt: new Date(),
  };
}

// ===========================================================================
// 1. Goal lifecycle (CRUD -> validation -> debrief)
// ===========================================================================

console.log('\n--- goal lifecycle (CRUD) ---');

backupGoals();

try {
  test('addGoal creates a goal and getGoal retrieves it', () => {
    const goal = addGoal('dreamteam', 'Test goal creation');
    assert.ok(goal.id, 'Goal should have an id');
    assert.equal(goal.project, 'dreamteam');
    assert.equal(goal.title, 'Test goal creation');
    assert.equal(goal.status, 'pending');

    const retrieved = getGoal(goal.id);
    assert.ok(retrieved, 'getGoal should find the goal');
    assert.equal(retrieved!.id, goal.id);
    assert.equal(retrieved!.title, 'Test goal creation');
  });

  test('updateGoal changes goal status', () => {
    const goal = addGoal('dreamteam', 'Test update status');
    const updated = updateGoal(goal.id, { status: 'blocked', blockedReason: 'test block' });
    assert.ok(updated, 'updateGoal should return the updated goal');
    assert.equal(updated!.status, 'blocked');
    assert.equal(updated!.blockedReason, 'test block');

    // Verify persisted
    const retrieved = getGoal(goal.id);
    assert.equal(retrieved!.status, 'blocked');
  });

  test('markGoalStarted sets status to in-progress', () => {
    const goal = addGoal('dreamteam', 'Test start');
    const started = markGoalStarted(goal.id);
    assert.ok(started, 'markGoalStarted should return the goal');
    assert.equal(started!.status, 'in-progress');
    assert.ok(started!.startedAt, 'Should have startedAt timestamp');
  });

  test('markGoalCompleted sets status to completed', () => {
    const goal = addGoal('dreamteam', 'Test complete');
    markGoalStarted(goal.id);
    const completed = markGoalCompleted(goal.id, 'Agent output here');
    assert.ok(completed, 'markGoalCompleted should return the goal');
    assert.equal(completed!.status, 'completed');
    assert.ok(completed!.completedAt, 'Should have completedAt timestamp');
    assert.equal(completed!.output, 'Agent output here');
  });

  test('markGoalFailed sets status to failed', () => {
    const goal = addGoal('dreamteam', 'Test failure');
    markGoalStarted(goal.id);
    const failed_goal = markGoalFailed(goal.id, 'Error output');
    assert.ok(failed_goal, 'markGoalFailed should return the goal');
    assert.equal(failed_goal!.status, 'failed');
    assert.equal(failed_goal!.output, 'Error output');
  });

  test('deleteGoal removes the goal', () => {
    const goal = addGoal('dreamteam', 'Test delete');
    assert.ok(getGoal(goal.id), 'Goal should exist before delete');

    const deleted = deleteGoal(goal.id);
    assert.equal(deleted, true, 'deleteGoal should return true');
    assert.equal(getGoal(goal.id), undefined, 'Goal should not exist after delete');
  });

  test('deleteGoal returns false for non-existent goal', () => {
    const deleted = deleteGoal('nonexistent-goal-id');
    assert.equal(deleted, false, 'deleteGoal should return false for unknown id');
  });

  test('clearCompletedGoals only removes completed goals', () => {
    // Reset goals to clean state
    writeFileSync(GOALS_FILE, JSON.stringify({ goals: [], lastUpdated: new Date().toISOString() }, null, 2));

    const pending = addGoal('dreamteam', 'Pending goal');
    const toComplete1 = addGoal('dreamteam', 'Complete 1');
    const toComplete2 = addGoal('dreamteam', 'Complete 2');
    const inProgress = addGoal('dreamteam', 'In progress goal');

    markGoalStarted(toComplete1.id);
    markGoalCompleted(toComplete1.id);
    markGoalStarted(toComplete2.id);
    markGoalCompleted(toComplete2.id);
    markGoalStarted(inProgress.id);

    const cleared = clearCompletedGoals();
    assert.equal(cleared, 2, 'Should clear exactly 2 completed goals');

    const remaining = getAllGoals();
    assert.equal(remaining.length, 2, 'Should have 2 remaining goals');
    const statuses = remaining.map(g => g.status).sort();
    assert.deepEqual(statuses, ['in-progress', 'pending'], 'Should only have pending and in-progress goals');
  });

  test('getPendingGoals returns only pending goals', () => {
    // Reset
    writeFileSync(GOALS_FILE, JSON.stringify({ goals: [], lastUpdated: new Date().toISOString() }, null, 2));

    const p1 = addGoal('dreamteam', 'Pending 1');
    const p2 = addGoal('dreamteam', 'Pending 2');
    const started = addGoal('dreamteam', 'Started');
    markGoalStarted(started.id);

    const pending = getPendingGoals();
    assert.equal(pending.length, 2, 'Should find 2 pending goals');
    assert.ok(pending.every(g => g.status === 'pending'), 'All returned goals should be pending');
  });

  test('getInProgressGoals returns only in-progress goals', () => {
    const inProgress = getInProgressGoals();
    assert.ok(inProgress.length >= 1, 'Should have at least 1 in-progress goal');
    assert.ok(inProgress.every(g => g.status === 'in-progress'), 'All should be in-progress');
  });

} finally {
  restoreGoals();
}

// ===========================================================================
// 2. Validation gate (Gate 0) — surrender pattern detection
// ===========================================================================

console.log('\n--- validation gate (Gate 0) ---');

test('COMPLETION_SURRENDER_PATTERNS rejects "unfixable"', () => {
  const text = 'unfortunately this is unfixable and we should move on';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(matched, 'Should match "unfixable" surrender pattern');
});

test('COMPLETION_SURRENDER_PATTERNS rejects "impossible to fix"', () => {
  const text = 'This bug is impossible to fix without upstream changes';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(matched, 'Should match "impossible to fix" surrender pattern');
});

test('COMPLETION_SURRENDER_PATTERNS rejects "cannot be resolved"', () => {
  const text = 'The issue cannot be resolved with the current architecture';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(matched, 'Should match "cannot be resolved" surrender pattern');
});

test('COMPLETION_SURRENDER_PATTERNS rejects GOAL_COMPLETE(partial)', () => {
  const text = 'GOAL_COMPLETE (partial) — only some features were implemented';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(matched, 'Should match "GOAL_COMPLETE(partial)" surrender pattern');
});

test('COMPLETION_SURRENDER_PATTERNS rejects "recommendation: file a bug"', () => {
  const text = 'recommendation: file a bug with the upstream library';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(matched, 'Should match recommendation pattern');
});

test('COMPLETION_SURRENDER_PATTERNS accepts clean completion', () => {
  const text = 'GOAL_COMPLETE\nAll changes committed and tests passing. The sidebar renders correctly.';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(!matched, 'Clean completion should not match any surrender pattern');
});

test('COMPLETION_SURRENDER_PATTERNS accepts normal "fix" language', () => {
  const text = 'I fixed the broken test by updating the mock data and correcting the assertion.';
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(text));
  assert.ok(!matched, 'Normal fix language should not trigger surrender detection');
});

test('Surrender patterns only check last 1000 chars (conceptual)', () => {
  // This validates the design: early mentions are ignored, only tail matters
  const earlyText = 'This was unfixable initially but I found a workaround.';
  const lateText = 'GOAL_COMPLETE\nAll changes committed and verified.';
  // If we only test the tail (last 1000 chars), early "unfixable" should not matter
  const tail = (earlyText + ' '.repeat(1000) + lateText).slice(-1000);
  const matched = COMPLETION_SURRENDER_PATTERNS.some(p => p.test(tail));
  assert.ok(!matched, 'Early surrender language outside the 1000-char window should not match');
});

// ===========================================================================
// 3. Debrief parsing pipeline
// ===========================================================================

console.log('\n--- debrief parsing ---');

test('parseDebrief extracts COMMITS, WORKING, BROKEN, CONFIDENCE from agent output', () => {
  const output = `Working on the task...

---DEBRIEF---
COMMITS: abc1234 feat: add user profile page, def5678 fix: handle null avatar
WORKING: User profile page renders correctly with avatar, bio, and settings
BROKEN: none
VERIFIED: Checked /profile at 375px and 1440px
CONFIDENCE: high
NEXT: Add avatar upload functionality
---END_DEBRIEF---

GOAL_COMPLETE`;

  const result = parseDebrief(output);
  assert.ok(result !== null, 'Should parse debrief');
  assert.ok(result!.commits!.length >= 1, 'Should extract commits');
  assert.ok(result!.working!.includes('profile'), 'Should extract working field');
  assert.equal(result!.broken, 'none', 'Should extract broken field');
  assert.equal(result!.confidence, 'high', 'Should extract confidence field');
  assert.ok(result!.next!.includes('avatar upload'), 'Should extract next field');
});

test('parseDebrief returns null for output without debrief block', () => {
  const output = 'Just some random agent output with no structured debrief at all.';
  const result = parseDebrief(output);
  assert.equal(result, null, 'Should return null when no debrief found');
});

test('parseDebrief handles multiline WORKING field', () => {
  const output = `---DEBRIEF---
COMMITS: abc1234 feat: multi-step implementation
WORKING: The feature has several working parts:
  - Login form validates correctly
  - Session tokens are stored
  - Redirect after login works
BROKEN: Password reset flow not yet implemented
CONFIDENCE: medium
---END_DEBRIEF---`;

  const result = parseDebrief(output);
  assert.ok(result !== null, 'Should parse debrief with multiline fields');
  assert.ok(result!.working!.includes('Login form'), 'Should capture multiline working content');
  assert.ok(result!.working!.includes('Session tokens'), 'Should capture second line of working');
});

test('parseDebrief handles ** markdown bold in field names', () => {
  const output = `---DEBRIEF---
**COMMITS**: xyz7890 chore: cleanup unused imports
**WORKING**: Module loads cleanly with no warnings
**BROKEN**: none
**CONFIDENCE**: high
---END_DEBRIEF---`;

  const result = parseDebrief(output);
  assert.ok(result !== null, 'Should parse markdown bold field names');
  assert.ok(result!.working!.includes('Module loads'), 'Should handle bold field names');
  assert.equal(result!.confidence, 'high', 'Should extract confidence from bold field');
});

test('parseDebrief fallback extracts commit hashes from free-form output', () => {
  const output = `I completed the work successfully.
abc1234 feat: add new dashboard component
def5678 fix: resolve edge case in chart rendering
ghi9012 chore: update test snapshots
GOAL_COMPLETE`;

  const result = parseDebrief(output);
  assert.ok(result !== null, 'Should parse fallback commits');
  assert.ok(result!.commits!.length >= 2, 'Should extract multiple commit hashes');
});

test('parseDebrief extracts VERIFIED field', () => {
  const output = `---DEBRIEF---
COMMITS: aaa1111 feat: responsive sidebar
WORKING: Sidebar collapses on mobile
BROKEN: none
VERIFIED: Opened /app in mobile viewport, sidebar auto-collapses below 768px
CONFIDENCE: high
---END_DEBRIEF---`;

  const result = parseDebrief(output);
  assert.ok(result !== null);
  assert.ok(result!.verified!.includes('768px'), 'Should parse verified field');
});

test('parseDebrief handles TESTS field', () => {
  const output = `---DEBRIEF---
COMMITS: bbb2222 test: add auth unit tests
WORKING: All tests pass
BROKEN: none
TESTS: 12 passing, 0 failing
CONFIDENCE: high
---END_DEBRIEF---`;

  const result = parseDebrief(output);
  assert.ok(result !== null);
  assert.ok(result!.tests!.includes('12 passing'), 'Should parse tests field');
});

// ===========================================================================
// 4. Quality gate sequencing — classification functions
// ===========================================================================

console.log('\n--- quality gate classification ---');

test('isGoalUIRelated returns true for "redesign dashboard"', () => {
  assert.equal(isGoalUIRelated(makeGoal('Redesign dashboard layout')), true);
});

test('isGoalUIRelated returns false for "fix API endpoint"', () => {
  assert.equal(isGoalUIRelated(makeGoal('Fix API endpoint for users')), false);
});

test('isGoalUIRelated returns true for CSS/styling goals', () => {
  assert.equal(isGoalUIRelated(makeGoal('Fix CSS layout on homepage')), true);
  assert.equal(isGoalUIRelated(makeGoal('Update tailwind classes for card')), true);
});

test('isGoalUIRelated returns true for component goals', () => {
  assert.equal(isGoalUIRelated(makeGoal('Add sidebar navigation component')), true);
  assert.equal(isGoalUIRelated(makeGoal('Create modal dialog')), true);
});

test('isGoalUIRelated returns false for backend/infra goals', () => {
  assert.equal(isGoalUIRelated(makeGoal('Add database migration for orders')), false);
  assert.equal(isGoalUIRelated(makeGoal('Configure CI pipeline')), false);
  assert.equal(isGoalUIRelated(makeGoal('Refactor auth module')), false);
});

test('isGoalUIRelated: "design" alone is not UI', () => {
  assert.equal(isGoalUIRelated(makeGoal('Design the API schema')), false);
});

test('isGoalUIRelated: "design" + UI context is UI', () => {
  assert.equal(isGoalUIRelated(makeGoal('Design the page layout')), true);
  assert.equal(isGoalUIRelated(makeGoal('Design a new component interface')), true);
});

test('classifyGoalArchetype returns frontend for UI goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Add sidebar navigation')), 'frontend');
  assert.equal(classifyGoalArchetype(makeGoal('Fix CSS layout on dashboard')), 'frontend');
  assert.equal(classifyGoalArchetype(makeGoal('Redesign the settings page')), 'frontend');
});

test('classifyGoalArchetype returns backend for API goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Add API endpoint for users')), 'backend');
  assert.equal(classifyGoalArchetype(makeGoal('Fix database migration')), 'backend');
});

test('classifyGoalArchetype returns test-fix for test goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Fix failing test in auth module')), 'test-fix');
});

test('classifyGoalArchetype returns docs for documentation goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Update README with setup instructions')), 'docs');
});

test('classifyGoalArchetype returns devops for infra goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Set up Docker deployment pipeline')), 'devops');
});

test('classifyGoalArchetype returns research for research goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Research competitive analysis')), 'research');
});

test('classifyGoalArchetype defaults to backend for ambiguous goals', () => {
  assert.equal(classifyGoalArchetype(makeGoal('Something vague')), 'backend');
});

test('classifyGoalType returns trivial for typo/lint tasks', () => {
  assert.equal(classifyGoalType(makeGoal('Fix typo in README')), 'trivial');
  assert.equal(classifyGoalType(makeGoal('Remove unused imports')), 'trivial');
  assert.equal(classifyGoalType(makeGoal('Update config for linting')), 'trivial');
});

test('classifyGoalType returns test-fix for test goals', () => {
  assert.equal(classifyGoalType(makeGoal('Fix failing test in auth')), 'test-fix');
  assert.equal(classifyGoalType(makeGoal('Fix broken test suite')), 'test-fix');
});

test('classifyGoalType returns bug-fix for bug goals', () => {
  assert.equal(classifyGoalType(makeGoal('Fix bug in checkout flow')), 'bug-fix');
  assert.equal(classifyGoalType(makeGoal('Fix crash on startup')), 'bug-fix');
});

test('classifyGoalType returns ui-feature for UI goals', () => {
  assert.equal(classifyGoalType(makeGoal('Add sidebar component')), 'ui-feature');
  assert.equal(classifyGoalType(makeGoal('Responsive layout for dashboard')), 'ui-feature');
});

test('classifyGoalType returns backend-feature for API goals', () => {
  assert.equal(classifyGoalType(makeGoal('Add API endpoint for users')), 'backend-feature');
  assert.equal(classifyGoalType(makeGoal('Database migration for orders')), 'backend-feature');
});

test('classifyGoalType returns refactor for cleanup goals', () => {
  assert.equal(classifyGoalType(makeGoal('Refactor auth module')), 'refactor');
  assert.equal(classifyGoalType(makeGoal('Simplify the checkout logic')), 'refactor');
});

test('classifyGoalType returns research for investigation goals', () => {
  assert.equal(classifyGoalType(makeGoal('Research competitor features')), 'research');
  assert.equal(classifyGoalType(makeGoal('Investigate feasibility of WebSocket integration')), 'research');
});

test('classifyGoalType returns docs for documentation goals', () => {
  assert.equal(classifyGoalType(makeGoal('Update docs for the project')), 'docs');
  assert.equal(classifyGoalType(makeGoal('Add README for the new module')), 'docs');
});

test('classifyGoalType returns devops for deployment goals', () => {
  assert.equal(classifyGoalType(makeGoal('Set up Docker deployment')), 'devops');
  assert.equal(classifyGoalType(makeGoal('Configure CI pipeline with GitHub Actions')), 'devops');
});

test('classifyGoalType returns new-feature for new system goals', () => {
  assert.equal(classifyGoalType(makeGoal('Implement new notification system')), 'new-feature');
  assert.equal(classifyGoalType(makeGoal('Architect the plugin framework')), 'new-feature');
});

test('classifyGoalType returns general for ambiguous goals', () => {
  assert.equal(classifyGoalType(makeGoal('Something completely ambiguous')), 'general');
});

// ===========================================================================
// 5. Work queue lifecycle
// ===========================================================================

console.log('\n--- work queue lifecycle ---');

test('enqueue -> claim -> complete cycle works end-to-end', () => {
  const db = getDb();

  // Enqueue a work item
  const itemId = enqueueWorkItem(
    'test-goal-wq-1',
    'dreamteam',
    'Test prompt for work queue',
    'secondary',
    'backend',
    2.0,
  );
  assert.ok(itemId, 'enqueueWorkItem should return an id');

  // Verify it appears in queued count
  const queuedBefore = getQueuedCount();
  assert.ok(queuedBefore >= 1, 'Should have at least 1 queued item');

  // Claim the item
  const claimed = claimNextItem(process.pid);
  assert.ok(claimed, 'claimNextItem should return an item');
  assert.equal(claimed!.goal_id, 'test-goal-wq-1');
  assert.equal(claimed!.status, 'claimed');
  assert.equal(claimed!.worker_pid, process.pid);
  assert.equal(claimed!.model, 'secondary');
  assert.equal(claimed!.archetype, 'backend');

  // Verify it shows up in active items
  const active = getActiveItems();
  assert.ok(active.some(i => i.id === itemId), 'Claimed item should be in active items');

  // Complete the item
  completeItem(itemId, {
    exitSignal: 'GOAL_COMPLETE',
    costUsd: 0.42,
    runId: 'test-run-123',
    resultOutput: 'Agent completed successfully',
  });

  // Verify it shows up in completed items
  const completed = getCompletedItems();
  const completedItem = completed.find(i => i.id === itemId);
  assert.ok(completedItem, 'Completed item should be in completed items');
  assert.equal(completedItem!.status, 'done');
  assert.equal(completedItem!.exit_signal, 'GOAL_COMPLETE');
  assert.equal(completedItem!.cost_usd, 0.42);

  // Clean up
  archiveItem(itemId);
});

test('completeItem marks failed items correctly', () => {
  const itemId = enqueueWorkItem(
    'test-goal-wq-fail',
    'dreamteam',
    'Test prompt for failure',
    'ancillary',
    'frontend',
  );

  // Claim it
  claimNextItem(process.pid);

  // Complete with error
  completeItem(itemId, {
    exitSignal: 'BLOCKED: missing dependency',
    costUsd: 0.15,
    runId: 'test-run-fail',
    resultOutput: 'BLOCKED: missing dependency',
    error: 'Agent blocked on missing module',
  });

  const completed = getCompletedItems();
  const failedItem = completed.find(i => i.id === itemId);
  assert.ok(failedItem, 'Failed item should be in completed items');
  assert.equal(failedItem!.status, 'failed', 'Non-GOAL_COMPLETE should mark as failed');
  assert.ok(failedItem!.error!.includes('missing module'), 'Error should be recorded');

  // Clean up
  archiveItem(itemId);
});

test('claimNextItem respects per-project concurrency limit', () => {
  // Enqueue 3 items for the same project
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(enqueueWorkItem(
      `test-goal-concurrency-${i}`,
      'test-concurrency-project',
      `Prompt ${i}`,
      'secondary',
      'backend',
    ));
  }

  // Claim with maxPerProject=2
  const claim1 = claimNextItem(process.pid, 2);
  assert.ok(claim1, 'First claim should succeed');
  const claim2 = claimNextItem(process.pid, 2);
  assert.ok(claim2, 'Second claim should succeed');
  const claim3 = claimNextItem(process.pid + 1, 2);
  // Third claim should fail because 2 are already claimed for this project
  assert.equal(claim3, null, 'Third claim should be blocked by concurrency limit');

  // Clean up: complete and archive all
  for (const id of ids) {
    completeItem(id, { exitSignal: 'GOAL_COMPLETE', costUsd: 0, runId: null, resultOutput: null });
    archiveItem(id);
  }
});

test('archiveItem removes item from work queue', () => {
  const itemId = enqueueWorkItem(
    'test-goal-archive',
    'dreamteam',
    'Test prompt for archive',
    'secondary',
    'backend',
  );

  // Claim and complete
  claimNextItem(process.pid);
  completeItem(itemId, {
    exitSignal: 'GOAL_COMPLETE',
    costUsd: 0.1,
    runId: null,
    resultOutput: null,
  });

  // Archive
  archiveItem(itemId);

  // Verify it is gone
  const allCompleted = getCompletedItems();
  const found = allCompleted.find(i => i.id === itemId);
  assert.equal(found, undefined, 'Archived item should not appear in completed items');
});

test('getQueuedCount returns correct count', () => {
  const before = getQueuedCount();

  const id1 = enqueueWorkItem('test-count-1', 'dreamteam', 'p1', 'secondary', 'backend');
  const id2 = enqueueWorkItem('test-count-2', 'dreamteam', 'p2', 'secondary', 'backend');

  const after = getQueuedCount();
  assert.equal(after - before, 2, 'Queued count should increase by 2');

  // Clean up
  const db = getDb();
  db.prepare('DELETE FROM work_queue WHERE goal_id IN (?, ?)').run('test-count-1', 'test-count-2');
});

// ===========================================================================
// Bonus: Cross-cutting validation
// ===========================================================================

console.log('\n--- cross-cutting validation ---');

test('classifyGoalType and classifyGoalArchetype agree on frontend goals', () => {
  const goal = makeGoal('Add sidebar navigation component');
  const goalType = classifyGoalType(goal);
  const archetype = classifyGoalArchetype(goal);
  assert.equal(goalType, 'ui-feature', 'Model router should classify as ui-feature');
  assert.equal(archetype, 'frontend', 'Archetype should classify as frontend');
});

test('classifyGoalType and classifyGoalArchetype agree on backend goals', () => {
  const goal = makeGoal('Add API endpoint for users');
  const goalType = classifyGoalType(goal);
  const archetype = classifyGoalArchetype(goal);
  assert.equal(goalType, 'backend-feature', 'Model router should classify as backend-feature');
  assert.equal(archetype, 'backend', 'Archetype should classify as backend');
});

test('classifyGoalType and classifyGoalArchetype agree on test goals', () => {
  const goal = makeGoal('Fix failing test in auth module');
  const goalType = classifyGoalType(goal);
  const archetype = classifyGoalArchetype(goal);
  assert.equal(goalType, 'test-fix', 'Model router should classify as test-fix');
  assert.equal(archetype, 'test-fix', 'Archetype should classify as test-fix');
});

test('classifyGoalType and isGoalUIRelated agree on UI goals', () => {
  const goal = makeGoal('Responsive layout for dashboard');
  const goalType = classifyGoalType(goal);
  const isUI = isGoalUIRelated(goal);
  assert.equal(goalType, 'ui-feature', 'Should be classified as ui-feature');
  assert.equal(isUI, true, 'Should be recognized as UI-related');
});

test('classifyGoalType and isGoalUIRelated agree on non-UI goals', () => {
  const goal = makeGoal('Fix database migration for orders');
  const goalType = classifyGoalType(goal);
  const isUI = isGoalUIRelated(goal);
  assert.ok(goalType !== 'ui-feature', 'Should not be classified as ui-feature');
  assert.equal(isUI, false, 'Should not be recognized as UI-related');
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
