/**
 * Time-Series Analytics — Track cost and quality trends over time
 *
 * Records daily snapshots of key metrics and provides trend analysis.
 * Stored in SQLite for efficient querying.
 */

import { getDb, generateId } from '../db/index.js';

// ── Schema ─────────────────────────────────────────────────

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      total_cost_usd REAL DEFAULT 0,
      total_runs INTEGER DEFAULT 0,
      successful_runs INTEGER DEFAULT 0,
      failed_runs INTEGER DEFAULT 0,
      review_rejections INTEGER DEFAULT 0,
      smoke_test_failures INTEGER DEFAULT 0,
      avg_cost_per_goal REAL DEFAULT 0,
      goals_completed INTEGER DEFAULT 0,
      goals_created INTEGER DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
  `);
  schemaReady = true;
}

// ── Recording ─────────────────────────────────────────────

export interface DailySnapshot {
  date: string;
  totalCostUsd: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  reviewRejections: number;
  smokeTestFailures: number;
  avgCostPerGoal: number;
  goalsCompleted: number;
  goalsCreated: number;
}

/**
 * Record today's metrics snapshot.
 * Called once per day by supervisor (idempotent — upserts).
 */
export function recordDailySnapshot(): DailySnapshot {
  ensureSchema();
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Gather metrics from agent_runs
  const todayStart = `${today}T00:00:00.000Z`;
  const todayEnd = `${today}T23:59:59.999Z`;

  const runStats = db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN exit_signal = 'GOAL_COMPLETE' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN exit_signal != 'GOAL_COMPLETE' OR exit_signal IS NULL THEN 1 ELSE 0 END) as failed,
      COALESCE(SUM(cost_usd), 0) as total_cost
    FROM agent_runs
    WHERE started_at >= ? AND started_at <= ?
  `).get(todayStart, todayEnd) as { total_runs: number; successful: number; failed: number; total_cost: number };

  // Count review rejections from supervisor events
  let reviewRejections = 0;
  let smokeFailures = 0;
  try {
    const events = db.prepare(`
      SELECT event_type, COUNT(*) as cnt
      FROM supervisor_events
      WHERE timestamp >= ? AND timestamp <= ?
        AND event_type IN ('review_reject', 'smoke_test_fail')
      GROUP BY event_type
    `).all(todayStart, todayEnd) as Array<{ event_type: string; cnt: number }>;
    for (const e of events) {
      if (e.event_type === 'review_reject') reviewRejections = e.cnt;
      if (e.event_type === 'smoke_test_fail') smokeFailures = e.cnt;
    }
  } catch { /* events table may not exist */ }

  // Count goals completed/created today (from goals.json changes tracked in events)
  let goalsCompleted = 0;
  let goalsCreated = 0;
  try {
    const goalEvents = db.prepare(`
      SELECT event_type, COUNT(*) as cnt
      FROM supervisor_events
      WHERE timestamp >= ? AND timestamp <= ?
        AND event_type IN ('goal_complete', 'goal_created')
      GROUP BY event_type
    `).all(todayStart, todayEnd) as Array<{ event_type: string; cnt: number }>;
    for (const e of goalEvents) {
      if (e.event_type === 'goal_complete') goalsCompleted = e.cnt;
      if (e.event_type === 'goal_created') goalsCreated = e.cnt;
    }
  } catch { /* fallback */ }

  const snapshot: DailySnapshot = {
    date: today,
    totalCostUsd: runStats.total_cost,
    totalRuns: runStats.total_runs,
    successfulRuns: runStats.successful,
    failedRuns: runStats.failed,
    reviewRejections,
    smokeTestFailures: smokeFailures,
    avgCostPerGoal: runStats.total_runs > 0 ? runStats.total_cost / runStats.total_runs : 0,
    goalsCompleted,
    goalsCreated,
  };

  // Upsert
  db.prepare(`
    INSERT INTO daily_metrics (id, date, total_cost_usd, total_runs, successful_runs, failed_runs,
      review_rejections, smoke_test_failures, avg_cost_per_goal, goals_completed, goals_created, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total_cost_usd = excluded.total_cost_usd,
      total_runs = excluded.total_runs,
      successful_runs = excluded.successful_runs,
      failed_runs = excluded.failed_runs,
      review_rejections = excluded.review_rejections,
      smoke_test_failures = excluded.smoke_test_failures,
      avg_cost_per_goal = excluded.avg_cost_per_goal,
      goals_completed = excluded.goals_completed,
      goals_created = excluded.goals_created,
      recorded_at = excluded.recorded_at
  `).run(
    generateId(), today, snapshot.totalCostUsd, snapshot.totalRuns,
    snapshot.successfulRuns, snapshot.failedRuns, snapshot.reviewRejections,
    snapshot.smokeTestFailures, snapshot.avgCostPerGoal, snapshot.goalsCompleted,
    snapshot.goalsCreated, new Date().toISOString()
  );

  return snapshot;
}

// ── Querying ──────────────────────────────────────────────

/**
 * Get trend data for the last N days.
 */
export function getTrend(days: number = 30): DailySnapshot[] {
  ensureSchema();
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = db.prepare(`
    SELECT * FROM daily_metrics
    WHERE date >= ?
    ORDER BY date ASC
  `).all(since.toISOString().slice(0, 10)) as Array<{
    date: string; total_cost_usd: number; total_runs: number;
    successful_runs: number; failed_runs: number; review_rejections: number;
    smoke_test_failures: number; avg_cost_per_goal: number;
    goals_completed: number; goals_created: number;
  }>;

  return rows.map(r => ({
    date: r.date,
    totalCostUsd: r.total_cost_usd,
    totalRuns: r.total_runs,
    successfulRuns: r.successful_runs,
    failedRuns: r.failed_runs,
    reviewRejections: r.review_rejections,
    smokeTestFailures: r.smoke_test_failures,
    avgCostPerGoal: r.avg_cost_per_goal,
    goalsCompleted: r.goals_completed,
    goalsCreated: r.goals_created,
  }));
}

/**
 * Detect concerning trends (cost rising, success rate dropping).
 */
export function detectTrends(days: number = 14): string[] {
  const data = getTrend(days);
  if (data.length < 3) return [];

  const alerts: string[] = [];
  const mid = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, mid);
  const secondHalf = data.slice(mid);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // Cost trend
  const firstCost = avg(firstHalf.map(d => d.avgCostPerGoal));
  const secondCost = avg(secondHalf.map(d => d.avgCostPerGoal));
  if (firstCost > 0 && secondCost > firstCost * 1.3) {
    alerts.push(`Cost per goal rising: $${firstCost.toFixed(2)} → $${secondCost.toFixed(2)} (+${((secondCost / firstCost - 1) * 100).toFixed(0)}%)`);
  }

  // Success rate trend
  const firstSuccess = avg(firstHalf.filter(d => d.totalRuns > 0).map(d => d.successfulRuns / d.totalRuns));
  const secondSuccess = avg(secondHalf.filter(d => d.totalRuns > 0).map(d => d.successfulRuns / d.totalRuns));
  if (firstSuccess > 0 && secondSuccess < firstSuccess * 0.8) {
    alerts.push(`Success rate dropping: ${(firstSuccess * 100).toFixed(0)}% → ${(secondSuccess * 100).toFixed(0)}%`);
  }

  // Review rejection trend
  const firstRejects = avg(firstHalf.map(d => d.reviewRejections));
  const secondRejects = avg(secondHalf.map(d => d.reviewRejections));
  if (secondRejects > firstRejects + 2) {
    alerts.push(`Review rejections rising: ${firstRejects.toFixed(1)} → ${secondRejects.toFixed(1)} per day`);
  }

  return alerts;
}

/**
 * Format trend data for Telegram display.
 */
export function formatTrendReport(days: number = 14): string {
  const data = getTrend(days);
  const alerts = detectTrends(days);

  if (data.length === 0) return 'No trend data yet. Metrics start collecting after first day of operation.';

  const latest = data[data.length - 1];
  const totalCost = data.reduce((sum, d) => sum + d.totalCostUsd, 0);
  const totalRuns = data.reduce((sum, d) => sum + d.totalRuns, 0);
  const totalSuccess = data.reduce((sum, d) => sum + d.successfulRuns, 0);

  const lines = [
    `Trends (last ${data.length} days)`,
    `Total: $${totalCost.toFixed(2)} across ${totalRuns} runs`,
    `Success rate: ${totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(0) : 0}%`,
    `Latest day: $${latest.totalCostUsd.toFixed(2)}, ${latest.totalRuns} runs, ${latest.goalsCompleted} completed`,
  ];

  if (alerts.length > 0) {
    lines.push('', 'Alerts:');
    for (const alert of alerts) {
      lines.push(`  - ${alert}`);
    }
  }

  return lines.join('\n');
}
