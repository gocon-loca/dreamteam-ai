/**
 * Human Feedback CRUD — Records thumbs up/down and redo requests.
 *
 * Uses the human_feedback table created in schema v1.
 */

import { getDb, generateId } from './index.js';

// ── Types ──────────────────────────────────────────────────

export interface FeedbackInsert {
  runId?: string;
  goalId: string;
  type: 'positive' | 'negative' | 'redo';
  comment?: string;
  redoContext?: string;
}

export interface FeedbackRow {
  id: string;
  run_id: string | null;
  goal_id: string;
  type: string;
  comment: string | null;
  timestamp: string;
  redo_context: string | null;
}

// ── CRUD ───────────────────────────────────────────────────

/**
 * Insert a new feedback record.
 */
export function insertFeedback(data: FeedbackInsert): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO human_feedback (id, run_id, goal_id, type, comment, timestamp, redo_context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.runId ?? null,
    data.goalId,
    data.type,
    data.comment ?? null,
    new Date().toISOString(),
    data.redoContext ?? null,
  );

  return id;
}

/**
 * Get all feedback for a goal.
 */
export function getFeedbackForGoal(goalId: string): FeedbackRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM human_feedback WHERE goal_id = ? ORDER BY timestamp DESC'
  ).all(goalId) as FeedbackRow[];
}

/**
 * Get recent feedback across all goals.
 */
export function getRecentFeedback(limit = 20): FeedbackRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM human_feedback ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as FeedbackRow[];
}

/**
 * Get feedback stats summary.
 */
export function getFeedbackStats(): {
  total: number;
  positive: number;
  negative: number;
  redos: number;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN type = 'negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN type = 'redo' THEN 1 ELSE 0 END) as redos
    FROM human_feedback
  `).get() as { total: number; positive: number; negative: number; redos: number };

  return row;
}
