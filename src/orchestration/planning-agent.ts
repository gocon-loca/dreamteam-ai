/**
 * Planning Agent — Cheap Haiku-based pre-dispatch decomposition for complex goals.
 *
 * Before a complex goal gets dispatched to an expensive model, a planning agent
 * (using Haiku/ancillary model) analyzes it and produces a decomposition into
 * smaller, independently-dispatchable sub-goals with dependency ordering.
 *
 * This saves cost by:
 * 1. Catching overly-broad goals early (cheaper to plan than to execute badly)
 * 2. Enabling parallel dispatch of independent sub-tasks
 * 3. Using cheap models for routine sub-tasks, expensive models only where needed
 */

import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { resolveModel } from './model-config.js';
import { classifyGoalArchetype } from './archetypes.js';
import { addGoal, updateGoal, getGoal } from './goal-crud.js';
import type { Goal } from './goal-types.js';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { createLogger } from '../utils/logger.js';

const slog = createLogger('planning-agent');

export interface PlanningResult {
  shouldDecompose: boolean;
  subGoals: Array<{
    title: string;
    description: string;
    complexity: 'routine' | 'complex';
    dependsOnIndex?: number; // index of the sub-goal this depends on
  }>;
  reasoning: string;
}

const PLANNING_PROMPT = `You are a planning agent. Analyze this goal and determine if it should be decomposed into smaller sub-goals.

RULES:
- STRONGLY prefer keeping goals as a single unit. Only decompose if the goal has clearly INDEPENDENT parts that touch DIFFERENT files/areas.
- NEVER decompose UI work that touches the same page/component — one agent should do the whole page change.
- Maximum 3 sub-goals. If you need more than 3, the goal should NOT be decomposed — it should run as one goal on a capable model.
- Each sub-goal must be completable by a single agent in one session
- Routine tasks (simple fixes, doc updates, config changes) should NOT be decomposed
- Output valid JSON only — no markdown, no explanation outside the JSON

OUTPUT FORMAT (strict JSON):
{
  "shouldDecompose": true/false,
  "reasoning": "Brief explanation of why/why not to decompose",
  "subGoals": [
    {
      "title": "Short title (max 60 chars)",
      "description": "What to do, acceptance criteria",
      "complexity": "routine" or "complex",
      "dependsOnIndex": null or index of dependency (0-based)
    }
  ]
}

If shouldDecompose is false, subGoals should be empty [].

GOAL TO ANALYZE:
Project: {PROJECT}
Title: {TITLE}
Description: {DESCRIPTION}
Complexity: {COMPLEXITY}
`;

/**
 * Run the planning agent on a complex goal.
 * Returns a PlanningResult with sub-goals if decomposition is warranted.
 * Returns null on error or if the goal is too simple.
 */
export function runPlanningAgent(goal: Goal): PlanningResult | null {
  // Only plan complex goals
  if (goal.complexity !== 'complex') return null;

  const prompt = PLANNING_PROMPT
    .replace('{PROJECT}', goal.project)
    .replace('{TITLE}', goal.title)
    .replace('{DESCRIPTION}', goal.description || '(no description)')
    .replace('{COMPLEXITY}', goal.complexity || 'unknown');

  try {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');
    const model = resolveModel('ancillary'); // Use cheapest model for planning

    const result = execSync(
      `${claudePath} --print --dangerously-skip-permissions --output-format json --model ${model}`,
      {
        input: prompt,
        timeout: 60_000, // 1 minute max for planning
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        env: cleanEnvForClaude(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // Parse Claude JSON output
    let output = result;
    try {
      const parsed = JSON.parse(result);
      output = parsed.result || parsed.content || result;
    } catch {
      // Not JSON wrapper — use raw output
    }

    // Extract JSON from the output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      slog.swallow('planning-no-json', new Error('No JSON in planning output'));
      return null;
    }

    const plan = JSON.parse(jsonMatch[0]) as PlanningResult;

    // Validate
    if (typeof plan.shouldDecompose !== 'boolean') return null;
    if (!Array.isArray(plan.subGoals)) return null;

    // Hard cap: max 3 sub-goals. More than that means the goal should run as one unit.
    if (plan.subGoals.length > 3) {
      slog.info(`Planning agent wanted ${plan.subGoals.length} sub-goals — too many, skipping decomposition`);
      return { shouldDecompose: false, subGoals: [], reasoning: `Capped: ${plan.subGoals.length} sub-goals exceeds max of 3 — run as single goal` };
    }

    return plan;
  } catch (e) {
    slog.swallow('planning-agent-error', e);
    return null;
  }
}

/**
 * Run planning and create child goals if decomposition is warranted.
 * Returns the created goal IDs, or empty array if no decomposition.
 */
export function planAndDecompose(goal: Goal): string[] {
  const plan = runPlanningAgent(goal);
  if (!plan || !plan.shouldDecompose || plan.subGoals.length === 0) {
    return [];
  }

  const createdIds: string[] = [];

  for (let i = 0; i < plan.subGoals.length; i++) {
    const sub = plan.subGoals[i];
    try {
      const childGoal = addGoal(
        goal.project,
        sub.title.slice(0, 80),
        sub.description,
        `planning:${goal.id}`,
      );

      // Set complexity from planning agent's assessment
      updateGoal(childGoal.id, { complexity: sub.complexity });

      // Wire up dependencies
      if (sub.dependsOnIndex != null && sub.dependsOnIndex >= 0 && sub.dependsOnIndex < createdIds.length) {
        updateGoal(childGoal.id, { dependsOn: [createdIds[sub.dependsOnIndex]] });
      }

      createdIds.push(childGoal.id);
    } catch (e) {
      slog.swallow('planning-create-child', e);
    }
  }

  // Mark the parent goal as completed (planning done — children will execute)
  if (createdIds.length > 0) {
    updateGoal(goal.id, {
      status: 'completed',
      output: `Decomposed into ${createdIds.length} sub-goals by planning agent.\nReasoning: ${plan.reasoning}`,
    });
  }

  return createdIds;
}
