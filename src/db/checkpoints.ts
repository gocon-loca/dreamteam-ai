/**
 * Execution Checkpoints — Save/restore agent execution state
 * for crash-resilient goal resumption.
 *
 * After each iteration, the worker saves a checkpoint with:
 * - Current iteration number
 * - Accumulated output, cost, tokens
 * - Git commit SHA on the goal branch
 *
 * On crash recovery, the worker loads the checkpoint and resumes
 * from the last iteration instead of restarting from scratch.
 */

import { getDb, generateId } from './index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('checkpoints');

// ── Types ───────────────────────────────────────────────────

export interface ExecutionCheckpoint {
  id: string;
  goalId: string;
  workItemId: string;
  runId: string | null;
  project: string;
  iteration: number;
  commitSha: string | null;
  outputSoFar: string;
  costUsdSoFar: number;
  inputTokensSoFar: number;
  outputTokensSoFar: number;
  cacheReadTokensSoFar: number;
  cacheCreationTokensSoFar: number;
  exitSignalSoFar: string | null;
  createdAt: string;
}

export interface CheckpointInsert {
  goalId: string;
  workItemId: string;
  runId?: string;
  project: string;
  iteration: number;
  commitSha?: string;
  outputSoFar: string;
  costUsdSoFar: number;
  inputTokensSoFar: number;
  outputTokensSoFar: number;
  cacheReadTokensSoFar: number;
  cacheCreationTokensSoFar: number;
  exitSignalSoFar?: string;
}

// ── Schema Migration ────────────────────────────────────────

export function ensureCheckpointTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      run_id TEXT,
      project TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      commit_sha TEXT,
      output_so_far TEXT,
      cost_usd_so_far REAL DEFAULT 0,
      input_tokens_so_far INTEGER DEFAULT 0,
      output_tokens_so_far INTEGER DEFAULT 0,
      cache_read_tokens_so_far INTEGER DEFAULT 0,
      cache_creation_tokens_so_far INTEGER DEFAULT 0,
      exit_signal_so_far TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ckpt_goal ON execution_checkpoints(goal_id);
    CREATE INDEX IF NOT EXISTS idx_ckpt_work_item ON execution_checkpoints(work_item_id);
  `);
}

// ── CRUD Operations ─────────────────────────────────────────

/**
 * Save a checkpoint after an iteration completes.
 * Upserts: replaces any existing checkpoint for the same work item.
 */
export function saveCheckpoint(data: CheckpointInsert): string {
  const db = getDb();
  ensureCheckpointTable();

  const id = generateId();

  // Delete previous checkpoint for this work item (only keep latest)
  db.prepare('DELETE FROM execution_checkpoints WHERE work_item_id = ?')
    .run(data.workItemId);

  db.prepare(`
    INSERT INTO execution_checkpoints (
      id, goal_id, work_item_id, run_id, project,
      iteration, commit_sha, output_so_far,
      cost_usd_so_far, input_tokens_so_far, output_tokens_so_far,
      cache_read_tokens_so_far, cache_creation_tokens_so_far,
      exit_signal_so_far, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.goalId,
    data.workItemId,
    data.runId ?? null,
    data.project,
    data.iteration,
    data.commitSha ?? null,
    data.outputSoFar.slice(-50000), // Cap at 50K
    data.costUsdSoFar,
    data.inputTokensSoFar,
    data.outputTokensSoFar,
    data.cacheReadTokensSoFar,
    data.cacheCreationTokensSoFar,
    data.exitSignalSoFar ?? null,
    new Date().toISOString(),
  );

  log.debug(`Saved checkpoint for goal ${data.goalId}: iteration ${data.iteration}, $${data.costUsdSoFar.toFixed(4)}`);
  return id;
}

/**
 * Load the latest checkpoint for a goal.
 * Returns null if no checkpoint exists.
 */
export function loadCheckpoint(goalId: string): ExecutionCheckpoint | null {
  const db = getDb();
  ensureCheckpointTable();

  const row = db.prepare(`
    SELECT * FROM execution_checkpoints
    WHERE goal_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(goalId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    goalId: row.goal_id as string,
    workItemId: row.work_item_id as string,
    runId: row.run_id as string | null,
    project: row.project as string,
    iteration: row.iteration as number,
    commitSha: row.commit_sha as string | null,
    outputSoFar: row.output_so_far as string,
    costUsdSoFar: row.cost_usd_so_far as number,
    inputTokensSoFar: row.input_tokens_so_far as number,
    outputTokensSoFar: row.output_tokens_so_far as number,
    cacheReadTokensSoFar: row.cache_read_tokens_so_far as number,
    cacheCreationTokensSoFar: row.cache_creation_tokens_so_far as number,
    exitSignalSoFar: row.exit_signal_so_far as string | null,
    createdAt: row.created_at as string,
  };
}

/**
 * Delete checkpoint(s) for a goal. Call on successful completion or
 * when a goal is fully abandoned.
 */
export function clearCheckpoint(goalId: string): void {
  const db = getDb();
  ensureCheckpointTable();

  const result = db.prepare('DELETE FROM execution_checkpoints WHERE goal_id = ?')
    .run(goalId);

  if (result.changes > 0) {
    log.debug(`Cleared ${result.changes} checkpoint(s) for goal ${goalId}`);
  }
}

/**
 * Delete checkpoint by work item ID.
 */
export function clearCheckpointByWorkItem(workItemId: string): void {
  const db = getDb();
  ensureCheckpointTable();

  db.prepare('DELETE FROM execution_checkpoints WHERE work_item_id = ?')
    .run(workItemId);
}

/**
 * Get all stale checkpoints (older than maxAgeMs) for cleanup.
 */
export function getStaleCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): ExecutionCheckpoint[] {
  const db = getDb();
  ensureCheckpointTable();

  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = db.prepare(`
    SELECT * FROM execution_checkpoints
    WHERE created_at < ?
  `).all(cutoff) as Record<string, unknown>[];

  return rows.map(row => ({
    id: row.id as string,
    goalId: row.goal_id as string,
    workItemId: row.work_item_id as string,
    runId: row.run_id as string | null,
    project: row.project as string,
    iteration: row.iteration as number,
    commitSha: row.commit_sha as string | null,
    outputSoFar: row.output_so_far as string,
    costUsdSoFar: row.cost_usd_so_far as number,
    inputTokensSoFar: row.input_tokens_so_far as number,
    outputTokensSoFar: row.output_tokens_so_far as number,
    cacheReadTokensSoFar: row.cache_read_tokens_so_far as number,
    cacheCreationTokensSoFar: row.cache_creation_tokens_so_far as number,
    exitSignalSoFar: row.exit_signal_so_far as string | null,
    createdAt: row.created_at as string,
  }));
}

/**
 * Clean up old checkpoints. Called periodically by the supervisor.
 */
export function cleanupStaleCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const db = getDb();
  ensureCheckpointTable();

  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db.prepare('DELETE FROM execution_checkpoints WHERE created_at < ?')
    .run(cutoff);

  if (result.changes > 0) {
    log.info(`Cleaned up ${result.changes} stale checkpoint(s)`);
  }
  return result.changes;
}
