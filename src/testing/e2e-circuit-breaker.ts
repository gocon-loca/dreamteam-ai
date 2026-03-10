/**
 * E2E Circuit Breaker — Tracks consecutive failures per flow.
 *
 * Trips after N consecutive failures across different goal completions.
 * Tripped flows are skipped during verification to avoid wasting resources.
 * Manual reset via `resetCircuitBreaker()`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const STATE_FILE = join(DATA_DIR, 'e2e-circuit-breaker.json');

const TRIP_THRESHOLD = 3; // consecutive failures before tripping

// ── Types ──────────────────────────────────────────────────

interface FlowState {
  consecutiveFailures: number;
  tripped: boolean;
  lastFailure: string | null;   // ISO timestamp
  lastSuccess: string | null;   // ISO timestamp
  trippedAt: string | null;     // ISO timestamp
  totalRuns: number;
  totalFailures: number;
}

interface CircuitBreakerState {
  flows: Record<string, FlowState>;
  lastUpdated: string;
}

// ── Persistence ────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState(): CircuitBreakerState {
  ensureDataDir();
  if (!existsSync(STATE_FILE)) {
    return { flows: {}, lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as CircuitBreakerState;
}

function saveState(state: CircuitBreakerState): void {
  ensureDataDir();
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getOrCreateFlow(state: CircuitBreakerState, flowId: string): FlowState {
  if (!state.flows[flowId]) {
    state.flows[flowId] = {
      consecutiveFailures: 0,
      tripped: false,
      lastFailure: null,
      lastSuccess: null,
      trippedAt: null,
      totalRuns: 0,
      totalFailures: 0,
    };
  }
  return state.flows[flowId];
}

// ── Public API ─────────────────────────────────────────────

/**
 * Check if a flow's circuit breaker is tripped (should be skipped).
 */
export function isFlowTripped(flowId: string): boolean {
  const state = loadState();
  return state.flows[flowId]?.tripped ?? false;
}

/**
 * Record a flow result. Trips after TRIP_THRESHOLD consecutive failures.
 */
export function recordFlowResult(flowId: string, passed: boolean): void {
  const state = loadState();
  const flow = getOrCreateFlow(state, flowId);
  const now = new Date().toISOString();

  flow.totalRuns++;

  if (passed) {
    flow.consecutiveFailures = 0;
    flow.lastSuccess = now;
    // Auto-reset if previously tripped and now passing
    if (flow.tripped) {
      flow.tripped = false;
      flow.trippedAt = null;
    }
  } else {
    flow.consecutiveFailures++;
    flow.totalFailures++;
    flow.lastFailure = now;

    if (flow.consecutiveFailures >= TRIP_THRESHOLD && !flow.tripped) {
      flow.tripped = true;
      flow.trippedAt = now;
    }
  }

  saveState(state);
}

/**
 * Manually reset a circuit breaker for a flow.
 */
export function resetCircuitBreaker(flowId: string): boolean {
  const state = loadState();
  const flow = state.flows[flowId];
  if (!flow) return false;

  flow.consecutiveFailures = 0;
  flow.tripped = false;
  flow.trippedAt = null;
  saveState(state);
  return true;
}

/**
 * Get all currently tripped flows.
 */
export function getTrippedFlows(): Array<{ flowId: string; trippedAt: string; consecutiveFailures: number }> {
  const state = loadState();
  const tripped: Array<{ flowId: string; trippedAt: string; consecutiveFailures: number }> = [];

  for (const [flowId, flow] of Object.entries(state.flows)) {
    if (flow.tripped && flow.trippedAt) {
      tripped.push({
        flowId,
        trippedAt: flow.trippedAt,
        consecutiveFailures: flow.consecutiveFailures,
      });
    }
  }

  return tripped;
}

/**
 * Get full state for a specific flow (for diagnostics).
 */
export function getFlowState(flowId: string): FlowState | null {
  const state = loadState();
  return state.flows[flowId] ?? null;
}

/**
 * Get a summary of all circuit breaker state.
 */
export function getCircuitBreakerSummary(): string {
  const state = loadState();
  const entries = Object.entries(state.flows);

  if (entries.length === 0) return 'No circuit breaker data recorded yet.';

  const lines: string[] = ['Circuit Breaker Status:'];
  for (const [flowId, flow] of entries) {
    const status = flow.tripped ? '⛔ TRIPPED' : '✅ OK';
    lines.push(`  ${flowId}: ${status} (${flow.consecutiveFailures} consecutive failures, ${flow.totalRuns} total runs)`);
  }

  return lines.join('\n');
}
