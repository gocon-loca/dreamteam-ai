/**
 * Supervisor Events — Structured event logging for the supervisor.
 *
 * Replaces grepping log files. Every supervisor decision is logged here.
 * Morning digest and /status read from this table.
 */

import { getDb, generateId } from './index.js';

export type EventType =
  | 'dispatch'
  | 'kill'
  | 'stuck_warning'
  | 'stuck_kill'
  | 'budget_pause'
  | 'budget_resume'
  | 'escalation'
  | 'heartbeat'
  | 'project_pause'
  | 'project_resume'
  | 'reconcile'
  | 'goal_complete'
  | 'goal_failed'
  | 'review_reject'
  | 'review_concern'
  | 'session_limit'
  | 'stale_detected'
  | 'stuck_pattern'
  | 'stuck_warning_pattern'
  | 'ai_triage'
  | 'goal_dedup_blocked'
  | 'digest_sent'
  | 'low_confidence'
  | 'decomposition_dispatch'
  | 'planning_complete'
  | 'test_command_syntax_warning'
  | 'test_commands_enriched';

export interface SupervisorEvent {
  id: string;
  timestamp: string;
  event_type: EventType;
  goal_id: string | null;
  project: string | null;
  worker_pid: number | null;
  details: string | null;
  cost_usd: number | null;
}

/**
 * Insert a structured event into supervisor_events.
 */
export function logEvent(
  eventType: EventType,
  opts: {
    goalId?: string;
    project?: string;
    workerPid?: number;
    details?: string;
    costUsd?: number;
  } = {},
): void {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO supervisor_events (id, event_type, goal_id, project, worker_pid, details, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    eventType,
    opts.goalId ?? null,
    opts.project ?? null,
    opts.workerPid ?? null,
    opts.details ?? null,
    opts.costUsd ?? null,
  );
}

/**
 * Query events since a given timestamp, optionally filtered by type.
 */
export function getEventsSince(since: string, eventType?: EventType): SupervisorEvent[] {
  const db = getDb();

  if (eventType) {
    return db.prepare(`
      SELECT * FROM supervisor_events
      WHERE timestamp > ? AND event_type = ?
      ORDER BY timestamp ASC
    `).all(since, eventType) as SupervisorEvent[];
  }

  return db.prepare(`
    SELECT * FROM supervisor_events
    WHERE timestamp > ?
    ORDER BY timestamp ASC
  `).all(since) as SupervisorEvent[];
}

/**
 * Get the N most recent events (for /status display).
 */
export function getRecentEvents(limit: number = 10): SupervisorEvent[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM supervisor_events
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as SupervisorEvent[];
}

/**
 * Count events by type since a given timestamp.
 */
export function countEventsSince(since: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT event_type, COUNT(*) as cnt
    FROM supervisor_events
    WHERE timestamp > ?
    GROUP BY event_type
  `).all(since) as Array<{ event_type: string; cnt: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.event_type] = row.cnt;
  }
  return result;
}

/**
 * Get total cost from events since a given timestamp.
 */
export function getTotalCostSince(since: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM supervisor_events
    WHERE timestamp > ? AND cost_usd IS NOT NULL
  `).get(since) as { total: number };
  return row.total;
}
