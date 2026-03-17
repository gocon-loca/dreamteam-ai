/**
 * Supervisor Goals — processing completed and failed work items.
 */

import {
  getGoal,
  markGoalCompleted,
  markGoalBlocked,
  auditBranchBeforeBlocking,
  updateGoal,
  runPostCompletionHooks,
  isGoalUIRelated,
  addGoal,
} from '../orchestration/goal-manager.js';
import type { Goal } from '../orchestration/goal-manager.js';
import {
  getCompletedItems,
  archiveItem,
  type WorkItem,
} from '../db/work-queue.js';
import { logEvent } from '../db/supervisor-events.js';
import { getAgentRun } from '../db/execution-log.js';
import {
  parseDecomposition,
  parseSubtaskCompletions,
  createSubTasks,
  markSubTaskComplete,
  getRollupStatus,
  syncRollupToLinear,
} from '../orchestration/subtask-manager.js';
import {
  recordOutcome,
  recordQualityAdjustment,
  classifyGoalType,
} from '../orchestration/model-router.js';
import type { ModelTier } from '../orchestration/model-config.js';
import { recordFailure, recordSuccess } from '../orchestration/circuit-breaker.js';
import { getProject } from '../projects/registry.js';
import { resetStuckTracking } from '../orchestration/stuck-detection.js';
import { createLogger } from '../utils/logger.js';

import { recordSessionLimitHit } from './supervisor-config.js';
import {
  projectFailures,
  outputSizeHistory,
  recentRejections,
  REJECTION_DEDUP_MS,
} from './supervisor-state.js';
import { log, withTimeout } from './supervisor-utils.js';
import { sendTelegram } from './supervisor-telegram.js';
import { recordRateLimitHit } from './supervisor-capacity.js';
import { notify } from '../notifications/index.js';

const slog = createLogger('supervisor-goals');

// ── Block with Branch Audit ────────────────────────────────

/**
 * Wrapper around markGoalBlocked that first audits the goal branch.
 * If the branch has commits (especially with GOAL_COMPLETE), escalate
 * to Telegram so the user knows there's recoverable work — instead of
 * silently blocking and abandoning the branch.
 */
export function blockGoalWithAudit(goalId: string, project: string, reason: string, output?: string): void {
  const audit = auditBranchBeforeBlocking(goalId, project, output);

  markGoalBlocked(goalId, reason);

  if (audit.hasWork) {
    const emoji = audit.hasCompletionSignal ? '🔀' : '⚠️';
    const action = audit.hasCompletionSignal
      ? 'Agent signaled GOAL_COMPLETE and has commits — likely a false rejection'
      : 'Branch has commits that may be recoverable';
    sendTelegram(
      `${emoji} [${project}] Blocked goal has work on branch!\n\n` +
      `Goal: ${goalId}\n` +
      `Reason: ${reason}\n` +
      `${action}\n` +
      `${audit.summary}\n\n` +
      `Check branch goal/${goalId} — may need manual merge.`
    ).catch((e) => slog.swallow('send-branch-audit-telegram', e));
    log(`[BranchAudit] ${goalId}: ${audit.summary}`, 'warn');
  }
}

// ── Project Failure Tracking ───────────────────────────────

export function trackProjectFailure(project: string, goalTitle?: string): void {
  // Also update in-memory tracking for backward compat
  const failures = (projectFailures.get(project) || 0) + 1;
  projectFailures.set(project, failures);

  // Persistent circuit breaker — trips at 3 consecutive failures
  // Returns actual persistent failure count if just tripped, 0 otherwise
  const persistentFailures = recordFailure(project, goalTitle);
  if (persistentFailures > 0) {
    log(`🔴 [${project}] Circuit breaker tripped — ${persistentFailures} consecutive failures`, 'warn');
    logEvent('project_pause', { project, details: `Circuit breaker: ${persistentFailures} consecutive failures` });
    sendTelegram(
      `🔴 [${project}] Circuit breaker tripped — ${persistentFailures} consecutive failures.\n` +
      `Remaining goals paused.\n` +
      `Reply \`/resume ${project}\` to continue or \`/cancel ${project}\` to abort.`
    ).catch((e) => slog.swallow('send-circuit-breaker-telegram', e));
  }
}

export function clearProjectFailure(project: string): void {
  projectFailures.set(project, 0);
  recordSuccess(project);
}

// ── Process Completed Work ─────────────────────────────────

export async function processCompletedWork(): Promise<void> {
  const completed = getCompletedItems();
  if (completed.length === 0) return;

  for (const item of completed) {
    try {
      if (item.status === 'done') {
        await handleCompletedGoal(item);
      } else {
        await handleFailedGoal(item);
      }
    } catch (error) {
      log(`Error processing completed item ${item.id.slice(0, 8)}: ${error}`, 'error');
    }

    // Clean up stale + stuck detection tracking
    outputSizeHistory.delete(item.id);
    resetStuckTracking(item.goal_id);

    // Archive from work_queue (agent_runs has the permanent record)
    archiveItem(item.id);
  }
}

async function handleCompletedGoal(item: WorkItem): Promise<void> {
  const goal = getGoal(item.goal_id);
  if (!goal) {
    log(`Goal ${item.goal_id} not found for completed item`, 'warn');
    return;
  }

  const output = item.result_output || '';

  // NOTE: markGoalCompleted() is called AFTER post-completion hooks pass (see below).
  // This ensures broken goals don't get marked completed if quality gates reject them.

  // 2. Parse subtask decomposition
  try {
    const decomposition = parseDecomposition(output);
    if (decomposition && decomposition.steps.length > 0) {
      log(`[${item.project}] Decomposition: ${decomposition.steps.length} steps`);
      await withTimeout(createSubTasks(item.goal_id, decomposition, goal.linearId), 15_000, 'createSubTasks');

      const completions = parseSubtaskCompletions(output);
      for (const stepKey of completions) {
        markSubTaskComplete(item.goal_id, stepKey);
      }

      const rollup = getRollupStatus(item.goal_id);
      log(`[${item.project}] Sub-tasks: ${rollup}`);

      if (goal.linearId) {
        await syncRollupToLinear(item.goal_id, goal.linearId).catch((e) => slog.swallow('sync-rollup-to-linear', e));
      }

      // Create real goals for incomplete steps so they get dispatched independently
      const incompleteSteps = decomposition.steps.filter(
        step => !completions.includes(step.stepKey)
      );
      if (incompleteSteps.length > 0) {
        log(`[${item.project}] Creating ${incompleteSteps.length} child goals from decomposition`);
        let prevGoalId: string | undefined;
        for (const step of incompleteSteps) {
          try {
            const desc = step.criteria
              ? `${step.description}\n\nACCEPTANCE CRITERIA:\n- ${step.criteria}`
              : step.description;
            const childGoal = addGoal(
              item.project,
              `[Sub] ${step.description.slice(0, 60)}`,
              desc,
              `decomposition:${item.goal_id}`,
            );
            // Chain sequential steps with dependsOn
            if (prevGoalId) {
              updateGoal(childGoal.id, { dependsOn: [prevGoalId] });
            }
            prevGoalId = childGoal.id;
            log(`[${item.project}] Created child goal ${childGoal.id} for step ${step.stepKey}`);
          } catch (e) {
            log(`[${item.project}] Failed to create child goal for step ${step.stepKey}: ${e}`, 'warn');
          }
        }
        logEvent('decomposition_dispatch', {
          goalId: item.goal_id,
          project: item.project,
          details: `Created ${incompleteSteps.length} child goals`,
        });
      }
    }
  } catch (e) {
    log(`[${item.project}] Subtask parse error: ${e}`, 'warn');
  }

  // 3. Run post-completion hooks (debrief, checkpoint, retest, knowledge, review, smoke test)
  log(`🧪 [${item.project}] Verifying: ${goal.title.slice(0, 50)}...`);
  let goalRejected = false;
  try {
    const debrief = await withTimeout(runPostCompletionHooks(item.goal_id, output, item.run_id ?? undefined), 360_000, 'runPostCompletionHooks');
    if (!debrief) {
      // Null debrief means goal was rejected (smoke test, review agent, or validation)
      goalRejected = true;
      const rejectedGoal = getGoal(item.goal_id);
      if (rejectedGoal?.status === 'pending') {
        log(`[${item.project}] Goal REJECTED by verification — re-queued as pending`, 'warn');
        logEvent('review_reject', { goalId: item.goal_id, project: item.project, details: goal.title });

        // Dedup: don't spam Telegram if same goal was rejected in last 10 min
        const lastRejection = recentRejections.get(item.goal_id);
        const now = Date.now();
        if (!lastRejection || now - lastRejection > REJECTION_DEDUP_MS) {
          recentRejections.set(item.goal_id, now);

          // Build rich rejection message with failure details
          const reason = rejectedGoal.lastRejectionReason || 'Quality gate (smoke test / review agent)';
          const lines: string[] = [];
          lines.push(`🚫 [${item.project}] ${goal.title} — REJECTED (attempt ${item.attempt_number || '?'})`);
          lines.push('');
          lines.push(reason.slice(0, 800));
          lines.push('');
          lines.push('Agent will retry with this feedback.');

          await withTimeout(sendTelegram(lines.join('\n')), 10_000, 'sendTelegram(rejected)');
        } else {
          log(`[${item.project}] Skipping duplicate rejection Telegram for ${goal.title} (sent ${Math.round((now - lastRejection) / 1000)}s ago)`);
        }

        // Quality-gate rejections do NOT count toward circuit breaker.
        // Only real failures (crashes, timeouts, worker errors) should trip it.
        // Rationale: fragile test commands and review agent false-positives were
        // cascading into circuit breaker trips that stalled entire projects for hours.
        // The goal is re-queued with feedback — that's the self-healing mechanism.
        log(`[${item.project}] Quality gate rejection — NOT counting toward circuit breaker`);
      }
    }
    if (debrief) {
      // Mark goal completed only AFTER all quality gates pass
      markGoalCompleted(item.goal_id, output.slice(-5000));
      clearProjectFailure(item.project);

      // Persist debrief to goals.json so downstream consumers can access it
      updateGoal(item.goal_id, { debrief: debrief as unknown as Record<string, unknown> });

      const debriefSummary = debrief.working
        ? `Working: ${debrief.working.slice(0, 100)}`
        : 'No debrief parsed';
      log(`[${item.project}] Debrief: ${debriefSummary}`);

      if (debrief.retestPassed === false) {
        log(`[${item.project}] Retest FAILED after goal completion`, 'warn');
        await sendTelegram(`🧪 [${item.project}] Tests FAILING after: ${goal.title}`).catch((e) => slog.swallow('send-retest-failed-telegram', e));
      }

      // Confidence-based auto-escalation — notify user when agent is not confident
      if (debrief.confidence === 'low' || debrief.confidence === 'uncertain') {
        log(`[${item.project}] Low confidence completion: ${debrief.confidence}`, 'warn');
        logEvent('low_confidence', { goalId: item.goal_id, project: item.project, details: `confidence=${debrief.confidence}` });
        await sendTelegram(
          `🔍 [${item.project}] ${goal.title} — LOW CONFIDENCE\n\n` +
          `Agent self-assessment: ${debrief.confidence}\n` +
          (debrief.broken ? `Broken: ${debrief.broken.slice(0, 200)}\n` : '') +
          (debrief.verified ? `Verified: ${debrief.verified.slice(0, 200)}\n` : 'No verification reported.\n') +
          `\nPlease review manually.`
        ).catch((e) => slog.swallow('send-low-confidence-telegram', e));
      }

      // Log if agent didn't report verification
      if (!debrief.verified) {
        log(`[${item.project}] Agent did not report VERIFIED field for: ${goal.title}`);
      }

      if (debrief.reviewConcerns) {
        log(`[${item.project}] Review concern: ${debrief.reviewConcerns}`, 'warn');
        logEvent('review_concern', { goalId: item.goal_id, project: item.project, details: debrief.reviewConcerns.slice(0, 300) });
        await sendTelegram(`⚠️ [${item.project}] ${goal.title} — REVIEW CONCERN\n${debrief.reviewConcerns.slice(0, 500)}`).catch((e) => slog.swallow('send-review-concern-telegram', e));

        // Feed review concern into model_task_memory
        try {
          if (item.model) {
            recordQualityAdjustment({
              goalType: classifyGoalType(goal),
              archetype: item.archetype ?? undefined,
              model: item.model as ModelTier,
            });
          }
        } catch (adjErr) {
          log(`[${item.project}] Quality adjustment error: ${adjErr}`, 'warn');
        }
      }
    }
  } catch (hookErr) {
    log(`[${item.project}] Post-completion hooks error: ${hookErr}`, 'warn');
  }

  // 4. Record outcome in model_task_memory
  try {
    recordOutcome({
      goalType: classifyGoalType(goal),
      archetype: item.archetype ?? undefined,
      model: (item.model as ModelTier) || 'primary',
      success: true,
      costUsd: item.cost_usd,
      durationMs: item.started_at && item.completed_at
        ? new Date(item.completed_at).getTime() - new Date(item.started_at).getTime()
        : undefined,
      promoted: false,
    });
  } catch (e) {
    log(`[${item.project}] recordOutcome error: ${e}`, 'warn');
  }

  // 5. E2E verification — disabled (no Playwright specs exist, always rubber-stamps)
  // Re-enable when real E2E specs are written for projects.

  // Gather tunnel URL and debrief summary for both Telegram and Slack notifications
  let tunnelUrl = '';
  let whatChanged = '';
  if (!goalRejected) {
    try {
      const { getTunnelUrl } = await import('../projects/tunnel-manager.js');
      tunnelUrl = getTunnelUrl(item.project) || '';
    } catch (e) { slog.swallow('get-tunnel-url', e); }

    try {
      const { parseDebrief } = await import('../orchestration/goal-manager.js');
      const briefing = parseDebrief(output);
      if (briefing?.working) whatChanged = briefing.working.slice(0, 300);
    } catch (e) { slog.swallow('parse-debrief-what-changed', e); }
  }

  // 6. Build rich completion message with visual review (skip if rejected)
  if (!goalRejected) {
    // Set reviewStatus to pending_review
    updateGoal(item.goal_id, { reviewStatus: 'pending_review' });

    // Gather cost info
    let costStr = '';
    if (item.run_id) {
      try {
        const run = getAgentRun(item.run_id);
        if (run) {
          const dur = run.duration_ms ? `${(run.duration_ms / 60000).toFixed(0)} min` : '?';
          costStr = `${dur}, ${run.model_assigned || '?'}`;
        }
      } catch (e) { slog.swallow('get-agent-run-cost', e); }
    }

    // Extract acceptance criteria from goal description
    let checklist = '';
    try {
      const desc = goal.description || '';
      const criteriaMatch = desc.match(/ACCEPTANCE CRITERIA:\n([\s\S]*?)(?:\n\n|$)/i);
      if (criteriaMatch) {
        const items = criteriaMatch[1]
          .split('\n')
          .map(l => l.replace(/^[-*•]\s*/, '').trim())
          .filter(l => l.length > 0)
          .map(l => `☐ ${l}`)
          .join('\n');
        if (items) checklist = items;
      }
    } catch (e) { slog.swallow('extract-acceptance-criteria', e); }

    // Build the rich message
    const lines: string[] = [];
    lines.push(`✅ [${item.project}] ${goal.title} — DONE`);
    if (costStr) lines.push(`⏱ ${costStr}`);
    if (whatChanged) lines.push(`\n📝 ${whatChanged}`);
    if (tunnelUrl) lines.push(`\n🔗 ${tunnelUrl}`);

    // For jam-sourced goals: include Jam link
    if (goal.source?.startsWith('jam:')) {
      const jamId = goal.source.replace('jam:', '');
      lines.push(`\n🎬 https://jam.dev/c/${jamId}`);
    }

    // Include project page URL for quick visual review (Tailscale-aware)
    if (!tunnelUrl) {
      try {
        const projectConfig = getProject(item.project);
        if (projectConfig?.devPort) {
          // getTunnelUrl already tries Tailscale, but if it failed and we have a port,
          // just build the URL directly — healthCheck is localhost and useless from phone
          const { execSync } = await import('child_process');
          try {
            const tsIp = execSync('tailscale ip -4 2>/dev/null', { timeout: 3000 }).toString().trim();
            if (tsIp && /^\d+\.\d+\.\d+\.\d+$/.test(tsIp)) {
              tunnelUrl = `http://${tsIp}:${projectConfig.devPort}`;
              lines.push(`\n🔗 ${tunnelUrl}`);
            }
          } catch { /* tailscale not available */ }
        }
        if (!tunnelUrl && projectConfig?.healthCheck) {
          lines.push(`\n🌐 ${projectConfig.healthCheck}`);
        }
      } catch (e) { slog.swallow('get-project-health-check-url', e); }
    }

    if (checklist) lines.push(`\n📋 Manual test checklist:\n${checklist}`);
    lines.push(`\nReact 👍 to approve or 👎 to request changes`);

    const msgId = await withTimeout(sendTelegram(
      lines.join('\n')
    ), 10_000, 'sendTelegram(done)');

    // Store message_id → goal_id for reply-based feedback
    if (msgId) {
      try {
        const { saveTelegramGoalMapping } = await import('../bot/telegram-goals.js');
        saveTelegramGoalMapping(msgId, item.goal_id, item.project);
      } catch (e) { slog.swallow('save-telegram-goal-mapping', e); }
    }
  }

  logEvent(goalRejected ? 'review_reject' : 'goal_complete', {
    goalId: item.goal_id,
    project: item.project,
    costUsd: item.cost_usd,
    details: `${item.model || 'primary'}, attempt ${item.attempt_number}`,
  });

  // Notify all channels (best-effort, non-blocking)
  try {
    if (goalRejected) {
      notify({ type: 'goal_rejected', project: item.project, title: goal?.title || item.goal_id, goalId: item.goal_id, reason: 'Review concern — see details above' });
    } else {
      notify({
        type: 'goal_complete',
        project: item.project,
        title: goal?.title || item.goal_id,
        goalId: item.goal_id,
        costUsd: item.cost_usd || undefined,
        tunnelUrl: tunnelUrl || undefined,
        whatChanged: whatChanged || undefined,
        jamId: goal.source?.startsWith('jam:') ? goal.source.replace('jam:', '') : undefined,
      });
    }
  } catch { /* best-effort */ }

  // Log Jam completion for tracing (direct Jam API comment would require API key integration)
  if (!goalRejected && goal.source?.startsWith('jam:')) {
    const jamId = goal.source.replace('jam:', '');
    log(`[${item.project}] Jam-sourced goal completed — Jam ID: ${jamId}, tunnel: ${tunnelUrl || 'none'}`);
    logEvent('goal_complete', {
      goalId: item.goal_id,
      project: item.project,
      details: `jam:${jamId}, tunnel=${tunnelUrl || 'none'}, cost=$${(item.cost_usd || 0).toFixed(2)}`,
    });
  }
}

async function handleFailedGoal(item: WorkItem): Promise<void> {
  const goal = getGoal(item.goal_id);
  const signal = item.exit_signal;

  // Record failed outcome in model_task_memory
  try {
    if (goal) {
      recordOutcome({
        goalType: classifyGoalType(goal),
        archetype: item.archetype ?? undefined,
        model: (item.model as ModelTier) || 'primary',
        success: false,
        costUsd: item.cost_usd,
        promoted: false,
      });
    }
  } catch (e) { slog.swallow('record-failed-outcome', e); }

  if (signal === 'BLOCKED') {
    const isRateLimit = (item.error || '').toLowerCase().includes('session rate limit') ||
                        (item.error || '').toLowerCase().includes('hit your limit');
    if (isRateLimit) {
      // Rate limit is NOT a goal failure — don't count toward circuit breaker
      log(`[${item.project}] Session limit hit via BLOCKED signal — pausing dispatch, not counting as failure`, 'warn');
      recordSessionLimitHit(item.result_output || item.error || '');
      const currentGoal = getGoal(item.goal_id);
      updateGoal(item.goal_id, {
        status: 'pending',
        attemptCount: Math.max(0, (currentGoal?.attemptCount || 1) - 1),
      });
    } else {
      blockGoalWithAudit(item.goal_id, item.project, item.error || 'Unknown blocker', item.result_output ?? undefined);
      trackProjectFailure(item.project, goal?.title);
      await withTimeout(sendTelegram(`⚠️ [${item.project}] ${goal?.title || item.goal_id.slice(0, 8)} — BLOCKED\nWhy: ${(item.error || 'Unknown').slice(0, 200)}`), 10_000, 'sendTelegram(blocked)');
      notify({ type: 'goal_blocked', project: item.project, title: goal?.title || item.goal_id, goalId: item.goal_id, reason: item.error || 'Unknown' }).catch(() => {});
    }
  } else if (signal === 'ESCALATE') {
    blockGoalWithAudit(item.goal_id, item.project, item.error || 'Escalated', item.result_output ?? undefined);
    await withTimeout(sendTelegram(`⚠️ [${item.project}] ${goal?.title || item.goal_id.slice(0, 8)} — NEEDS ATTENTION\nWhy: ${(item.error || 'Escalated by agent').slice(0, 300)}`), 10_000, 'sendTelegram(escalate)');
  } else if (signal === 'BREAK') {
    // Agent wants a break — put back to pending
    updateGoal(item.goal_id, { status: 'pending' });
  } else if (signal === 'session_limited') {
    // Session limit is NOT a goal failure — it's a system-wide constraint.
    // Don't count toward circuit breaker. Don't increment attempts.
    log(`[${item.project}] Session limit hit — pausing ALL dispatch`, 'warn');
    recordSessionLimitHit(item.result_output || item.error || '');
    // Reset goal to pending WITHOUT incrementing attemptCount
    const currentGoal = getGoal(item.goal_id);
    updateGoal(item.goal_id, {
      status: 'pending',
      attemptCount: Math.max(0, (currentGoal?.attemptCount || 1) - 1), // undo the dispatch increment
    });
  } else if (signal === 'rate_limited') {
    log(`[${item.project}] Rate limited — will retry later`);
    recordRateLimitHit();
    updateGoal(item.goal_id, { status: 'pending' });
  } else if (signal === 'cost_exceeded') {
    // Max subscription — cost_exceeded shouldn't fire, but handle gracefully
    log(`[${item.project}] Cost signal: ${goal?.title || item.goal_id.slice(0, 8)}`);
    updateGoal(item.goal_id, { status: 'pending' });
  } else {
    // Generic failure (no signal, timeout, etc.)
    if (item.error && item.error.includes('Max attempts')) {
      // Already handled in monitorActiveWork
    } else {
      // Reset to pending for potential retry — store failure reason for escalation context
      const failReason = item.error ? item.error.slice(0, 300) : 'Unknown failure (timeout or crash)';
      updateGoal(item.goal_id, { status: 'pending', lastRejectionReason: failReason });
      // Log retry silently — no Telegram notification (too noisy, user can't act on retries)
      log(`[${item.project}] ${goal?.title || 'Unknown'} — retrying (reason: ${failReason.slice(0, 200)})`);
    }
  }

  logEvent('goal_failed', {
    goalId: item.goal_id,
    project: item.project,
    costUsd: item.cost_usd,
    details: `signal=${signal}, error=${(item.error || '').slice(0, 200)}`,
  });
}
