/**
 * Supervisor Reconcile — startup reconciliation of work queue and orphaned processes.
 */

import { getDb } from '../db/index.js';
import { logEvent } from '../db/supervisor-events.js';
import {
  getActiveItems,
  requeueItem,
  getItemByGoalId,
} from '../db/work-queue.js';
import {
  getInProgressGoals,
  getGoal,
  updateGoal,
} from '../orchestration/goal-manager.js';
import { killTrackedProcess, findOrphanedProcesses, cleanupDeadProcesses } from '../orchestration/process-tracker.js';
import { createLogger } from '../utils/logger.js';
import { config } from './supervisor-config.js';
import { log } from './supervisor-utils.js';

const slog = createLogger('supervisor-reconcile');
import { blockGoalWithAudit } from './supervisor-goals.js';

export function isWorkerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    slog.swallow('check-worker-alive', e);
    return false;
  }
}

export function reconcileOnStartup(): void {
  log('Reconciling work queue...');

  // Clean up orphaned Claude processes — only kill those whose worker is dead.
  // If a worker is alive, its Claude process is actively managed and should not be killed.
  try {
    const cleaned = cleanupDeadProcesses();
    if (cleaned.length > 0) {
      log(`Cleaned ${cleaned.length} dead process entries`);
    }

    const orphans = findOrphanedProcesses();
    const activeItems = getActiveItems();

    let killedCount = 0;
    for (const orphan of orphans) {
      // Check if any active work item has a living worker for this goal
      const item = activeItems.find(i => i.goal_id === orphan.goalId);
      if (item?.worker_pid && isWorkerAlive(item.worker_pid)) {
        log(`Keeping Claude process PID ${orphan.pid} for ${orphan.goalId} — worker ${item.worker_pid} is alive`);
        continue;
      }
      // Worker is dead or no matching work item — this is a true orphan
      log(`Killing orphaned Claude process PID ${orphan.pid} for ${orphan.goalId} (worker dead)`);
      killTrackedProcess(orphan.goalId, 'SIGTERM');
      killedCount++;
    }
    if (killedCount > 0) {
      log(`Killed ${killedCount} orphaned Claude processes`);
    }
  } catch (err) {
    log(`Orphan recovery error: ${err}`, 'warn');
  }

  const active = getActiveItems();

  if (active.length === 0) {
    log('No active items in work_queue — clean start');
    return;
  }

  let refreshed = 0;
  let requeued = 0;
  let failed = 0;

  for (const item of active) {
    if (item.worker_pid && isWorkerAlive(item.worker_pid)) {
      // Worker still alive — give it a fresh timeout window
      try {

        getDb().prepare('UPDATE work_queue SET last_progress_at = datetime(\'now\') WHERE id = ?').run(item.id);
        refreshed++;
      } catch (e) { slog.swallow('refresh-progress-timestamp', e); }
    } else {
      // Worker dead
      if (item.attempt_number < config.maxAttemptsPerGoal) {
        requeueItem(item.id, 'Previous worker died — retrying.');
        requeued++;
        logEvent('reconcile', {
          goalId: item.goal_id,
          project: item.project,
          details: `Requeued (attempt ${item.attempt_number + 1}): worker PID ${item.worker_pid} dead`,
        });
      } else {
        // Max attempts exhausted

        getDb().prepare(`
          UPDATE work_queue SET status = 'failed', completed_at = datetime('now'),
          error = 'Max attempts exhausted after worker death'
          WHERE id = ?
        `).run(item.id);
        blockGoalWithAudit(item.goal_id, item.project, 'Failed after max attempts (worker deaths)', item.result_output ?? undefined);
        failed++;
        logEvent('goal_failed', {
          goalId: item.goal_id,
          project: item.project,
          details: 'Max attempts exhausted after worker death',
        });
      }
    }
  }

  // Also find in-progress goals with no work_queue entry — reset to pending
  const inProgressGoals = getInProgressGoals();
  let reset = 0;
  for (const goal of inProgressGoals) {
    const item = getItemByGoalId(goal.id);
    if (!item) {
      updateGoal(goal.id, { status: 'pending' });
      reset++;
    }
  }

  log(`Reconcile: ${refreshed} refreshed, ${requeued} requeued, ${failed} failed, ${reset} goals reset`);
  logEvent('reconcile', { details: `refreshed=${refreshed} requeued=${requeued} failed=${failed} reset=${reset}` });
}
