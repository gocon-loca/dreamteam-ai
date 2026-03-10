/**
 * Supervisor Monitoring — stuck detection, timeout enforcement, and agent killing.
 */

import { getDb } from '../db/index.js';
import { logEvent } from '../db/supervisor-events.js';
import {
  getActiveItems,
  requeueItem,
  markTimedOut,
  type WorkItem,
} from '../db/work-queue.js';
import {
  getGoal,
  updateGoal,
} from '../orchestration/goal-manager.js';
import { resolveModel } from '../orchestration/model-config.js';
import { killTrackedProcess } from '../orchestration/process-tracker.js';
import { detectStuckPatterns, resetStuckTracking } from '../orchestration/stuck-detection.js';
import { triageStuckAgent } from '../orchestration/ai-triage.js';
import { createLogger } from '../utils/logger.js';

import { config } from './supervisor-config.js';

const slog = createLogger('supervisor-monitoring');
import {
  outputSizeHistory,
  STALE_THRESHOLD,
} from './supervisor-state.js';
import { log } from './supervisor-utils.js';
import { blockGoalWithAudit, trackProjectFailure } from './supervisor-goals.js';
import { isWorkerAlive } from './supervisor-reconcile.js';

// ── Kill Agent ───────────────────────────────────────────

export function killAgent(item: WorkItem): void {
  // Try process-tracker first (has the Claude agent PID)
  try {
    killTrackedProcess(item.goal_id, 'SIGTERM');
  } catch (e) { slog.swallow('kill-tracked-process', e); }

  // Also try the worker PID
  if (item.worker_pid) {
    try {
      process.kill(item.worker_pid, 'SIGTERM');
    } catch (e) { slog.swallow('kill-worker-pid', e); }
  }
}

// ── Monitor Active Work ────────────────────────────────────

export async function monitorActiveWork(): Promise<void> {
  const active = getActiveItems();
  const now = Date.now();

  for (const item of active) {
    // 1. Liveness: is the worker PID alive?
    if (item.worker_pid && !isWorkerAlive(item.worker_pid)) {
      log(`Worker PID ${item.worker_pid} dead for [${item.project}] ${item.goal_id.slice(0, 8)}`, 'warn');
      if (item.attempt_number < config.maxAttemptsPerGoal) {
        requeueItem(item.id, 'Worker process died — retrying.');
        logEvent('reconcile', { goalId: item.goal_id, project: item.project, workerPid: item.worker_pid ?? undefined, details: 'Worker dead, requeued' });
      } else {

        getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = 'Worker died, max attempts' WHERE id = ?`).run(item.id);
        blockGoalWithAudit(item.goal_id, item.project, 'Worker died after max attempts', item.result_output ?? undefined);
        logEvent('goal_failed', { goalId: item.goal_id, project: item.project, details: 'Worker died, max attempts exhausted' });
        trackProjectFailure(item.project, getGoal(item.goal_id)?.title);
      }
      continue;
    }

    // 2. Cost circuit breaker — disabled on Max subscription (no per-dollar limits)
    // Token usage is tracked via heartbeat but doesn't gate execution.

    // 3. Stuck detection (3 tiers)
    if (item.last_progress_at && item.status === 'running') {
      const staleMs = now - new Date(item.last_progress_at).getTime();

      if (staleMs > config.killTimeoutMs) {
        // If agent already signaled GOAL_COMPLETE, don't kill — but mark timed_out
        // so quality gates can reject incomplete work (race condition fix)
        if (item.result_output?.includes('GOAL_COMPLETE')) {
          markTimedOut(item.id);
          updateGoal(item.goal_id, { timedOut: true });
          log(`[${item.project}] ${item.goal_id.slice(0, 8)} stale but has GOAL_COMPLETE — marked timed_out, letting completion flow verify`);
          continue;
        }
        // Kill and requeue
        log(`Stuck for ${Math.round(staleMs / 60000)} min — killing [${item.project}] ${item.goal_id.slice(0, 8)}`, 'warn');
        markTimedOut(item.id);
        updateGoal(item.goal_id, { timedOut: true });
        killAgent(item);

        if (item.attempt_number < config.maxAttemptsPerGoal) {
          requeueItem(item.id, 'Previous attempt timed out (no progress). Try a different approach.');
          logEvent('stuck_kill', { goalId: item.goal_id, project: item.project, details: `No progress for ${Math.round(staleMs / 60000)} min, requeued attempt ${item.attempt_number + 1}` });
        } else {

          getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = 'Stuck, max attempts' WHERE id = ?`).run(item.id);
          blockGoalWithAudit(item.goal_id, item.project, 'Goal failed after 3 attempts (stuck)', item.result_output ?? undefined);
          logEvent('goal_failed', { goalId: item.goal_id, project: item.project, details: 'Stuck after max attempts' });
          trackProjectFailure(item.project, getGoal(item.goal_id)?.title);
        }
      } else if (staleMs > config.progressTimeoutMs) {
        // Warning — just log for observability
        logEvent('stuck_warning', { goalId: item.goal_id, project: item.project, details: `No progress for ${Math.round(staleMs / 60000)} min` });
      }
    }

    // 3b. Output stale detection — kill agents looping without producing new output
    // Grace period: primary tier and complex goals need more thinking time.
    // CRITICAL: With --output-format json, Claude CLI buffers ALL stdout until
    // process exit. last_output_size stays at 0 for the entire first iteration.
    // If output is still 0, extend grace to match the per-iteration timeout
    // since the process timeout in task-runner.ts is the correct kill mechanism.
    const goal = getGoal(item.goal_id);
    const isComplex = goal?.complexity === 'complex' || item.model === resolveModel('primary');
    const baseGraceMs = isComplex ? 300_000 : 90_000; // 5min for complex/opus, 90s for others
    const currentSize = item.last_output_size || 0;
    const staleGraceMs = currentSize === 0 ? 900_000 : baseGraceMs; // 15min for buffered (complex goals), normal otherwise
    const staleElapsedMs = item.started_at ? Date.now() - new Date(item.started_at).getTime() : Infinity;
    if (staleElapsedMs >= staleGraceMs && item.status === 'running' && item.last_output_size !== undefined) {
      const prev = outputSizeHistory.get(item.id);

      if (prev) {
        if (currentSize <= prev.size) {
          // No output growth — increment stale count
          const newStaleCount = prev.staleCount + 1;
          outputSizeHistory.set(item.id, { size: currentSize, staleCount: newStaleCount });

          if (newStaleCount >= STALE_THRESHOLD) {
            // If agent already signaled GOAL_COMPLETE, don't kill — but mark timed_out
            // so quality gates can reject incomplete work (race condition fix)
            if (item.result_output?.includes('GOAL_COMPLETE')) {
              markTimedOut(item.id);
              updateGoal(item.goal_id, { timedOut: true });
              log(`[${item.project}] ${item.goal_id.slice(0, 8)} stale but has GOAL_COMPLETE — marked timed_out, skipping kill`);
              outputSizeHistory.delete(item.id);
              continue;
            }
            log(`Output stale for ${newStaleCount} checks (${currentSize} bytes) — killing [${item.project}] ${item.goal_id.slice(0, 8)}`, 'warn');
            markTimedOut(item.id);
            updateGoal(item.goal_id, { timedOut: true });
            killAgent(item);
            outputSizeHistory.delete(item.id);

            if (item.attempt_number < config.maxAttemptsPerGoal) {
              requeueItem(item.id, 'Agent stale (no output growth) — try a different approach.');
              logEvent('stale_detected', { goalId: item.goal_id, project: item.project, details: `No output growth for ${newStaleCount} checks at ${currentSize} bytes, requeued attempt ${item.attempt_number + 1}` });
            } else {
              getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = 'Stale, max attempts' WHERE id = ?`).run(item.id);
              blockGoalWithAudit(item.goal_id, item.project, 'Goal failed after max attempts (stale output)', item.result_output ?? undefined);
              logEvent('goal_failed', { goalId: item.goal_id, project: item.project, details: 'Stale output after max attempts' });
              // Don't count stale kills toward circuit breaker — stale detection is a
              // system-level timeout, not a project-level quality failure. Tripping the
              // circuit breaker on stale kills blocks unrelated goals from running.
              log(`[${item.project}] Stale kill excluded from circuit breaker (not a quality failure)`);
            }
            continue;
          }
        } else {
          // Output grew — reset stale counter
          outputSizeHistory.set(item.id, { size: currentSize, staleCount: 0 });
        }
      } else {
        // First check — initialize tracking
        outputSizeHistory.set(item.id, { size: currentSize, staleCount: 0 });
      }
    }

    // 3c. Behavioral stuck detection — analyze output content for loop patterns
    // This catches agents that ARE producing output but making zero progress
    if (item.status === 'running' && item.result_output && item.result_output.length > 3000) {
      const stuckResult = detectStuckPatterns(item.result_output);
      if (stuckResult.isStuck && stuckResult.pattern) {
        const goal = getGoal(item.goal_id);
        const elapsedMin = item.started_at ? Math.round((now - new Date(item.started_at).getTime()) / 60000) : 0;

        if (stuckResult.pattern.severity === 'kill') {
          // Definite loop — kill immediately
          log(`Stuck pattern "${stuckResult.pattern.name}" — killing [${item.project}] ${item.goal_id.slice(0, 8)}: ${stuckResult.evidence}`, 'warn');
          markTimedOut(item.id);
          updateGoal(item.goal_id, { timedOut: true });
          killAgent(item);
          resetStuckTracking(item.goal_id);
          outputSizeHistory.delete(item.id);

          if (item.attempt_number < config.maxAttemptsPerGoal) {
            requeueItem(item.id, `Behavioral loop detected (${stuckResult.pattern.name}): ${stuckResult.evidence}. Try a fundamentally different approach.`);
            logEvent('stuck_pattern', { goalId: item.goal_id, project: item.project, details: `${stuckResult.pattern.name}: ${stuckResult.evidence}` });
          } else {
            getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?`)
              .run(`Stuck pattern: ${stuckResult.pattern.name}`, item.id);
            blockGoalWithAudit(item.goal_id, item.project, `Behavioral loop: ${stuckResult.pattern.name} after max attempts`, item.result_output ?? undefined);
            logEvent('goal_failed', { goalId: item.goal_id, project: item.project, details: `Stuck: ${stuckResult.pattern.name}` });
          }
          continue;

        } else if (stuckResult.pattern.severity === 'triage') {
          // Possible loop — send to AI triage before deciding
          log(`Stuck pattern "${stuckResult.pattern.name}" detected for [${item.project}] ${item.goal_id.slice(0, 8)} — running AI triage`, 'warn');
          try {
            const triageResult = await triageStuckAgent(
              item.goal_id,
              item.project,
              goal?.title || item.goal_id,
              item.result_output?.slice(-2000) || '',
              elapsedMin,
              item.attempt_number,
            );
            log(`AI triage for ${item.goal_id.slice(0, 8)}: ${triageResult.decision} — ${triageResult.reason}`);
            logEvent('ai_triage', { goalId: item.goal_id, project: item.project, details: `${triageResult.decision}: ${triageResult.reason}` });

            if (triageResult.decision === 'terminate') {
              markTimedOut(item.id);
              updateGoal(item.goal_id, { timedOut: true });
              killAgent(item);
              resetStuckTracking(item.goal_id);
              outputSizeHistory.delete(item.id);
              if (item.attempt_number < config.maxAttemptsPerGoal) {
                const guidance = triageResult.suggestedGuidance
                  ? `AI triage: ${triageResult.reason}. Guidance: ${triageResult.suggestedGuidance}`
                  : `AI triage: ${triageResult.reason}. Try a different approach.`;
                requeueItem(item.id, guidance);
              } else {
                getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?`)
                  .run(`AI triage: terminate — ${triageResult.reason}`, item.id);
                blockGoalWithAudit(item.goal_id, item.project, `AI triage: ${triageResult.reason}`, item.result_output ?? undefined);
              }
              continue;
            } else if (triageResult.decision === 'retry') {
              markTimedOut(item.id);
              updateGoal(item.goal_id, { timedOut: true });
              killAgent(item);
              resetStuckTracking(item.goal_id);
              outputSizeHistory.delete(item.id);
              const guidance = triageResult.suggestedGuidance || triageResult.reason;
              requeueItem(item.id, `AI triage recommended retry: ${guidance}`);
              continue;
            }
            // 'extend' — do nothing, let it keep running
          } catch (triageErr) {
            log(`AI triage failed for ${item.goal_id.slice(0, 8)}: ${triageErr}`, 'warn');
            // On triage failure, don't kill — fall through to normal monitoring
          }

        } else {
          // severity === 'warning' — just log
          logEvent('stuck_warning_pattern', { goalId: item.goal_id, project: item.project, details: `${stuckResult.pattern.name}: ${stuckResult.evidence}` });
        }
      }
    }

    // 4. Absolute timeout
    if (item.started_at) {
      const runDuration = now - new Date(item.started_at).getTime();
      if (runDuration > config.absoluteTimeoutMs) {
        log(`Absolute timeout (${Math.round(runDuration / 3600000)}h) — killing [${item.project}]`, 'warn');
        markTimedOut(item.id);
        updateGoal(item.goal_id, { timedOut: true });
        killAgent(item);

        getDb().prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error = 'Absolute timeout' WHERE id = ?`).run(item.id);
        logEvent('kill', { goalId: item.goal_id, project: item.project, details: `Absolute timeout after ${Math.round(runDuration / 3600000)}h` });
      }
    }
  }
}
