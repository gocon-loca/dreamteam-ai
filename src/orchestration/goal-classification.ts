/**
 * Goal classification — model selection helpers, UI detection, and progress logging.
 */

import { logProgressToLinear } from '../integrations/linear.js';
import { getGoal, updateGoal } from './goal-crud.js';
import type { Goal } from './goal-types.js';

// Keywords that suggest routine work (Sonnet-appropriate)
export const DEFAULT_ROUTINE_KEYWORDS = [
  'fix test', 'fix failing', 'fix typo', 'update readme', 'update docs',
  'add comment', 'rename', 'clean up', 'lint', 'format', 'bump version',
  'remove unused', 'fix import', 'fix warning', 'update config',
];

export function getRoutineKeywords(): string[] {
  try {
    const { getConfig } = require('../dashboard/data/system-config.js');
    return getConfig('model-routing-keywords', DEFAULT_ROUTINE_KEYWORDS);
  } catch {
    return DEFAULT_ROUTINE_KEYWORDS;
  }
}

/**
 * Determine if a goal involves UI/UX work (for enhanced review)
 */
export function isGoalUIRelated(goal: Goal): boolean {
  const text = `${goal.title} ${goal.description || ''}`.toLowerCase();
  // Use word-boundary regex instead of .includes() to prevent substring matches.
  // e.g. "page" inside "homepage" is fine (still UI), but "form" inside "transform"
  // or "tab" inside "table" or "display" inside "displayName" would false-positive.
  const uiPattern = /\b(ui|ux|page|button|layout|search bar|form|modal|sidebar|navigation|tab|dashboard|component|responsive|mobile|display|visual|overhaul|redesign|card|list view|frontend|css|scss|tailwind|style)\b/;
  // "design" only counts as UI when paired with UI context
  if (uiPattern.test(text)) return true;
  if (/\bdesign\b/.test(text) && /\b(ui|ux|page|layout|component|screen|view|interface|visual)\b/.test(text)) return true;
  return false;
}

/**
 * Determine model tier for a goal based on complexity tag or heuristic.
 *
 * @deprecated Use selectModel() from model-router.ts for the 3-tier ladder.
 * This wrapper exists for backward compatibility (dashboard routes etc.).
 */
export function getModelForGoal(goal: Goal): 'primary' | 'secondary' {
  // Try new router, but collapse ancillary→secondary for backward compat
  try {
    const { selectModel } = require('./model-router.js');
    const decision = selectModel(goal);
    return decision.model === 'ancillary' ? 'secondary' : decision.model as 'primary' | 'secondary';
  } catch {
    // Fallback if model-router not built yet
  }

  // Explicit complexity tag takes priority
  if (goal.complexity === 'routine') return 'secondary';
  if (goal.complexity === 'complex') return 'primary';

  // Heuristic fallback: check title for routine keywords
  const lower = goal.title.toLowerCase();
  if (getRoutineKeywords().some(kw => lower.includes(kw))) return 'secondary';

  // Default to primary for safety
  return 'primary';
}

/**
 * Log progress/assumption to a goal (updates local + Linear)
 */
export function logGoalProgress(id: string, message: string, type: 'progress' | 'assumption' = 'progress'): void {
  const goal = getGoal(id);
  if (!goal) return;

  if (type === 'assumption') {
    updateGoal(id, {
      assumptions: [...goal.assumptions, message],
    });
  }

  // Log to Linear if connected
  if (goal.linearId) {
    logProgressToLinear(goal.linearId, message, type).catch(() => {});
  }
}
