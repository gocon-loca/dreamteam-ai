/**
 * Goal Manager - Manages autonomous goals for projects
 *
 * Goals are always stored locally in JSON (source of truth),
 * and optionally synced to Linear for kanban visibility.
 *
 * This is a BARREL FILE that re-exports from focused modules:
 *   goal-types.ts          — Pure type definitions
 *   goal-crud.ts           — Storage, validation, CRUD
 *   goal-validation.ts     — Gate 0 sanity check
 *   goal-debrief.ts        — Debrief parsing, lessons, retrieval
 *   goal-classification.ts — Model selection, UI detection, progress logging
 *   goal-lifecycle.ts      — Post-completion hooks orchestrator
 */

// Types
export type { GoalStatus, GoalComplexity, ReviewStatus, Goal, GoalsStore, StructuredDebrief } from './goal-types.js';

// CRUD — storage, validation, read/write
export {
  validateGoalSpec,
  findSimilarGoals,
  addGoal,
  addJamEnrichedGoal,
  getGoal,
  getGoalsByProject,
  getPendingGoals,
  getInProgressGoals,
  getPendingReviewGoals,
  checkDependencies,
  getAllGoals,
  findGoalsByTitle,
  findCompletedGoalsByTitle,
  countAutoGoalsCreatedToday,
  updateGoal,
  markGoalStarted,
  markGoalCompleted,
  markGoalBlocked,
  auditBranchBeforeBlocking,
  markGoalFailed,
  deleteGoal,
  clearCompletedGoals,
  getGoalsSummary,
} from './goal-crud.js';

// Validation — Gate 0 sanity check
export { validateCompletion, COMPLETION_SURRENDER_PATTERNS } from './goal-validation.js';
export type { CompletionValidation } from './goal-validation.js';

// Debrief — parsing, lessons, retrieval
export { recordLesson, parseDebrief, getRecentDebriefs } from './goal-debrief.js';

// Classification — model selection, UI detection, progress logging
export {
  DEFAULT_ROUTINE_KEYWORDS,
  getRoutineKeywords,
  isGoalUIRelated,
  getModelForGoal,
  logGoalProgress,
} from './goal-classification.js';

// Lifecycle — post-completion hooks
export { runPostCompletionHooks, formatDebriefForLinear } from './goal-lifecycle.js';
