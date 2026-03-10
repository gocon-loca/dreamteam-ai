/**
 * Goal Triage — Green/Yellow confidence classification
 *
 * Default: GREEN (auto-dispatch). Only escalate to yellow for:
 * - Cost estimate > $2.00
 * - Same goal type has failed 2+ times in model_task_memory
 * - Opus complexity with zero prior success history for that archetype
 *
 * Never re-triage human-approved or E2E auto-fix goals.
 */

import type { Goal } from './goal-manager.js';
import { selectModel, classifyGoalType, estimateGoalCost, getModelTaskMemory } from './model-router.js';
import { classifyGoalArchetype } from './archetypes.js';
import { getDb } from '../db/index.js';

// ── Types ──────────────────────────────────────────────────

export type GoalConfidence = 'green' | 'yellow';

export interface TriagedGoal {
  goal: Goal;
  confidence: GoalConfidence;
  confidenceReasons: string[];
  estimatedCostUsd: number;
  similarPastGoals: Array<{ goalId: string; title: string; success: boolean; model: string }>;
}

// ── Configuration ──────────────────────────────────────────

/** Maximum estimated cost for auto-dispatch (USD) */
const COST_THRESHOLD_USD = 2.0;

/** Failure count in model_task_memory that triggers yellow */
const FAILURE_THRESHOLD = 2;

// ── Core Triage Logic ──────────────────────────────────────

/**
 * Triage a goal: classify as green (auto-dispatch) or yellow (hold).
 *
 * Default: GREEN.
 * Escalate to YELLOW only when:
 * 1. Cost estimate > $2.00
 * 2. Same goal type has 2+ failures in model_task_memory
 * 3. Opus complexity with zero prior success for that archetype
 */
export function triageGoal(goal: Goal): TriagedGoal {
  const reasons: string[] = [];
  let confidence: GoalConfidence = 'green';

  // ── Never re-triage these ──────────────────────────────
  // Human-approved goals (via proposal confirm or manual approve)
  if (goal.confidence === 'green' && goal.approvedAt) {
    return {
      goal,
      confidence: 'green',
      confidenceReasons: ['Human-approved'],
      estimatedCostUsd: 0,
      similarPastGoals: [],
    };
  }

  // Explicitly tagged green (E2E auto-fix, etc.)
  if (goal.confidence === 'green') {
    return {
      goal,
      confidence: 'green',
      confidenceReasons: ['Explicitly tagged green'],
      estimatedCostUsd: 0,
      similarPastGoals: [],
    };
  }

  // Director tagged as yellow — respect it
  if (goal.confidence === 'yellow') {
    return {
      goal,
      confidence: 'yellow',
      confidenceReasons: ['Director tagged as yellow'],
      estimatedCostUsd: 0,
      similarPastGoals: [],
    };
  }

  // ── Check 1: Cost estimate ─────────────────────────────
  let estimatedCostUsd = 0;
  try {
    const decision = selectModel(goal);
    estimatedCostUsd = decision.estimatedCostUsd;
  } catch {
    estimatedCostUsd = estimateGoalCost('primary'); // worst case
  }

  if (estimatedCostUsd > COST_THRESHOLD_USD) {
    confidence = 'yellow';
    reasons.push(`Estimated cost $${estimatedCostUsd.toFixed(2)} > $${COST_THRESHOLD_USD} threshold`);
  }

  // ── Check 2: Failure history in model_task_memory ──────
  const goalType = classifyGoalType(goal);
  const archetype = classifyGoalArchetype(goal);
  const memory = getModelTaskMemory(goalType, archetype);

  const totalFailures = memory.reduce((sum, row) => sum + row.failures, 0);
  if (totalFailures >= FAILURE_THRESHOLD) {
    confidence = 'yellow';
    reasons.push(`${totalFailures} failures in model_task_memory for type "${goalType}"`);
  }

  // ── Check 3: Opus complexity with no success history ───
  if (goal.complexity === 'complex') {
    const hasAnySuccess = memory.some(row => row.successes > 0);
    if (!hasAnySuccess && memory.length > 0) {
      confidence = 'yellow';
      reasons.push('Complex goal with zero success history for this archetype');
    }
    // Cold start (no memory at all) stays green — don't penalize new goal types
  }

  // Default green reason
  if (confidence === 'green') {
    reasons.push('All triage checks passed');
  }

  return {
    goal,
    confidence,
    confidenceReasons: reasons,
    estimatedCostUsd,
    similarPastGoals: [],
  };
}

/**
 * Get all pending goals triaged as green (safe to auto-dispatch).
 */
export function getGreenGoals(pendingGoals: Goal[]): TriagedGoal[] {
  return pendingGoals
    .map(g => triageGoal(g))
    .filter(t => t.confidence === 'green');
}

/**
 * Get all pending goals triaged as yellow (need human review).
 */
export function getYellowGoals(pendingGoals: Goal[]): TriagedGoal[] {
  return pendingGoals
    .map(g => triageGoal(g))
    .filter(t => t.confidence === 'yellow');
}

/**
 * Promote a yellow goal to green. Optionally adds context to description.
 */
export function promoteToGreen(goal: Goal, additionalContext?: string): Goal {
  const updates: Partial<Goal> = {};

  if (additionalContext) {
    updates.description = (goal.description || '') + `\n\n--- Approved with context ---\n${additionalContext}`;
  }

  // Tag as approved (confidence override)
  goal.confidence = 'green';
  goal.approvedAt = new Date().toISOString();

  return { ...goal, ...updates };
}

/**
 * Format yellow goals for display (Telegram / digest).
 */
export function formatHeldGoals(yellowGoals: TriagedGoal[]): string {
  if (yellowGoals.length === 0) return 'No goals held for review.';

  const lines = [`\u23F8\uFE0F ${yellowGoals.length} goal(s) held for your input:`];
  for (let i = 0; i < yellowGoals.length; i++) {
    const tg = yellowGoals[i];
    const reasons = tg.confidenceReasons.join(', ');
    lines.push(`${i + 1}. "${tg.goal.title}" [${tg.goal.project}]`);
    lines.push(`   Reasons: ${reasons}`);
    lines.push(`   Est: $${tg.estimatedCostUsd.toFixed(2)} | /approve ${tg.goal.id}`);
  }
  return lines.join('\n');
}
