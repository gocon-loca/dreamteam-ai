/**
 * Supervisor State — runtime state, control file reading, and tracking variables.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { logEvent } from '../db/supervisor-events.js';
import type { PreflightResult } from './preflight.js';
import { config, CONTROL_FILE } from './supervisor-config.js';
import { log } from './supervisor-utils.js';

// ── Runtime State ──────────────────────────────────────────

let status: 'running' | 'paused' | 'shutting_down' = 'running';

export function getStatus(): 'running' | 'paused' | 'shutting_down' {
  return status;
}

export function setStatus(newStatus: 'running' | 'paused' | 'shutting_down'): void {
  status = newStatus;
}

// ── Preflight State ────────────────────────────────────────

let lastPreflight: PreflightResult = { ready: false, issues: ['Not yet run'], projectHealth: new Map() };
let lastPreflightTime = 0;
let lastPreflightHealthy = false; // Track state transitions to avoid spamming Telegram

export const PREFLIGHT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function getLastPreflight(): PreflightResult {
  return lastPreflight;
}

export function setLastPreflight(result: PreflightResult): void {
  lastPreflight = result;
}

export function getLastPreflightTime(): number {
  return lastPreflightTime;
}

export function setLastPreflightTime(time: number): void {
  lastPreflightTime = time;
}

export function getLastPreflightHealthy(): boolean {
  return lastPreflightHealthy;
}

export function setLastPreflightHealthy(healthy: boolean): void {
  lastPreflightHealthy = healthy;
}

// ── Per-project failure tracking ───────────────────────────

export const projectFailures = new Map<string, number>();

// ── Stale detection ────────────────────────────────────────
// Track output size per work item to detect agents looping without progress

export const outputSizeHistory = new Map<string, { size: number; staleCount: number }>();
export const STALE_THRESHOLD = 12; // 12 consecutive checks with no output growth → kill (~120s at 10s intervals)

// ── Periodic task timestamps ───────────────────────────────

export let lastMetaReview = 0;
export let lastTestSweep = 0;
export let lastHeartbeat = 0;
export let lastPMSweep = 0;
export let lastFeedbackProcess = 0;
export let lastGoalArchival = 0;

export function setLastMetaReview(t: number): void { lastMetaReview = t; }
export function setLastTestSweep(t: number): void { lastTestSweep = t; }
export function setLastHeartbeat(t: number): void { lastHeartbeat = t; }
export function setLastPMSweep(t: number): void { lastPMSweep = t; }
export function setLastFeedbackProcess(t: number): void { lastFeedbackProcess = t; }
export function setLastGoalArchival(t: number): void { lastGoalArchival = t; }

const __filename_state = fileURLToPath(import.meta.url);
const __dirname_state = dirname(__filename_state);

export let lastMorningDigest = (() => {
  try {
    const extra = JSON.parse(readFileSync(join(__dirname_state, '../../data/supervisor-state-extra.json'), 'utf-8'));
    return extra.lastDigestDate || '';
  } catch { return ''; }
})();

export function setLastMorningDigest(date: string): void {
  lastMorningDigest = date;
}

// ── Rate limit tracking ────────────────────────────────────

export const rateLimitTimestamps: number[] = [];
export let rateLimitPauseUntil = 0;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
export const RATE_LIMIT_THRESHOLD = 3;                // 3 hits in window
export const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;   // 15 minute pause

export function setRateLimitPauseUntil(t: number): void {
  rateLimitPauseUntil = t;
}

// ── Rejection dedup ────────────────────────────────────────

export const recentRejections = new Map<string, number>(); // goalId → timestamp
export const REJECTION_DEDUP_MS = 10 * 60 * 1000; // 10 minutes

// ── Project round-robin ────────────────────────────────────

export let lastDispatchedProject = '';

export function setLastDispatchedProject(project: string): void {
  lastDispatchedProject = project;
}

// ── Control File ───────────────────────────────────────────

interface ControlFile {
  paused?: boolean;
  maxGoalsPerDay?: number;
  updatedAt?: string;
}

export function readControlFile(): void {
  if (!existsSync(CONTROL_FILE)) return;

  try {
    const ctrl: ControlFile = JSON.parse(readFileSync(CONTROL_FILE, 'utf-8'));

    if (ctrl.paused === true && status === 'running') {
      status = 'paused';
      log('Paused via control file');
      logEvent('budget_pause', { details: 'Paused via control file' });
    } else if (ctrl.paused === false && status === 'paused') {
      status = 'running';
      log('Resumed via control file');
      logEvent('budget_resume', { details: 'Resumed via control file' });
    }

    if (ctrl.maxGoalsPerDay !== undefined) config.maxGoalsPerDay = ctrl.maxGoalsPerDay;
  } catch {
    // Ignore parse errors
  }
}
