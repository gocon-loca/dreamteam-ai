/**
 * Supervisor Configuration — config, session limit state, and Claude budget tracking.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { getDb } from '../db/index.js';
import { getCostSummary } from '../db/execution-log.js';
import { logEvent } from '../db/supervisor-events.js';
import { parseResetTime } from '../projects/task-runner.js';
import { createLogger } from '../utils/logger.js';
import { log } from './supervisor-utils.js';
import { sendTelegram } from './supervisor-telegram.js';

const slog = createLogger('supervisor-config');

// ── Path Constants ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = join(__dirname, '../..');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
export const LOGS_DIR = join(PROJECT_ROOT, 'logs');
export const CONTROL_FILE = join(DATA_DIR, 'supervisor-control.json');

// ── Configuration ──────────────────────────────────────────

export interface SupervisorConfig {
  loopIntervalMs: number;
  maxGoalsPerDay: number;
  perGoalCostDefault: number;
  perGoalCostComplex: number;
  progressTimeoutMs: number;
  killTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxAttemptsPerGoal: number;
  consecutiveFailurePause: number;
  projectPauseDurationMs: number;
  metaReviewIntervalMs: number;
  testSweepIntervalMs: number;
  heartbeatIntervalMs: number;
  pmSweepIntervalMs: number;
  feedbackProcessIntervalMs: number;
  goalArchivalIntervalMs: number;
  morningDigestHour: number;
  maxWorkers: number;
  maxWorkersPerProject: number;
}

export const config: SupervisorConfig = {
  loopIntervalMs: 10_000,
  maxGoalsPerDay: 50,
  perGoalCostDefault: 3.0,
  perGoalCostComplex: 5.0,
  progressTimeoutMs: 15 * 60 * 1000,   // 15 min (complex goals need more think time)
  killTimeoutMs: 30 * 60 * 1000,       // 30 min hard kill
  absoluteTimeoutMs: 2 * 60 * 60 * 1000,
  maxAttemptsPerGoal: 3,
  consecutiveFailurePause: 3,
  projectPauseDurationMs: 30 * 60 * 1000,
  metaReviewIntervalMs: 60 * 60 * 1000,
  testSweepIntervalMs: 30 * 60 * 1000,
  heartbeatIntervalMs: 60 * 60 * 1000,
  pmSweepIntervalMs: 0, // Disabled — post-completion smoke test + TEST_COMMANDS cover verification
  feedbackProcessIntervalMs: 2 * 60 * 60 * 1000, // Every 2 hours — process user feedback into goals
  goalArchivalIntervalMs: 24 * 60 * 60 * 1000,   // Once per day — archive old completed goals
  morningDigestHour: 8,
  maxWorkers: 6,                        // Up to 6 goals concurrently
  maxWorkersPerProject: 1,              // 1 goal per project — workers share the git checkout
};

// ── Session Limit Tracking ─────────────────────────────────
// Persisted to disk so supervisor restarts don't lose the pause state.

const SESSION_LIMIT_FILE = join(DATA_DIR, 'session-limit.json');
let sessionLimitPauseUntil = 0;

export function getSessionLimitPauseUntil(): number {
  return sessionLimitPauseUntil;
}

export function loadSessionLimitState(): void {
  // Primary: try SQLite
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM system_state WHERE key = 'session_limit'").get() as { value: string } | undefined;
    if (row) {
      const data = JSON.parse(row.value);
      if (data.pauseUntil && data.pauseUntil > Date.now()) {
        sessionLimitPauseUntil = data.pauseUntil;
        log(`Session limit pause loaded from DB: resumes at ${new Date(sessionLimitPauseUntil).toLocaleTimeString()}`);
        return;
      }
    }
  } catch (e) { slog.swallow('load-session-limit-db', e); }

  // Fallback: JSON file
  try {
    if (existsSync(SESSION_LIMIT_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_LIMIT_FILE, 'utf-8'));
      if (data.pauseUntil && data.pauseUntil > Date.now()) {
        sessionLimitPauseUntil = data.pauseUntil;
        log(`Session limit pause loaded from file: resumes at ${new Date(sessionLimitPauseUntil).toLocaleTimeString()}`);
      }
    }
  } catch (e) { slog.swallow('load-session-limit-file', e); }
}

function saveSessionLimitState(): void {
  const stateData = JSON.stringify({
    pauseUntil: sessionLimitPauseUntil,
    savedAt: new Date().toISOString(),
  }, null, 2);

  // Primary: SQLite
  try {
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('session_limit', ?, datetime('now'))"
    ).run(stateData);
  } catch (e) { slog.swallow('save-session-limit-db', e); }

  // Also write JSON for backward compatibility
  try {
    writeFileSync(SESSION_LIMIT_FILE, stateData);
  } catch (e) { slog.swallow('save-session-limit-file', e); }
}

export function recordSessionLimitHit(agentOutput: string): void {
  // Don't re-record if we're already paused (avoid duplicate Telegram messages)
  if (sessionLimitPauseUntil > Date.now()) {
    log(`Session limit already active (resumes ${new Date(sessionLimitPauseUntil).toLocaleTimeString()}) — skipping duplicate`, 'warn');
    return;
  }

  // Parse the reset time from the agent's output
  const resetDate = parseResetTime(agentOutput);

  if (resetDate) {
    sessionLimitPauseUntil = resetDate.getTime();
    const pauseMinutes = Math.round((sessionLimitPauseUntil - Date.now()) / 60000);
    const pauseHours = Math.round(pauseMinutes / 60);
    const isWeeklyLimit = pauseMinutes > 24 * 60; // > 24 hours = weekly

    log(`🛑 SESSION LIMIT HIT — pausing ALL dispatch until ${resetDate.toLocaleString()} (${pauseHours}h)`, 'warn');

    if (isWeeklyLimit) {
      const days = Math.round(pauseMinutes / (60 * 24));
      sendTelegram(
        `⛔ WEEKLY LIMIT HIT — pausing ALL goals for ~${days} days\n` +
        `Resumes: ${resetDate.toLocaleString()}\n\n` +
        `Consider enabling "Extra Usage" (API billing) on claude.com to continue working.\n` +
        `Or manually delete data/session-limit.json to force resume.`
      ).catch((e) => slog.swallow('send-telegram', e));
    } else {
      sendTelegram(
        `🛑 Session limit hit — pausing ALL goals for ~${pauseHours}h\n` +
        `Resumes: ${resetDate.toLocaleTimeString()}\n\n` +
        `System will auto-resume. No action needed.`
      ).catch((e) => slog.swallow('send-telegram', e));
    }
  } else {
    // Can't parse reset time — use conservative 2-hour default
    sessionLimitPauseUntil = Date.now() + 2 * 60 * 60 * 1000;
    log(`🛑 SESSION LIMIT HIT — no reset time found, pausing for 2 hours`, 'warn');
    sendTelegram(`🛑 Session limit hit — pausing ALL goals for 2 hours (couldn't parse reset time)\n\nSystem will auto-resume.`).catch((e) => slog.swallow('send-telegram', e));
  }

  saveSessionLimitState();
  logEvent('session_limit', { details: `Paused until ${new Date(sessionLimitPauseUntil).toISOString()}` });

  // Self-calibrate the weekly ceiling based on actual usage at the moment of hitting the limit
  calibrateCeilingOnSessionLimit();
}

export function isSessionLimitPaused(): boolean {
  if (Date.now() < sessionLimitPauseUntil) return true;
  // If we just passed the pause window, clean up the file
  if (sessionLimitPauseUntil > 0 && Date.now() >= sessionLimitPauseUntil) {
    sessionLimitPauseUntil = 0;
    try { if (existsSync(SESSION_LIMIT_FILE)) unlinkSync(SESSION_LIMIT_FILE); } catch (e) { slog.swallow('cleanup-session-limit-file', e); }
    log('Session limit pause expired — resuming dispatch');
    // No Telegram notification — auto-recovery, user can't act on it
  }
  return false;
}

// ── Budget Tracking ─────────────────────────────────────────

const CLAUDE_BUDGET_FILE = join(DATA_DIR, 'claude-budget.json');

interface ClaudeBudgetConfig {
  weeklyEscalationThreshold: number; // 0-1, default 0.7
  estimatedWeeklyCeiling: number;    // approx API-equivalent $ at which session limits fire
}

export function loadClaudeBudget(): ClaudeBudgetConfig {
  try {
    if (existsSync(CLAUDE_BUDGET_FILE)) {
      const data = JSON.parse(readFileSync(CLAUDE_BUDGET_FILE, 'utf-8'));
      return {
        weeklyEscalationThreshold: data.weeklyEscalationThreshold ?? 0.7,
        estimatedWeeklyCeiling: data.estimatedWeeklyCeiling ?? 500,
      };
    }
  } catch (e) { slog.swallow('load-claude-budget', e); }
  return { weeklyEscalationThreshold: 0.7, estimatedWeeklyCeiling: 500 };
}

export function saveClaudeBudget(budgetConfig: ClaudeBudgetConfig): void {
  try {
    writeFileSync(CLAUDE_BUDGET_FILE, JSON.stringify(budgetConfig, null, 2));
  } catch (e) { slog.swallow('save-claude-budget', e); }
}

/**
 * Get Claude's weekly usage as a fraction (0-1).
 * Counts all agent runs for budget tracking.
 */
export function getClaudeWeeklyUsagePct(): number {
  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const summary = getCostSummary(weekAgo.toISOString());

    let totalCost = 0;
    for (const cost of Object.values(summary.byModel)) {
      totalCost += cost;
    }

    const budget = loadClaudeBudget();
    return budget.estimatedWeeklyCeiling > 0
      ? totalCost / budget.estimatedWeeklyCeiling
      : 0;
  } catch (e) {
    slog.swallow('get-weekly-usage-pct', e);
    return 0; // can't calculate — assume no usage
  }
}

/**
 * Self-calibrate the weekly ceiling when a session limit fires.
 * The cost at the moment of the session limit is the real ceiling.
 */
function calibrateCeilingOnSessionLimit(): void {
  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const summary = getCostSummary(weekAgo.toISOString());

    let totalCost = 0;
    for (const cost of Object.values(summary.byModel)) {
      totalCost += cost;
    }

    if (totalCost > 0) {
      const budget = loadClaudeBudget();
      const oldCeiling = budget.estimatedWeeklyCeiling;
      budget.estimatedWeeklyCeiling = totalCost;
      saveClaudeBudget(budget);
      log(`Self-calibrated weekly ceiling: $${oldCeiling} → $${totalCost.toFixed(2)}`);
    }
  } catch (e) {
    log(`Ceiling calibration error: ${e}`, 'warn');
  }
}
