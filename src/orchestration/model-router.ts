/**
 * Model Router — Intelligent model selection with cost estimation
 *
 * Uses a 3-tier model ladder:
 *   ancillary (cheapest) → secondary → primary (most capable)
 *
 * Default mapping: haiku → sonnet → opus (configurable via config/models.yaml)
 *
 * Uses historical success data from model_task_memory table to
 * pick the cheapest model that can reliably handle the goal type.
 * Falls back to heuristics when no history exists (cold start).
 *
 * Cost estimation includes cross-check overhead (~$0.19/goal on secondary tier).
 */

import type { Goal, GoalComplexity } from './goal-manager.js';
import type { ModelTier } from './model-config.js';
import { getModelConfig, getEstimatedCost, getLadder, getBackendsConfig } from './model-config.js';
import { getDb, generateId } from '../db/index.js';
import { getCostSummary } from '../db/execution-log.js';

// ── Types ──────────────────────────────────────────────────

export interface ModelDecision {
  model: ModelTier;
  confidence: number;         // 0-1, how confident we are in this choice
  reasoning: string;
  estimatedCostUsd: number;   // includes cross-check overhead
  fallbackModel: ModelTier;   // if this model fails, try next
}

export interface ModelTaskMemoryRow {
  id: string;
  goal_type: string;
  archetype: string | null;
  model: string;
  tools_used: string | null;
  context_docs: string | null;
  total_runs: number;
  successes: number;
  failures: number;
  promotions: number;
  avg_cost_usd: number | null;
  avg_duration_ms: number | null;
  updated_at: string;
}

// ── Constants ──────────────────────────────────────────────

/** Cross-check runs on Sonnet after every goal — measured at ~$0.19 */
const CROSS_CHECK_OVERHEAD_USD = 0.19;

/** Minimum success rate to trust a model for a goal type */
const MIN_SUCCESS_RATE = 0.70;

/** Minimum runs before we trust historical data */
const MIN_RUNS_FOR_CONFIDENCE = 3;

/** Maximum promotions per goal before giving up */
const MAX_PROMOTIONS = 2;

/** Model capability order: ancillary → secondary → primary */
const MODEL_LADDER: ModelTier[] = ['ancillary', 'secondary', 'primary'];

// ── Goal Type Classification ───────────────────────────────

/**
 * Classify a goal into a type category for model routing.
 * Used as key into model_task_memory for historical lookup.
 */
export function classifyGoalType(goal: Goal): string {
  const text = `${goal.title} ${goal.description || ''}`.toLowerCase();

  // Trivial/routine tasks — check first since "fix typo" shouldn't match "bug-fix"
  if (/\b(lint|format|typo|bump version|remove unused|fix import|fix warning|fix typo|update config)\b/.test(text)) return 'trivial';

  if (/\b(fix test|fix failing|failing test|test failure|broken test)\b/.test(text)) return 'test-fix';
  if (/\b(fix bug|bug fix|regression|crash|broken|error handling)\b/.test(text)) return 'bug-fix';
  // "design" alone is too broad — "design the API schema" is not UI.
  // "page" is borderline but usually UI in practice.
  if (/\b(ui|frontend|layout|css|style|button|page|component|responsive|sidebar|modal|dashboard|card|tab)\b/.test(text)) return 'ui-feature';
  if (/\bdesign\b/.test(text) && /\b(ui|ux|page|layout|component|screen|view|interface|visual)\b/.test(text)) return 'ui-feature';
  if (/\b(api|endpoint|route|backend|server|database|query|migration|schema)\b/.test(text)) return 'backend-feature';
  if (/\b(refactor|cleanup|reorganize|simplify|extract|rename)\b/.test(text)) return 'refactor';
  if (/\b(research|patent|competitive analysis|strategy|investigate|survey|prior art|landscape|feasibility|spike)\b/.test(text)) return 'research';
  if (/\b(doc|readme|comment|jsdoc|guide|update docs)\b/.test(text)) return 'docs';
  // "config" alone is too broad — any goal mentioning config files matches.
  // Require compound config phrases or match specific devops keywords.
  if (/\b(deploy|docker|infra|devops|pipeline|build system|build pipeline|build process)\b/.test(text)) return 'devops';
  if (/\b(ci|cd)\b/.test(text) && /\b(pipeline|deploy|build|github|action|workflow|jenkins)\b/.test(text)) return 'devops';
  if (/\bconfig\b/.test(text) && /\b(deploy|ci|cd|docker|infra|server|nginx|env|environment|k8s|cloud)\b/.test(text)) return 'devops';
  if (/\b(e2e|integration test|cross-project|multi-project)\b/.test(text)) return 'integration';
  // "add" and "build" alone are too broad — "add a button" shouldn't default to opus.
  // Only match "new feature", "implement", "architect", "design system", or
  // compound phrases like "add new ..." / "build ... system".
  if (/\b(architect|design system|new feature|implement)\b/.test(text)) return 'new-feature';
  if (/\b(create|add|build)\s+(?:new\s+)?\w+\s+(system|service|module|framework|engine|platform|pipeline)\b/.test(text)) return 'new-feature';

  return 'general';
}

// ── Heuristic Defaults (cold start) ───────────────────────

/** Default model for each goal type when no historical data exists */
const HEURISTIC_DEFAULTS: Record<string, ModelTier> = {
  'trivial': 'ancillary',
  'docs': 'ancillary',
  'test-fix': 'secondary',
  'bug-fix': 'secondary',
  'refactor': 'secondary',
  'ui-feature': 'primary',       // UI work needs opus — sonnet produces broken results that pass smoke tests
  'backend-feature': 'secondary',
  'devops': 'secondary',
  'research': 'primary',
  'new-feature': 'primary',
  'integration': 'primary',
  'general': 'primary',
};

/** Map complexity tag to a floor model (won't go below this) */
function getComplexityFloor(complexity?: GoalComplexity): ModelTier | null {
  if (complexity === 'complex') return 'primary'; // complex goals go straight to opus
  return null;
}

/** Goal types that should always use primary (opus) regardless of history */
const PRIMARY_ONLY_TYPES = new Set(['ui-feature']);

// ── Core Router ────────────────────────────────────────────

/**
 * Select the best model for a goal based on historical data and heuristics.
 *
 * Decision process:
 * 1. Classify goal type from title + description
 * 2. Query model_task_memory: which model has >70% success rate at lowest cost?
 * 3. If no history (cold start), use heuristic defaults
 * 4. Factor remaining daily budget — if tight, prefer cheaper model
 * 5. Apply complexity floor (complex goals can't go below sonnet)
 * 6. Return decision with fallback model and cost estimate
 */
export function selectModel(goal: Goal, options?: {
  budgetRemainingUsd?: number;
  archetype?: string;
}): ModelDecision {
  const goalType = classifyGoalType(goal);
  const memory = getModelTaskMemory(goalType, options?.archetype);

  let model: ModelTier;
  let confidence: number;
  let reasoning: string;

  // Try historical data first
  const historicalPick = pickFromHistory(memory, goalType);

  if (historicalPick) {
    model = historicalPick.model;
    confidence = historicalPick.confidence;
    reasoning = historicalPick.reasoning;
  } else {
    // Cold start: use heuristic
    model = HEURISTIC_DEFAULTS[goalType] || 'primary';

    // Also respect explicit complexity tag
    if (goal.complexity === 'routine' && model === 'primary') {
      model = 'secondary';
    }
    if (goal.complexity === 'complex') {
      model = 'primary';
    }

    confidence = 0.5;
    reasoning = `No history for "${goalType}" — using heuristic default`;
  }

  // Force primary for goal types where cheaper models produce unreliable results
  if (PRIMARY_ONLY_TYPES.has(goalType) && model !== 'primary') {
    model = 'primary';
    reasoning += ` (forced to primary — ${goalType} needs opus for reliable results)`;
  }

  // Apply complexity floor
  const floor = getComplexityFloor(goal.complexity);
  if (floor) {
    const floorIndex = MODEL_LADDER.indexOf(floor);
    const modelIndex = MODEL_LADDER.indexOf(model);
    if (modelIndex < floorIndex) {
      model = floor;
      reasoning += ` (raised to ${floor} for complexity=${goal.complexity})`;
    }
  }

  // Budget pressure: if budget is tight, try to go cheaper
  if (options?.budgetRemainingUsd !== undefined && options.budgetRemainingUsd < 5) {
    const modelIndex = MODEL_LADDER.indexOf(model);
    if (modelIndex > 0 && options.budgetRemainingUsd < 2) {
      // Very tight budget — downgrade one tier
      model = MODEL_LADDER[modelIndex - 1];
      reasoning += ` (downgraded due to low budget: $${options.budgetRemainingUsd.toFixed(2)} remaining)`;
      confidence *= 0.8;
    }
  }

  // Determine fallback (next tier up)
  const modelIndex = MODEL_LADDER.indexOf(model);
  const fallbackModel = modelIndex < MODEL_LADDER.length - 1
    ? MODEL_LADDER[modelIndex + 1]
    : 'primary';

  // Estimate total cost including cross-check overhead
  const agentCost = getHistoricalAvgCost(memory, model) ?? getEstimatedCost(model);
  const estimatedCostUsd = agentCost + CROSS_CHECK_OVERHEAD_USD;

  return {
    model,
    confidence,
    reasoning: `[${goalType}] ${reasoning}`,
    estimatedCostUsd,
    fallbackModel,
  };
}

/**
 * Pick the cheapest model with acceptable success rate from history.
 * Returns null if insufficient data.
 */
function pickFromHistory(
  memory: ModelTaskMemoryRow[],
  goalType: string,
): { model: ModelTier; confidence: number; reasoning: string } | null {
  if (memory.length === 0) return null;

  // Check each model tier from cheapest to most expensive
  for (const tier of MODEL_LADDER) {
    const entry = memory.find(m => m.model === tier);
    if (!entry) continue;
    if (entry.total_runs < MIN_RUNS_FOR_CONFIDENCE) continue;

    const rawRate = entry.successes / entry.total_runs;
    const penalty = getFeedbackPenalty(tier);
    const successRate = Math.max(0, rawRate + penalty / 100);

    if (successRate >= MIN_SUCCESS_RATE) {
      return {
        model: tier,
        confidence: Math.min(0.95, successRate),
        reasoning: `Historical: ${tier} has ${(successRate * 100).toFixed(0)}% success rate over ${entry.total_runs} runs for "${goalType}" (avg $${entry.avg_cost_usd?.toFixed(2) ?? '?'})${penalty < 0 ? ` [feedback penalty: ${penalty}pp]` : ''}`,
      };
    }
  }

  // No model meets threshold — look for the best performer
  const sorted = [...memory]
    .filter(m => m.total_runs >= MIN_RUNS_FOR_CONFIDENCE)
    .sort((a, b) => (b.successes / b.total_runs) - (a.successes / a.total_runs));

  if (sorted.length > 0) {
    const best = sorted[0];
    const rawRate = best.successes / best.total_runs;
    const penalty = getFeedbackPenalty(best.model);
    const successRate = Math.max(0, rawRate + penalty / 100);
    return {
      model: best.model as ModelTier,
      confidence: successRate * 0.7, // Lower confidence since nothing meets threshold
      reasoning: `Best available: ${best.model} at ${(successRate * 100).toFixed(0)}% (below ${MIN_SUCCESS_RATE * 100}% threshold)${penalty < 0 ? ` [feedback penalty: ${penalty}pp]` : ''}`,
    };
  }

  return null;
}

function getHistoricalAvgCost(memory: ModelTaskMemoryRow[], model: ModelTier): number | null {
  const entry = memory.find(m => m.model === model);
  return entry?.avg_cost_usd ?? null;
}

// ── Model Task Memory CRUD ─────────────────────────────────

/**
 * Get model performance history for a goal type, optionally filtered by archetype.
 */
export function getModelTaskMemory(goalType: string, archetype?: string): ModelTaskMemoryRow[] {
  const db = getDb();

  if (archetype) {
    return db.prepare(
      'SELECT * FROM model_task_memory WHERE goal_type = ? AND (archetype = ? OR archetype IS NULL) ORDER BY model ASC'
    ).all(goalType, archetype) as ModelTaskMemoryRow[];
  }

  return db.prepare(
    'SELECT * FROM model_task_memory WHERE goal_type = ? ORDER BY model ASC'
  ).all(goalType) as ModelTaskMemoryRow[];
}

/**
 * Get feedback-based penalty for a model. Queries human_feedback joined
 * with agent_runs to find negative/redo feedback for goals that ran on
 * this model. Penalty: negative=-20pp, redo=-40pp to effective success rate.
 */
export function getFeedbackPenalty(model: string): number {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT hf.type, COUNT(DISTINCT hf.goal_id) as cnt
      FROM human_feedback hf
      JOIN agent_runs ar ON hf.goal_id = ar.goal_id
      WHERE ar.model_assigned = ? AND hf.type IN ('negative', 'redo')
      GROUP BY hf.type
    `).all(model) as Array<{ type: string; cnt: number }>;

    let penalty = 0;
    for (const row of rows) {
      if (row.type === 'negative') penalty += row.cnt * -20;
      if (row.type === 'redo') penalty += row.cnt * -40;
    }
    // Cap penalty at -100 to prevent negative success rates
    return Math.max(-100, penalty);
  } catch { return 0; }
}

/**
 * Record the outcome of a goal execution into model_task_memory.
 * Upserts: creates or updates the aggregate row for (goal_type, archetype, model).
 */
export function recordOutcome(opts: {
  goalType: string;
  archetype?: string;
  model: ModelTier;
  success: boolean;
  costUsd?: number;
  durationMs?: number;
  promoted?: boolean;
}): void {
  const db = getDb();

  const existing = db.prepare(
    'SELECT * FROM model_task_memory WHERE goal_type = ? AND model = ? AND (archetype = ? OR (archetype IS NULL AND ? IS NULL))'
  ).get(opts.goalType, opts.model, opts.archetype ?? null, opts.archetype ?? null) as ModelTaskMemoryRow | undefined;

  if (existing) {
    const newTotal = existing.total_runs + 1;
    const newSuccesses = existing.successes + (opts.success ? 1 : 0);
    const newFailures = existing.failures + (opts.success ? 0 : 1);
    const newPromotions = existing.promotions + (opts.promoted ? 1 : 0);

    // Running average for cost and duration
    const newAvgCost = opts.costUsd !== undefined
      ? ((existing.avg_cost_usd ?? 0) * existing.total_runs + opts.costUsd) / newTotal
      : existing.avg_cost_usd;
    const newAvgDuration = opts.durationMs !== undefined
      ? ((existing.avg_duration_ms ?? 0) * existing.total_runs + opts.durationMs) / newTotal
      : existing.avg_duration_ms;

    db.prepare(`
      UPDATE model_task_memory SET
        total_runs = ?, successes = ?, failures = ?, promotions = ?,
        avg_cost_usd = ?, avg_duration_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newTotal, newSuccesses, newFailures, newPromotions,
      newAvgCost, newAvgDuration, new Date().toISOString(),
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO model_task_memory (
        id, goal_type, archetype, model,
        total_runs, successes, failures, promotions,
        avg_cost_usd, avg_duration_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(),
      opts.goalType,
      opts.archetype ?? null,
      opts.model,
      1,
      opts.success ? 1 : 0,
      opts.success ? 0 : 1,
      opts.promoted ? 1 : 0,
      opts.costUsd ?? null,
      opts.durationMs ?? null,
      new Date().toISOString(),
    );
  }
}

/**
 * Flip one success→failure when cross-check finds CONCERN.
 * Corrects the initial optimistic success recording.
 */
export function recordQualityAdjustment(opts: {
  goalType: string;
  archetype?: string;
  model: ModelTier;
}): void {
  const db = getDb();

  const existing = db.prepare(
    'SELECT * FROM model_task_memory WHERE goal_type = ? AND model = ? AND (archetype = ? OR (archetype IS NULL AND ? IS NULL))'
  ).get(opts.goalType, opts.model, opts.archetype ?? null, opts.archetype ?? null) as ModelTaskMemoryRow | undefined;

  if (existing && existing.successes > 0) {
    db.prepare(`
      UPDATE model_task_memory SET successes = successes - 1, failures = failures + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), existing.id);
  }
}

/**
 * Promote to the next model tier. Returns the promoted model.
 * Returns null if already at max (opus) or max promotions exceeded.
 */
export function promoteModel(
  currentModel: ModelTier,
  promotionCount: number,
  reason: string,
): { model: ModelTier; reason: string } | null {
  if (promotionCount >= MAX_PROMOTIONS) {
    return null; // Max promotions reached
  }

  const currentIndex = MODEL_LADDER.indexOf(currentModel);
  if (currentIndex >= MODEL_LADDER.length - 1) {
    return null; // Already at primary (most capable)
  }

  const promoted = MODEL_LADDER[currentIndex + 1];
  return {
    model: promoted,
    reason: `Promoted ${currentModel}→${promoted}: ${reason}`,
  };
}

// ── Budget Helpers ─────────────────────────────────────────

/**
 * Get real cost data from SQLite for budget tracking.
 */
export function getRealBudgetData(): {
  todayUsd: number;
  weekUsd: number;
  runCountToday: number;
  byProject: Record<string, number>;
  byModel: Record<string, number>;
} {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  const todayData = getCostSummary(todayStart.toISOString());
  const weekData = getCostSummary(weekStart.toISOString());

  return {
    todayUsd: todayData.totalCostUsd,
    weekUsd: weekData.totalCostUsd,
    runCountToday: todayData.runCount,
    byProject: todayData.byProject,
    byModel: todayData.byModel,
  };
}

/**
 * Estimate total cost for a goal (agent + cross-check).
 */
export function estimateGoalCost(model: ModelTier): number {
  return getEstimatedCost(model) + CROSS_CHECK_OVERHEAD_USD;
}

/**
 * Predict success probability for a goal based on historical model_task_memory data.
 * Returns probability (0-1) and reasoning.
 * Used by supervisor to warn about likely-to-fail goals before dispatch.
 */
export function predictSuccessProbability(goal: Goal, archetype?: string): {
  probability: number;
  reasoning: string;
  recommendedModel: ModelTier;
  expectedAttempts: number;
} {
  const goalType = classifyGoalType(goal);
  const memory = getModelTaskMemory(goalType, archetype);

  if (memory.length === 0) {
    return {
      probability: 0.5,
      reasoning: `No historical data for "${goalType}" goals — cold start`,
      recommendedModel: HEURISTIC_DEFAULTS[goalType] || 'primary',
      expectedAttempts: 2,
    };
  }

  // Find the best-performing model for this goal type
  let bestRate = 0;
  let bestModel: ModelTier = 'primary';
  let bestEntry: ModelTaskMemoryRow | null = null;

  for (const entry of memory) {
    if (entry.total_runs < MIN_RUNS_FOR_CONFIDENCE) continue;
    const rate = entry.successes / entry.total_runs;
    if (rate > bestRate) {
      bestRate = rate;
      bestModel = entry.model as ModelTier;
      bestEntry = entry;
    }
  }

  if (!bestEntry) {
    return {
      probability: 0.5,
      reasoning: `Insufficient history for "${goalType}" (${memory.reduce((sum, m) => sum + m.total_runs, 0)} runs, need ${MIN_RUNS_FOR_CONFIDENCE}+ per model)`,
      recommendedModel: HEURISTIC_DEFAULTS[goalType] || 'primary',
      expectedAttempts: 2,
    };
  }

  // Factor in goal complexity
  let complexityMultiplier = 1.0;
  if (goal.complexity === 'complex') complexityMultiplier = 0.8;
  if (goal.complexity === 'routine') complexityMultiplier = 1.1;

  // Factor in retry history
  const attemptCount = goal.attemptCount || 0;
  const retryPenalty = attemptCount > 0 ? Math.max(0.5, 1 - attemptCount * 0.15) : 1.0;

  const probability = Math.min(0.95, bestRate * complexityMultiplier * retryPenalty);
  const expectedAttempts = probability > 0.8 ? 1 : probability > 0.5 ? 2 : 3;

  return {
    probability,
    reasoning: `Based on ${bestEntry.total_runs} runs of "${goalType}" on ${bestModel}: ${(bestRate * 100).toFixed(0)}% base rate${attemptCount > 0 ? `, retry penalty (attempt ${attemptCount + 1})` : ''}${goal.complexity === 'complex' ? ', complexity discount' : ''}`,
    recommendedModel: bestModel,
    expectedAttempts,
  };
}

// ── Backend Selection ──────────────────────────────────────

export interface BackendDecision {
  backend: string;
  reasoning: string;
}

/**
 * Select the CLI backend for a goal.
 *
 * Checks:
 * 1. Explicit routing rules from config (goal-type → backend)
 * 2. Default backend as fallback
 */
export function selectBackend(goal: Goal, archetype?: string): BackendDecision {
  const config = getBackendsConfig();
  const goalType = classifyGoalType(goal);

  // Check explicit routing rules
  if (config.backendRouting[goalType]) {
    const backend = config.backendRouting[goalType];
    if (config.backends[backend]) {
      return {
        backend,
        reasoning: `Routed to ${backend} by goal type "${goalType}" rule`,
      };
    }
  }

  // Check archetype-based routing
  if (archetype && config.backendRouting[archetype]) {
    const backend = config.backendRouting[archetype];
    if (config.backends[backend]) {
      return {
        backend,
        reasoning: `Routed to ${backend} by archetype "${archetype}" rule`,
      };
    }
  }

  // Default backend
  return {
    backend: config.defaultBackend,
    reasoning: `Default backend: ${config.defaultBackend}`,
  };
}
