/**
 * Supervisor Capacity Gates — rate limiting, session limits, daily caps.
 */

import { countEventsSince } from '../db/supervisor-events.js';
import { config, isSessionLimitPaused } from './supervisor-config.js';
import {
  rateLimitTimestamps,
  rateLimitPauseUntil,
  setRateLimitPauseUntil,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_THRESHOLD,
  RATE_LIMIT_PAUSE_MS,
} from './supervisor-state.js';
import { log } from './supervisor-utils.js';
import { sendTelegram } from './supervisor-telegram.js';

export function isRateLimitPaused(): boolean {
  if (Date.now() < rateLimitPauseUntil) return true;
  return false;
}

export function recordRateLimitHit(): void {
  const now = Date.now();
  rateLimitTimestamps.push(now);
  // Prune old timestamps outside the window
  while (rateLimitTimestamps.length > 0 && rateLimitTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    rateLimitTimestamps.shift();
  }
  if (rateLimitTimestamps.length >= RATE_LIMIT_THRESHOLD) {
    setRateLimitPauseUntil(now + RATE_LIMIT_PAUSE_MS);
    log(`🛑 Rate limit threshold hit (${rateLimitTimestamps.length} in ${RATE_LIMIT_WINDOW_MS / 60000}min) — pausing dispatch for ${RATE_LIMIT_PAUSE_MS / 60000} minutes`, 'warn');
    sendTelegram(`🛑 Rate limited — pausing dispatch for 15 minutes`).catch(() => {});
  }
}

export function getTodayGoalCount(): number {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const events = countEventsSince(todayStart.toISOString());
    return (events['goal_complete'] || 0) + (events['goal_failed'] || 0);
  } catch {
    return 0;
  }
}

export function isCapacityExceeded(): boolean {
  // Gate 0: Session limit (hours-long cooldown — most important)
  if (isSessionLimitPaused()) {
    return true;
  }
  // Gate 1: Rate limit pause (brief per-request throttles)
  if (isRateLimitPaused()) {
    return true;
  }
  // Gate 2: Daily goal count safety valve
  if (getTodayGoalCount() >= config.maxGoalsPerDay) {
    return true;
  }
  return false;
}
