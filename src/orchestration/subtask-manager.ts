/**
 * Sub-task Manager — Tracks decomposed goal steps.
 *
 * When an agent emits a DECOMPOSITION block, the overnight daemon
 * parses it into sub-tasks. Each sub-task can be tracked individually,
 * optionally mapped to a Linear child issue, and linked to an agent_run.
 *
 * Signals parsed from agent output:
 *   DECOMPOSITION:
 *   - step1: "description" [acceptance criteria]
 *   - step2: "description" [acceptance criteria]
 *   END_DECOMPOSITION
 *
 *   SUBTASK_COMPLETE: step1
 */

import { getDb, generateId } from '../db/index.js';
import { createChildIssue, updateParentRollup, isLinearEnabled } from '../integrations/linear.js';

// ── Types ──────────────────────────────────────────────────

export type SubTaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed';

export interface SubTask {
  id: string;
  parentGoalId: string;
  stepNumber: number;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: SubTaskStatus;
  linearId?: string;
  runId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SubTaskRow {
  id: string;
  parent_goal_id: string;
  step_number: number;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  status: string;
  linear_id: string | null;
  run_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ── Signal Parsing ─────────────────────────────────────────

export interface ParsedDecomposition {
  steps: Array<{
    stepKey: string;
    description: string;
    criteria?: string;
  }>;
}

/**
 * Parse a DECOMPOSITION block from agent output.
 * Returns null if no decomposition found.
 */
export function parseDecomposition(output: string): ParsedDecomposition | null {
  const match = output.match(/DECOMPOSITION:\s*\n([\s\S]*?)END_DECOMPOSITION/);
  if (!match) return null;

  const block = match[1];
  const steps: ParsedDecomposition['steps'] = [];

  // Parse lines like: - step1: "description" [acceptance criteria]
  const linePattern = /^[\s-]*(\w+):\s*"?([^"[\n]+)"?\s*(?:\[([^\]]+)\])?/gm;
  let lineMatch;
  while ((lineMatch = linePattern.exec(block)) !== null) {
    steps.push({
      stepKey: lineMatch[1].trim(),
      description: lineMatch[2].trim(),
      criteria: lineMatch[3]?.trim(),
    });
  }

  return steps.length > 0 ? { steps } : null;
}

/**
 * Parse SUBTASK_COMPLETE signals from agent output.
 * Returns array of completed step keys.
 */
export function parseSubtaskCompletions(output: string): string[] {
  const completions: string[] = [];
  const pattern = /SUBTASK_COMPLETE:\s*(\w+)/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    completions.push(match[1].trim());
  }
  return completions;
}

// ── CRUD ───────────────────────────────────────────────────

/**
 * Create sub-tasks from a parsed decomposition.
 * Optionally creates Linear child issues.
 */
export async function createSubTasks(
  parentGoalId: string,
  decomposition: ParsedDecomposition,
  parentLinearId?: string,
): Promise<SubTask[]> {
  const db = getDb();
  const created: SubTask[] = [];

  for (let i = 0; i < decomposition.steps.length; i++) {
    const step = decomposition.steps[i];
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO subtasks (id, parent_goal_id, step_number, title, description, acceptance_criteria, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, parentGoalId, i + 1, step.stepKey, step.description, step.criteria ?? null, now);

    // Create Linear child issue if parent has a Linear issue
    let linearId: string | undefined;
    if (parentLinearId && isLinearEnabled()) {
      try {
        const childId = await createChildIssue(
          parentLinearId,
          `Step ${i + 1}: ${step.description.slice(0, 60)}`,
          step.criteria ? `**Acceptance Criteria:** ${step.criteria}\n\n${step.description}` : step.description,
        );
        if (childId) {
          linearId = childId;
          db.prepare('UPDATE subtasks SET linear_id = ? WHERE id = ?').run(linearId, id);
        }
      } catch {
        // Non-fatal
      }
    }

    created.push({
      id,
      parentGoalId,
      stepNumber: i + 1,
      title: step.stepKey,
      description: step.description,
      acceptanceCriteria: step.criteria,
      status: 'pending',
      linearId,
      createdAt: now,
    });
  }

  return created;
}

/**
 * Get all sub-tasks for a goal.
 */
export function getSubTasks(parentGoalId: string): SubTask[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM subtasks WHERE parent_goal_id = ? ORDER BY step_number ASC'
  ).all(parentGoalId) as SubTaskRow[];

  return rows.map(rowToSubTask);
}

/**
 * Update a sub-task status.
 */
export function updateSubTask(id: string, updates: Partial<Pick<SubTask, 'status' | 'runId' | 'completedAt'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.status) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.runId) { sets.push('run_id = ?'); values.push(updates.runId); }
  if (updates.completedAt) { sets.push('completed_at = ?'); values.push(updates.completedAt); }

  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Mark a sub-task complete by step key (matched from SUBTASK_COMPLETE signal).
 */
export function markSubTaskComplete(parentGoalId: string, stepKey: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT id FROM subtasks WHERE parent_goal_id = ? AND title = ? AND status != ?'
  ).get(parentGoalId, stepKey, 'completed') as { id: string } | undefined;

  if (!row) return false;

  db.prepare(
    'UPDATE subtasks SET status = ?, completed_at = ? WHERE id = ?'
  ).run('completed', new Date().toISOString(), row.id);

  return true;
}

/**
 * Get a rollup status string like "4/6 complete, 1 failed".
 */
export function getRollupStatus(parentGoalId: string): string {
  const subtasks = getSubTasks(parentGoalId);
  if (subtasks.length === 0) return 'No sub-tasks';

  const completed = subtasks.filter(s => s.status === 'completed').length;
  const failed = subtasks.filter(s => s.status === 'failed').length;
  const total = subtasks.length;

  let status = `${completed}/${total} complete`;
  if (failed > 0) status += `, ${failed} failed`;
  return status;
}

/**
 * Post rollup status to parent Linear issue.
 */
export async function syncRollupToLinear(parentGoalId: string, parentLinearId: string): Promise<void> {
  const rollup = getRollupStatus(parentGoalId);
  await updateParentRollup(parentLinearId, rollup);
}

// ── Helpers ────────────────────────────────────────────────

function rowToSubTask(row: SubTaskRow): SubTask {
  return {
    id: row.id,
    parentGoalId: row.parent_goal_id,
    stepNumber: row.step_number,
    title: row.title,
    description: row.description ?? undefined,
    acceptanceCriteria: row.acceptance_criteria ?? undefined,
    status: row.status as SubTaskStatus,
    linearId: row.linear_id ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}
