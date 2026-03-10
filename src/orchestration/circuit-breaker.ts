/**
 * Per-project circuit breaker — persistent, with auto-reset.
 *
 * Tracks consecutive failures per project. At TRIP_THRESHOLD consecutive
 * failures, pauses dispatch for that project. Auto-resets after a cooldown
 * period so overnight runs can self-heal without human intervention.
 *
 * State consolidated in SQLite (system_state table) as single source of truth.
 * Falls back to JSON file if DB is unavailable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '../../data/circuit-breaker.json');

const TRIP_THRESHOLD = 5;              // 5 consecutive failures to trip (was 3 — too sensitive)
const AUTO_RESET_MS = 30 * 60 * 1000; // 30 minutes cooldown before auto-reset
const MAX_AUTO_RESETS = 10;            // Effectively unlimited auto-resets — let the system self-heal

interface ProjectState {
  failures: number;
  tripped: boolean;
  trippedAt?: string;
  lastFailedGoal?: string;
  autoResets?: number;
}

type CBState = Record<string, ProjectState>;

function load(): CBState {
  // Primary: try SQLite
  try {
    const { getDb } = require('../db/index.js');
    const db = getDb();
    const row = db.prepare("SELECT value FROM system_state WHERE key = 'circuit_breaker'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value);
  } catch { /* DB not available — fall through to JSON */ }

  // Fallback: JSON file
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* corrupt file */ }
  return {};
}

function save(state: CBState): void {
  // Primary: write to SQLite
  try {
    const { getDb } = require('../db/index.js');
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('circuit_breaker', ?, datetime('now'))"
    ).run(JSON.stringify(state));
  } catch { /* DB not available — fall through to JSON */ }

  // Also write JSON file for backward compatibility and debugging
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Record a failure for a project. Returns the failure count if the breaker just tripped, 0 otherwise. */
export function recordFailure(project: string, goalTitle?: string): number {
  const state = load();
  const ps = state[project] || { failures: 0, tripped: false };
  ps.failures += 1;
  ps.lastFailedGoal = goalTitle;

  if (ps.failures >= TRIP_THRESHOLD && !ps.tripped) {
    ps.tripped = true;
    ps.trippedAt = new Date().toISOString();
    state[project] = ps;
    save(state);
    return ps.failures; // just tripped — return actual count
  }

  state[project] = ps;
  save(state);
  return 0;
}

/** Record a success — resets failure counter and auto-reset count. */
export function recordSuccess(project: string): void {
  const state = load();
  if (state[project]) {
    state[project] = { failures: 0, tripped: false, autoResets: 0 };
    save(state);
  }
}

/**
 * Check if the breaker is tripped for a project.
 * Auto-resets after AUTO_RESET_MS cooldown so overnight runs can self-heal.
 */
export function isTripped(project: string): boolean {
  const state = load();
  const ps = state[project];
  if (!ps?.tripped) return false;

  // Auto-reset after cooldown (up to MAX_AUTO_RESETS times)
  if (ps.trippedAt) {
    const resets = ps.autoResets ?? 0;
    if (resets >= MAX_AUTO_RESETS) return true; // permanently tripped

    const elapsed = Date.now() - new Date(ps.trippedAt).getTime();
    if (elapsed >= AUTO_RESET_MS) {
      console.log(`[CircuitBreaker] Auto-resetting ${project} after ${Math.round(elapsed / 60000)}min cooldown (reset ${resets + 1}/${MAX_AUTO_RESETS})`);
      ps.failures = 0;
      ps.tripped = false;
      ps.autoResets = resets + 1;
      delete ps.trippedAt;
      state[project] = ps;
      save(state);
      return false;
    }
  }

  return true;
}

/** Resume a project — resets breaker and auto-reset count. Returns false if it wasn't tripped. */
export function resumeProject(project: string): boolean {
  const state = load();
  if (!state[project]?.tripped) return false;
  state[project] = { failures: 0, tripped: false, autoResets: 0 };
  save(state);
  return true;
}

/** Get full breaker state (for status commands). */
export function getBreakerState(): CBState {
  return load();
}
