/**
 * Preflight — Self-healing pre-dispatch checks.
 *
 * Runs on supervisor startup and every 5 minutes.
 * Checks and FIXES: dev servers, Claude CLI, API auth, budget.
 * If any check fails, dispatch is blocked until the next preflight passes.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ensureDevServerRunning, quickHealthCheck } from '../projects/dev-server.js';
import { getProject, listProjectNames } from '../projects/registry.js';
import { getPendingGoals } from '../orchestration/goal-manager.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');

export interface PreflightResult {
  ready: boolean;
  issues: string[];
  projectHealth: Map<string, boolean>; // project → healthy
}

/**
 * Run all preflight checks. Self-heals what it can.
 * Returns ready=true only if all critical checks pass.
 */
export async function preflight(
  log: (msg: string) => void,
): Promise<PreflightResult> {
  const issues: string[] = [];
  const projectHealth = new Map<string, boolean>();

  // ── 1. Claude CLI ──────────────────────────────────────
  try {
    const version = execSync('claude --version 2>&1', { timeout: 10_000, encoding: 'utf-8' }).trim();
    log(`[preflight] Claude CLI: ${version}`);
  } catch {
    issues.push('Claude CLI not found or not responding. Cannot dispatch any goals.');
    log('[preflight] FAIL: Claude CLI not available');
    // Fatal — no point checking anything else
    return { ready: false, issues, projectHealth };
  }

  // ── 2. Capacity check (logged, not fatal — dispatch() has its own check) ─
  try {
    const { countEventsSince } = await import('../db/supervisor-events.js');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const events = countEventsSince(todayStart.toISOString());
    const goalCount = (events['goal_complete'] || 0) + (events['goal_failed'] || 0);
    log(`[preflight] Today: ${goalCount} goals processed`);
  } catch (e) {
    log(`[preflight] Capacity check error (non-fatal): ${e}`);
  }

  // ── 3. Dev servers for projects with pending goals ─────
  const pendingProjects = new Set(getPendingGoals().map(g => g.project));

  for (const projectName of listProjectNames()) {
    try {
      const proj = getProject(projectName);
      if (!proj.hasDevServer) {
        projectHealth.set(projectName, true);
        continue;
      }

      if (!pendingProjects.has(projectName)) {
        projectHealth.set(projectName, true);
        continue; // No pending goals — don't bother starting
      }

      // Try health check first (fast path)
      const healthy = await quickHealthCheck(projectName, 5000);
      if (healthy) {
        projectHealth.set(projectName, true);
        log(`[preflight] ${projectName} dev server: healthy`);
        continue;
      }

      // Not healthy — try to start it
      log(`[preflight] ${projectName} dev server: down, starting...`);
      const started = await ensureDevServerRunning(projectName);
      if (started) {
        projectHealth.set(projectName, true);
        log(`[preflight] ${projectName} dev server: started successfully`);
      } else {
        projectHealth.set(projectName, false);
        log(`[preflight] ${projectName} dev server: won't start — its goals will be skipped`);
      }
    } catch (e) {
      projectHealth.set(projectName, false);
      log(`[preflight] ${projectName} dev server error: ${e}`);
    }
  }

  // ── 4. API auth check (non-fatal warning) ───────────────
  // Workers handle their own API keys. This is informational only.
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      log('[preflight] WARN: ANTHROPIC_API_KEY not in supervisor env (workers may have their own)');
    } else {
      log('[preflight] API key: present');
    }
  } catch {
    // Non-fatal
  }

  // Ready = no fatal issues. Per-project dev server failures only affect
  // those projects (via projectHealth), not the whole system.
  const ready = issues.length === 0;
  log(`[preflight] Result: ${ready ? 'READY' : `${issues.length} issue(s): ${issues.join('; ')}`}`);
  return { ready, issues, projectHealth };
}

