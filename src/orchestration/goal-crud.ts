/**
 * Goal CRUD operations — storage, validation, and all read/write functions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  isLinearEnabled,
  syncGoalToLinear,
  logProgressToLinear,
} from '../integrations/linear.js';
import { getProject } from '../projects/registry.js';
import type { Goal, GoalsStore } from './goal-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const GOALS_FILE = join(DATA_DIR, 'goals.json');

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadGoals(): GoalsStore {
  ensureDataDir();

  if (!existsSync(GOALS_FILE)) {
    return { goals: [], lastUpdated: new Date().toISOString() };
  }

  const content = readFileSync(GOALS_FILE, 'utf-8');
  let store = JSON.parse(content) as GoalsStore;

  // Migrate legacy bare array format to GoalsStore wrapper
  if (Array.isArray(store)) {
    store = { goals: store as unknown as Goal[], lastUpdated: new Date().toISOString() };
  }

  // Rehydrate dates
  store.goals = store.goals.map(g => ({
    ...g,
    createdAt: new Date(g.createdAt),
    startedAt: g.startedAt ? new Date(g.startedAt) : undefined,
    completedAt: g.completedAt ? new Date(g.completedAt) : undefined,
    assumptions: g.assumptions ?? [],
    iterations: g.iterations ?? 0,
  }));

  return store;
}

export function saveGoals(store: GoalsStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(GOALS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Sync a goal to Linear (fire-and-forget, non-blocking)
 */
export async function syncToLinear(goal: Goal): Promise<void> {
  if (!isLinearEnabled()) return;

  try {
    const linearId = await syncGoalToLinear(goal);
    if (linearId && linearId !== goal.linearId) {
      // Update local storage with the Linear ID
      const store = loadGoals();
      const index = store.goals.findIndex(g => g.id === goal.id);
      if (index !== -1) {
        store.goals[index].linearId = linearId;
        saveGoals(store);
      }
    }
  } catch (error) {
    // Non-fatal: Linear sync failure shouldn't block local operations
    console.error(`Linear sync failed for goal ${goal.id}:`, error);
  }
}

function generateId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * Determine if a goal involves UI/UX work (for enhanced review).
 * Imported here to avoid circular dependency — used by validateGoalSpec.
 */
function isGoalUIRelatedInternal(goal: Goal): boolean {
  const text = `${goal.title} ${goal.description || ''}`.toLowerCase();
  const uiPattern = /\b(ui|ux|page|button|layout|search bar|form|modal|sidebar|navigation|tab|dashboard|component|responsive|mobile|display|visual|overhaul|redesign|card|list view|frontend|css|scss|tailwind|style)\b/;
  if (uiPattern.test(text)) return true;
  if (/\bdesign\b/.test(text) && /\b(ui|ux|page|layout|component|screen|view|interface|visual)\b/.test(text)) return true;
  return false;
}

/**
 * Validate goal spec quality. Returns warnings (non-blocking).
 * Goals with warnings still get created, but warnings are logged.
 */
export function validateGoalSpec(title: string, description?: string, complexity?: string): string[] {
  const warnings: string[] = [];
  const desc = description || '';

  // Check description exists for complex goals
  if (complexity === 'complex' && desc.length < 100) {
    warnings.push('Complex goal has short description (<100 chars). Add acceptance criteria and UX details.');
  }

  // Check for acceptance criteria
  const hasAcceptanceCriteria = /acceptance criteria|must|should|verify|ensure/i.test(desc);
  if (desc.length > 0 && !hasAcceptanceCriteria) {
    warnings.push('No acceptance criteria found. Add specific "done" criteria.');
  }

  // For UI-related goals, check for UX specifics
  const isUI = isGoalUIRelatedInternal({ title, description: desc } as Goal);
  if (isUI && desc.length > 0) {
    const hasLayoutDetails = /width|height|size|font|spacing|padding|margin|position|layout|px|rem|full.?width/i.test(desc);
    const hasInteractionDetails = /click|hover|tap|submit|navigate|redirect|select|toggle/i.test(desc);
    if (!hasLayoutDetails && !hasInteractionDetails) {
      warnings.push('UI goal missing visual/interaction details. Specify layout, sizing, and behavior.');
    }
  }

  // Check for anti-requirements
  const hasAntiReqs = /do not|don't|do NOT|avoid|never|anti.?requirement/i.test(desc);
  if (isUI && !hasAntiReqs && desc.length > 50) {
    warnings.push('UI goal has no anti-requirements. Consider adding "Do NOT..." constraints.');
  }

  // Check title length
  if (title.length > 80) {
    warnings.push(`Title too long (${title.length} chars). Keep under 80.`);
  }

  // Check for bundled features (multiple "and"s in title)
  const andCount = (title.match(/\band\b/gi) || []).length;
  if (andCount >= 2) {
    warnings.push('Title has multiple "and"s — consider splitting into separate goals.');
  }

  return warnings;
}

/**
 * Find goals similar to a given title within the same project.
 * Uses word overlap scoring to detect duplicates/near-duplicates.
 * Returns matches sorted by similarity (highest first).
 */
export function findSimilarGoals(
  project: string,
  title: string,
  opts?: { includeStatuses?: string[]; sinceMs?: number }
): Array<{ goal: Goal; similarity: number }> {
  const store = loadGoals();
  const statuses = opts?.includeStatuses || ['pending', 'in-progress', 'completed', 'blocked'];
  const cutoff = opts?.sinceMs ? new Date(Date.now() - opts.sinceMs) : null;

  // Extract meaningful words (3+ chars, lowercase, deduplicated)
  const extractWords = (s: string) => {
    const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'fix', 'add', 'update', 'page']);
    return [...new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w))
    )];
  };

  const titleWords = extractWords(title);
  if (titleWords.length === 0) return [];

  const matches: Array<{ goal: Goal; similarity: number }> = [];

  for (const g of store.goals) {
    if (g.project !== project) continue;
    if (!statuses.includes(g.status)) continue;
    if (cutoff && g.createdAt && new Date(g.createdAt) < cutoff) continue;

    const gWords = extractWords(g.title);
    if (gWords.length === 0) continue;

    // Jaccard similarity: intersection / union
    const intersection = titleWords.filter(w => gWords.includes(w)).length;
    const union = new Set([...titleWords, ...gWords]).size;
    const similarity = union > 0 ? intersection / union : 0;

    if (similarity >= 0.4) {
      matches.push({ goal: g, similarity });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

export function addGoal(
  project: string,
  title: string,
  description?: string,
  source?: string,
  enrichment?: {
    complexity?: 'routine' | 'complex';
    archetype?: 'backend' | 'frontend' | 'fullstack';
    jamContext?: Goal['jamContext'];
  },
): Goal {
  const store = loadGoals();

  const goal: Goal = {
    id: generateId(),
    project,
    title,
    description,
    status: 'pending',
    createdAt: new Date(),
    assumptions: [],
    iterations: 0,
    ...(source ? { source } : {}),
    ...(enrichment?.complexity ? { complexity: enrichment.complexity } : {}),
    ...(enrichment?.archetype ? { archetype: enrichment.archetype } : {}),
    ...(enrichment?.jamContext ? { jamContext: enrichment.jamContext } : {}),
  };

  // Validate spec quality (non-blocking — logs warnings)
  const warnings = validateGoalSpec(title, description);
  if (warnings.length > 0) {
    console.warn(`[GoalSpec] Warnings for "${title.slice(0, 50)}":`);
    warnings.forEach(w => console.warn(`  - ${w}`));
  }

  // Deduplication check — warn on similar existing goals (non-blocking)
  const similar = findSimilarGoals(project, title, { sinceMs: 7 * 24 * 60 * 60 * 1000 });
  if (similar.length > 0) {
    const top = similar[0];
    const pct = Math.round(top.similarity * 100);
    console.warn(`[GoalDedup] "${title.slice(0, 50)}" is ${pct}% similar to "${top.goal.title.slice(0, 50)}" (${top.goal.status}, ${top.goal.id})`);
    if (similar.length > 1) {
      console.warn(`[GoalDedup] ${similar.length} total similar goals found in ${project}`);
    }
    // Tag the goal with dedup info so dispatch can make informed decisions
    goal.dupWarning = `${pct}% similar to "${top.goal.title}" (${top.goal.status})`;
  }

  store.goals.push(goal);
  saveGoals(store);

  // Sync to Linear (non-blocking)
  syncToLinear(goal).catch(() => {});

  // Notify all channels — reviewers see new goals before execution begins
  try {
    const { notify } = require('../notifications/index');
    notify({ type: 'goal_received', project, title, goalId: goal.id, description });
  } catch (e) {
    // Best-effort — don't break goal creation for notifications
  }

  return goal;
}

/**
 * Add a goal from a Jam bug report with automatic enrichment.
 * Calls Jam MCP tools to fetch bug data, then Opus to generate
 * a rich goal spec with TEST_COMMANDS.
 *
 * Falls back to basic goal creation if enrichment fails.
 */
export async function addJamEnrichedGoal(
  project: string,
  jamId: string,
  fallbackTitle: string,
  fallbackDescription?: string,
): Promise<Goal> {
  try {
    const { enrichJamGoal } = await import('./jam-enrichment.js');
    const { getProject } = await import('../projects/registry.js');
    const projectConfig = getProject(project);
    const enriched = await enrichJamGoal(jamId, project, projectConfig?.devPort);

    if (enriched) {
      // Build description with TEST_COMMANDS block
      let description = enriched.description;
      if (enriched.testCommands.length > 0) {
        description += `\n\nTEST_COMMANDS:\n${enriched.testCommands.map(c => `- ${c}`).join('\n')}`;
      }

      return addGoal(project, enriched.title, description, `jam:${jamId}`, {
        complexity: enriched.complexity,
        archetype: enriched.archetype as 'backend' | 'frontend',
        jamContext: enriched.jamContext,
      });
    }
  } catch (err) {
    console.error(`[GoalCrud] Jam enrichment failed for ${jamId}:`, err);
  }

  // Fallback: create basic goal without enrichment
  return addGoal(project, fallbackTitle, fallbackDescription, `jam:${jamId}`);
}

export function getGoal(id: string): Goal | undefined {
  const store = loadGoals();
  return store.goals.find(g => g.id === id);
}

export function getGoalsByProject(project: string): Goal[] {
  const store = loadGoals();
  return store.goals.filter(g => g.project === project);
}

export function getPendingGoals(): Goal[] {
  const store = loadGoals();
  return store.goals.filter(g => g.status === 'pending');
}

export function getInProgressGoals(): Goal[] {
  const store = loadGoals();
  return store.goals.filter(g => g.status === 'in-progress');
}

export function getPendingReviewGoals(): Goal[] {
  const store = loadGoals();
  return store.goals.filter(g => g.reviewStatus === 'pending_review');
}

/**
 * Check if all of a goal's dependencies are satisfied.
 * Returns { ready: true } or { ready: false, blockerIds: [...], shouldBlock: boolean }
 * shouldBlock is true if any dependency failed/blocked (goal should be marked blocked too).
 */
export function checkDependencies(goal: Goal): { ready: boolean; blockerIds?: string[]; shouldBlock?: boolean } {
  if (!goal.dependsOn || goal.dependsOn.length === 0) return { ready: true };

  const store = loadGoals();
  const depMap = new Map(store.goals.map(g => [g.id, g]));
  const unmet: string[] = [];
  let anyFailed = false;

  for (const depId of goal.dependsOn) {
    const dep = depMap.get(depId);
    if (!dep) {
      // Non-existent dependency — treat as failed, not silent pass
      unmet.push(depId);
      anyFailed = true;
      console.error(`[Dependencies] Goal ${goal.id} depends on ${depId} which does not exist`);
      continue;
    }
    if (dep.status === 'completed') continue; // satisfied
    unmet.push(depId);
    if (dep.status === 'failed' || dep.status === 'blocked') anyFailed = true;
  }

  if (unmet.length === 0) return { ready: true };
  return { ready: false, blockerIds: unmet, shouldBlock: anyFailed };
}

export function getAllGoals(): Goal[] {
  return loadGoals().goals;
}

export function findGoalsByTitle(project: string, titleSubstring: string): Goal[] {
  const store = loadGoals();
  const lower = titleSubstring.toLowerCase();
  return store.goals.filter(g =>
    g.project === project &&
    (g.status === 'pending' || g.status === 'in-progress') &&
    g.title.toLowerCase().includes(lower)
  );
}

/**
 * Find completed goals matching a title substring within a time window.
 * Used by E2E circuit breaker to detect repeated fix attempts.
 */
export function findCompletedGoalsByTitle(
  project: string,
  titleSubstring: string,
  sinceMs: number
): Goal[] {
  const store = loadGoals();
  const lower = titleSubstring.toLowerCase();
  const cutoff = new Date(Date.now() - sinceMs);
  return store.goals.filter(g =>
    g.project === project &&
    g.status === 'completed' &&
    g.title.toLowerCase().includes(lower) &&
    g.completedAt && new Date(g.completedAt) >= cutoff
  );
}

export function countAutoGoalsCreatedToday(project: string): number {
  const store = loadGoals();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return store.goals.filter(g =>
    g.project === project &&
    g.title.startsWith('[AUTO]') &&
    new Date(g.createdAt) >= todayStart
  ).length;
}

export function updateGoal(id: string, updates: Partial<Goal>): Goal | undefined {
  const store = loadGoals();
  const index = store.goals.findIndex(g => g.id === id);

  if (index === -1) {
    return undefined;
  }

  store.goals[index] = { ...store.goals[index], ...updates };
  saveGoals(store);

  // Sync to Linear (non-blocking)
  syncToLinear(store.goals[index]).catch(() => {});

  return store.goals[index];
}

export function markGoalStarted(id: string): Goal | undefined {
  return updateGoal(id, {
    status: 'in-progress',
    startedAt: new Date()
  });
}

export function markGoalCompleted(id: string, output?: string): Goal | undefined {
  const goal = updateGoal(id, {
    status: 'completed',
    completedAt: new Date(),
    output,
  });

  // Log completion to Linear
  if (goal?.linearId) {
    logProgressToLinear(goal.linearId, 'Goal completed successfully!', 'complete').catch(() => {});
  }

  return goal;
}

export function markGoalBlocked(id: string, reason: string): Goal | undefined {
  const goal = updateGoal(id, {
    status: 'blocked',
    blockedReason: reason
  });

  // Log blocker to Linear
  if (goal?.linearId) {
    logProgressToLinear(goal.linearId, reason, 'blocker').catch(() => {});
  }

  return goal;
}

/**
 * Audit a goal branch before blocking — check if the agent produced
 * recoverable work that was falsely rejected by quality gates.
 *
 * Returns { hasWork, commits, hasCompletionSignal } so the caller
 * can escalate to Telegram instead of silently blocking.
 */
export function auditBranchBeforeBlocking(
  goalId: string,
  project: string,
  output?: string,
): { hasWork: boolean; commits: number; hasCompletionSignal: boolean; summary: string } {
  const projectConfig = getProject(project);
  if (!projectConfig?.path) {
    return { hasWork: false, commits: 0, hasCompletionSignal: false, summary: 'No project path' };
  }

  const cwd = projectConfig.path;
  const branch = `goal/${goalId}`;

  // Check if branch exists
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd, timeout: 5000, stdio: 'pipe' });
  } catch {
    return { hasWork: false, commits: 0, hasCompletionSignal: false, summary: 'No branch' };
  }

  // Count commits ahead of main
  let commits = 0;
  let commitLog = '';
  try {
    commitLog = execSync(`git log --oneline ${branch} --not main`, {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    commits = commitLog ? commitLog.split('\n').length : 0;
  } catch { /* branch or main may not exist */ }

  // Check if GOAL_COMPLETE appeared in the output
  const hasCompletionSignal = !!(output && output.includes('GOAL_COMPLETE'));

  const hasWork = commits > 0;
  const summary = hasWork
    ? `${commits} commit(s) on ${branch}${hasCompletionSignal ? ' + GOAL_COMPLETE signal' : ''}: ${commitLog.split('\n').slice(0, 3).join('; ')}`
    : 'No commits on branch';

  return { hasWork, commits, hasCompletionSignal, summary };
}

export function markGoalFailed(id: string, output?: string): Goal | undefined {
  return updateGoal(id, {
    status: 'failed',
    completedAt: new Date(),
    output,
  });
}

export function deleteGoal(id: string): boolean {
  const store = loadGoals();
  const initialLength = store.goals.length;
  store.goals = store.goals.filter(g => g.id !== id);

  if (store.goals.length < initialLength) {
    saveGoals(store);
    return true;
  }

  return false;
}

export function clearCompletedGoals(): number {
  const store = loadGoals();
  const initialLength = store.goals.length;
  store.goals = store.goals.filter(g => g.status !== 'completed');
  saveGoals(store);
  return initialLength - store.goals.length;
}

export function getGoalsSummary(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  failed: number;
  byProject: Record<string, number>;
} {
  const store = loadGoals();
  const byProject: Record<string, number> = {};

  for (const goal of store.goals) {
    byProject[goal.project] = (byProject[goal.project] || 0) + 1;
  }

  return {
    total: store.goals.length,
    pending: store.goals.filter(g => g.status === 'pending').length,
    inProgress: store.goals.filter(g => g.status === 'in-progress').length,
    completed: store.goals.filter(g => g.status === 'completed').length,
    blocked: store.goals.filter(g => g.status === 'blocked').length,
    failed: store.goals.filter(g => g.status === 'failed').length,
    byProject,
  };
}
