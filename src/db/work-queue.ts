/**
 * Work Queue — CRUD helpers for the work_queue SQLite table.
 *
 * Supervisor enqueues items, workers claim & complete them.
 * SQLite WAL mode ensures safe concurrent access.
 */

import { getDb, generateId } from './index.js';

export interface WorkItem {
  id: string;
  goal_id: string;
  project: string;
  status: 'queued' | 'claimed' | 'running' | 'done' | 'failed';
  worker_pid: number | null;
  prompt: string | null;
  model: string | null;
  archetype: string | null;
  cost_usd: number;
  cost_limit_usd: number;
  last_progress_at: string | null;
  attempt_number: number;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_signal: string | null;
  result_output: string | null;
  run_id: string | null;
  error: string | null;
  last_output_size: number;
  timed_out: number;
}

/**
 * Mark a work item as timed out (race condition: GOAL_COMPLETE in buffer after timeout).
 */
export function markTimedOut(itemId: string): void {
  const db = getDb();
  db.prepare(`UPDATE work_queue SET timed_out = 1 WHERE id = ?`).run(itemId);
}

/**
 * Insert a new work item with status='queued'.
 */
export function enqueueWorkItem(
  goalId: string,
  project: string,
  prompt: string,
  model: string,
  archetype: string,
  costLimit: number = 2.0,
): string {
  const db = getDb();
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO work_queue (id, goal_id, project, status, prompt, model, archetype, cost_limit_usd, created_at)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).run(id, goalId, project, prompt, model, archetype, costLimit, now);

  return id;
}

/**
 * Atomically claim the next queued item for a worker.
 * Allows up to maxPerProject concurrent items per project.
 * Returns null if nothing is available.
 */
export function claimNextItem(workerPid: number, maxPerProject: number = 4): WorkItem | null {
  const db = getDb();

  // SQLite serializes writes in WAL mode — this is atomic.
  const row = db.prepare(`
    UPDATE work_queue
    SET status = 'claimed', worker_pid = ?, claimed_at = datetime('now')
    WHERE id = (
      SELECT wq.id FROM work_queue wq
      WHERE wq.status = 'queued'
      AND (
        SELECT COUNT(*) FROM work_queue wq2
        WHERE wq2.project = wq.project AND wq2.status IN ('claimed', 'running')
      ) < ?
      ORDER BY wq.created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get(workerPid, maxPerProject) as WorkItem | undefined;

  return row ?? null;
}

/**
 * Mark item as running, set started_at and last_progress_at.
 */
export function markRunning(itemId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE work_queue SET status = 'running', started_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(now, now, itemId);
}

/**
 * Bump last_progress_at — called by worker on meaningful output.
 */
export function updateProgress(itemId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE work_queue SET last_progress_at = datetime('now') WHERE id = ?
  `).run(itemId);
}

/**
 * Update last_output_size — called by worker alongside progress updates.
 * Used by supervisor stale detection to check output growth.
 */
export function updateOutputSize(itemId: string, outputSize: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE work_queue SET last_output_size = ? WHERE id = ?
  `).run(outputSize, itemId);
}

/**
 * Update cost_usd — called periodically by worker.
 */
export function updateCost(itemId: string, costUsd: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE work_queue SET cost_usd = ? WHERE id = ?
  `).run(costUsd, itemId);
}

/**
 * Mark item as done or failed with results.
 */
export function completeItem(
  itemId: string,
  opts: {
    exitSignal: string | null;
    costUsd: number;
    runId: string | null;
    resultOutput: string | null;
    error?: string | null;
  },
): void {
  const db = getDb();
  const status = opts.exitSignal === 'GOAL_COMPLETE' ? 'done' : 'failed';
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE work_queue
    SET status = ?, completed_at = ?, exit_signal = ?, cost_usd = ?,
        run_id = ?, result_output = ?, error = ?
    WHERE id = ?
  `).run(status, now, opts.exitSignal, opts.costUsd, opts.runId, opts.resultOutput, opts.error ?? null, itemId);
}

/**
 * Get all active (claimed or running) items.
 */
export function getActiveItems(): WorkItem[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM work_queue WHERE status IN ('claimed', 'running')
  `).all() as WorkItem[];
}

/**
 * Get completed (done or failed) items that haven't been archived yet.
 */
export function getCompletedItems(): WorkItem[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM work_queue WHERE status IN ('done', 'failed')
  `).all() as WorkItem[];
}

/**
 * Get queued items count.
 */
export function getQueuedCount(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM work_queue WHERE status = 'queued'`).get() as { cnt: number };
  return row.cnt;
}

/**
 * Requeue a failed/stuck item — increment attempt_number, reset status.
 */
export function requeueItem(itemId: string, appendPrompt?: string): void {
  const db = getDb();

  if (appendPrompt) {
    db.prepare(`
      UPDATE work_queue
      SET status = 'queued', worker_pid = NULL, claimed_at = NULL, started_at = NULL,
          completed_at = NULL, exit_signal = NULL, result_output = NULL, error = NULL,
          last_progress_at = NULL, attempt_number = attempt_number + 1,
          prompt = prompt || ?
      WHERE id = ?
    `).run('\n\n' + appendPrompt, itemId);
  } else {
    db.prepare(`
      UPDATE work_queue
      SET status = 'queued', worker_pid = NULL, claimed_at = NULL, started_at = NULL,
          completed_at = NULL, exit_signal = NULL, result_output = NULL, error = NULL,
          last_progress_at = NULL, attempt_number = attempt_number + 1
      WHERE id = ?
    `).run(itemId);
  }
}

/**
 * Delete item from work_queue (agent_runs has the permanent record).
 */
export function archiveItem(itemId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM work_queue WHERE id = ?`).run(itemId);
}

/**
 * Find item by goal_id.
 */
export function getItemByGoalId(goalId: string): WorkItem | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM work_queue WHERE goal_id = ? AND status IN ('queued', 'claimed', 'running')
    ORDER BY created_at DESC LIMIT 1
  `).get(goalId) as WorkItem | undefined;
  return row ?? null;
}

/**
 * Get all items (for status display).
 */
export function getAllItems(): WorkItem[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM work_queue ORDER BY created_at ASC`).all() as WorkItem[];
}
