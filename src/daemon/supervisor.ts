/**
 * Supervisor Process — The single brain that manages the work queue.
 *
 * Responsibilities:
 * - Reconcile work_queue on startup (detect dead workers)
 * - Budget checking (daily + hourly limits)
 * - Triage pending goals and enqueue work items
 * - Monitor active work (stuck detection, cost circuit breaker)
 * - Process completed work (post-completion hooks, E2E, Telegram)
 * - Periodic tasks (heartbeat, meta-review, test sweep, morning digest)
 *
 * Restarting the supervisor costs $0 — workers keep running.
 */

import { mkdirSync, existsSync } from 'fs';

import { getActiveItems } from '../db/work-queue.js';
import { validatePorts } from '../projects/port-manager.js';

import { config, DATA_DIR, LOGS_DIR, loadSessionLimitState } from './supervisor-config.js';
import { getStatus, setStatus, readControlFile } from './supervisor-state.js';
import { log, guarded } from './supervisor-utils.js';
import { initTelegram, sendTelegram } from './supervisor-telegram.js';
import { autoRegisterChannels } from '../notifications/index.js';
import { reconcileOnStartup } from './supervisor-reconcile.js';
import { processCompletedWork } from './supervisor-goals.js';
import { dispatch } from './supervisor-dispatch.js';
import { monitorActiveWork } from './supervisor-monitoring.js';
import { runPeriodicTasks } from './supervisor-periodic.js';
import { startHealthServer, runPreflightCheck } from './supervisor-health.js';

// ── Ensure directories exist ────────────────────────────────

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Main Loop ──────────────────────────────────────────────

async function startSupervisor(): Promise<void> {
  log('=== Supervisor starting ===');

  // 1. Init notification channels (Telegram, Slack, console — based on env config)
  await autoRegisterChannels();
  log('Supervisor starting. Workers will execute goals independently.');

  // 1b. Start health HTTP server
  startHealthServer();

  // 2. Load persisted session limit state (survives restarts)
  loadSessionLimitState();

  // 3. Validate port assignments (fail fast on conflicts)
  validatePorts();

  // 4. Reconcile on startup
  reconcileOnStartup();

  // 5. Run preflight (starts dev servers, checks CLI, budget, auth)
  await runPreflightCheck();

  // 6. Main loop
  while (getStatus() !== 'shutting_down') {
    try {
      // a. Read control file (bot → supervisor)
      readControlFile();

      // b. If paused, just sleep
      if (getStatus() === 'paused') {
        await new Promise(r => setTimeout(r, config.loopIntervalMs));
        continue;
      }

      // c. Monitor active work (stuck detection, cost circuit breaker)
      await monitorActiveWork();

      // d. Process completed work (post-completion hooks, goal updates, Telegram)
      await guarded('processCompletedWork', processCompletedWork, 300_000);

      // e. Dispatch new work
      dispatch();

      // f. Run periodic tasks (heartbeat, preflight, meta-review, test sweep, digest)
      await guarded('runPeriodicTasks', runPeriodicTasks, 120_000);

      // g. Sleep
      await new Promise(r => setTimeout(r, config.loopIntervalMs));
    } catch (error) {
      log(`Main loop error: ${error}`, 'error');
      await new Promise(r => setTimeout(r, config.loopIntervalMs * 3));
    }
  }

  log('Supervisor stopped');
}

// ── Graceful Shutdown ──────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal} — shutting down`);
  setStatus('shutting_down');

  // Stop all tunnels
  try {
    const { stopAllTunnels } = await import('../projects/tunnel-manager.js');
    stopAllTunnels();
  } catch { /* ignore */ }

  // Flush Langfuse traces before exit
  try {
    const { shutdownTracing } = await import('../tracing/langfuse.js');
    await shutdownTracing();
  } catch { /* ignore */ }

  const active = getActiveItems();
  log(`Supervisor stopping. ${active.length} worker(s) still running.`);

  // Do NOT kill workers — they keep running with old code.
  // work_queue persists in SQLite. Next startup reconciles.
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
  log(`UNCAUGHT EXCEPTION: ${error?.stack || error}`, 'error');
  try {
    await sendTelegram(`💀 SUPERVISOR CRASHED\n${String(error).slice(0, 500)}`);
  } catch { /* can't send — exiting anyway */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : reason}`, 'error');
  // Don't exit — log and continue. The main loop has its own try/catch.
  // But do notify via Telegram so we know something is wrong.
  sendTelegram(`⚠️ SUPERVISOR UNHANDLED REJECTION\n${String(reason).slice(0, 500)}`).catch(() => {});
});

// Entry point
startSupervisor().catch(async (error) => {
  log(`Fatal error: ${error}`, 'error');
  try {
    await sendTelegram(`💀 SUPERVISOR FATAL ERROR\n${String(error).slice(0, 500)}`);
  } catch { /* can't send — exiting anyway */ }
  process.exit(1);
});
