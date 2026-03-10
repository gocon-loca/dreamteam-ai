/**
 * Supervisor Dispatch — triage pending goals and enqueue work items.
 */

import { getDb } from '../db/index.js';
import { logEvent } from '../db/supervisor-events.js';
import {
  enqueueWorkItem,
  getActiveItems,
  getQueuedCount,
} from '../db/work-queue.js';
import {
  getPendingGoals,
  getGoal,
  markGoalStarted,
  markGoalBlocked,
  updateGoal,
  checkDependencies,
  findSimilarGoals,
} from '../orchestration/goal-manager.js';
import { buildGoalPrompt } from '../scheduler/prompt-builder.js';
import { classifyGoalType } from '../orchestration/model-router.js';
import type { ModelTier } from '../orchestration/model-config.js';
import { getLadder } from '../orchestration/model-config.js';
import { isTripped } from '../orchestration/circuit-breaker.js';
import { parseTestCommands, validateTestCommandSyntax } from '../orchestration/test-commands.js';
import { enrichTestCommands, isBuildOnlyTestCommands, classifyBugCategory } from '../orchestration/test-command-generator.js';
import { getProject } from '../projects/registry.js';
import { planAndDecompose } from '../orchestration/planning-agent.js';
import { getRunsByGoal } from '../db/execution-log.js';
import { createLogger } from '../utils/logger.js';

import { config, isSessionLimitPaused, getSessionLimitPauseUntil } from './supervisor-config.js';

const slog = createLogger('supervisor-dispatch');
import {
  getLastPreflight,
  lastDispatchedProject,
  setLastDispatchedProject,
  rateLimitPauseUntil,
} from './supervisor-state.js';
import { log } from './supervisor-utils.js';
import { isCapacityExceeded, isRateLimitPaused } from './supervisor-capacity.js';
import { blockGoalWithAudit } from './supervisor-goals.js';

// ── Dispatch Loop ─────────────────────────────────────────
//
// Gates: preflight passed, workers available, circuit breaker,
//        dependencies met, budget available. That's it.

// Track silent skip reasons to log periodically (not every 30s loop)
let lastSkipReason = '';
let skipCount = 0;
const SKIP_LOG_INTERVAL = 20; // Log every N skips (~10 min at 30s loop)

function logSkip(reason: string): void {
  if (reason === lastSkipReason) {
    skipCount++;
    if (skipCount % SKIP_LOG_INTERVAL === 0) {
      log(`Dispatch blocked (${skipCount}x): ${reason}`, 'warn');
    }
  } else {
    lastSkipReason = reason;
    skipCount = 1;
    log(`Dispatch blocked: ${reason}`, 'warn');
  }
}

export function dispatch(): void {
  const lastPreflight = getLastPreflight();
  if (!lastPreflight.ready) {
    logSkip(`preflight not ready: ${lastPreflight.issues.join('; ')}`);
    return;
  }

  const activeCount = getActiveItems().length;
  const queuedCount = getQueuedCount();
  if (activeCount + queuedCount >= config.maxWorkers) return; // Normal — workers busy

  if (isCapacityExceeded()) {
    if (isSessionLimitPaused()) {
      // Only log every 5 minutes to avoid noise
      const sessionLimitPauseUntil = getSessionLimitPauseUntil();
      const minLeft = Math.round((sessionLimitPauseUntil - Date.now()) / 60000);
      if (minLeft % 5 === 0 || minLeft <= 1) {
        log(`Session limit pause — not dispatching (resumes in ${minLeft} min at ${new Date(sessionLimitPauseUntil).toLocaleTimeString()})`, 'warn');
      }
    } else if (isRateLimitPaused()) {
      log(`Rate limit pause active — not dispatching (resumes at ${new Date(rateLimitPauseUntil).toISOString()})`, 'warn');
    } else {
      log(`Daily goal limit reached (${config.maxGoalsPerDay}) — not dispatching`, 'warn');
    }
    return;
  }

  const pending = getPendingGoals();
  if (pending.length === 0) return;

  // Priority lanes: user-created goals dispatch before auto-generated ones.
  // Order: user-created (no source) > director-proposed > auto-generated (pm-sweep, test-sweep, meta-review)
  const AUTO_SOURCES = /^(pm-sweep|test-sweep|meta-review)/;
  pending.sort((a, b) => {
    const aPri = !a.source ? 0 : AUTO_SOURCES.test(a.source) ? 2 : 1;
    const bPri = !b.source ? 0 : AUTO_SOURCES.test(b.source) ? 2 : 1;
    return aPri - bPri;
  });

  // Round-robin: deprioritize the last-dispatched project so others get a turn
  if (lastDispatchedProject) {
    const deprioritized = lastDispatchedProject;
    pending.sort((a, b) => {
      const aLast = a.project === deprioritized ? 1 : 0;
      const bLast = b.project === deprioritized ? 1 : 0;
      return aLast - bLast; // non-last-dispatched first
    });
  }

  // Per-project load tracking
  const projectLoad = new Map<string, number>();
  for (const item of getActiveItems()) {
    projectLoad.set(item.project, (projectLoad.get(item.project) || 0) + 1);
  }
  const queuedRows = getDb().prepare(
    `SELECT project, COUNT(*) as cnt FROM work_queue WHERE status = 'queued' GROUP BY project`
  ).all() as Array<{ project: string; cnt: number }>;
  for (const row of queuedRows) {
    projectLoad.set(row.project, (projectLoad.get(row.project) || 0) + row.cnt);
  }

  const globalMaxPerProject = config.maxWorkersPerProject ?? config.maxWorkers;
  let slots = config.maxWorkers - activeCount - queuedCount;
  let dispatched = 0;
  const skipReasons = new Map<string, string[]>(); // reason → goal titles

  for (const goal of pending) {
    if (slots <= 0) break;

    // Per-project concurrency limit — each goal gets its own git worktree,
    // so multiple goals can run concurrently on the same project.
    let maxPerProject = globalMaxPerProject;
    try {
      const projectConfig = getProject(goal.project);
      if (projectConfig?.maxConcurrentGoals != null) {
        maxPerProject = projectConfig.maxConcurrentGoals;
      }
    } catch { /* project not found — use global */ }
    if ((projectLoad.get(goal.project) || 0) >= maxPerProject) {
      const key = `${goal.project} concurrency limit (${maxPerProject})`;
      skipReasons.set(key, [...(skipReasons.get(key) || []), goal.title.slice(0, 40)]);
      continue;
    }

    // Circuit breaker
    if (isTripped(goal.project)) {
      const key = `${goal.project} circuit breaker tripped`;
      skipReasons.set(key, [...(skipReasons.get(key) || []), goal.title.slice(0, 40)]);
      continue;
    }

    // Dependencies
    if (goal.dependsOn && goal.dependsOn.length > 0) {
      const depCheck = checkDependencies(goal);
      if (!depCheck.ready) {
        if (depCheck.shouldBlock) {
          markGoalBlocked(goal.id, `Dependency failed: ${depCheck.blockerIds!.join(', ')}`);
          log(`[${goal.project}] Goal blocked — dep failed: ${depCheck.blockerIds!.join(', ')}`, 'warn');
        } else {
          const key = `dependencies not met`;
          skipReasons.set(key, [...(skipReasons.get(key) || []), goal.title.slice(0, 40)]);
        }
        continue;
      }
    }

    // Dev server health: log warning but don't skip dispatch.
    // Many goals (layout, components, backend) don't need a running dev server.
    // The smoke test gate (Gate 2) already handles unhealthy servers gracefully.
    if (lastPreflight.projectHealth.get(goal.project) === false) {
      log(`[${goal.project}] Dev server unhealthy — dispatching anyway (smoke test will be skipped)`, 'warn');
    }

    // Complexity-aware model selection via configurable ladders
    const attempts = goal.attemptCount || 0;
    const desc = (goal.description || '').toLowerCase();
    const touchesAuth = /supabase.*rls|rls.*policy|row.level.security|service.role|auth.*middleware|auth.*guard/.test(desc);

    let ladder: ModelTier[];
    if (touchesAuth) {
      ladder = getLadder('auth');
    } else if (goal.complexity === 'complex') {
      ladder = getLadder('complex');
    } else {
      ladder = getLadder('routine');
    }

    // Previously-blocked goals that were unblocked (have blockedReason cleared
    // or lastRejectionReason from prior attempts) go straight to primary.
    // These have already burned through the ladder — don't waste more runs on lower tiers.
    const wasPreviouslyBlocked = goal.lastRejectionReason?.includes('Failed on all') ||
      goal.lastRejectionReason?.includes('max attempts') ||
      goal.lastRejectionReason?.includes('Worker died');
    if (wasPreviouslyBlocked && attempts === 0) {
      ladder = ['primary', 'primary', 'primary'];
      log(`[${goal.project}] Previously blocked goal — skipping ladder, using primary directly`);
    }

    // Goals with detailed descriptions (Jam-sourced, user-reported with file paths)
    // are too complex for haiku — start at secondary minimum.
    const hasDetailedContext = desc.length > 500 ||
      /\b(line \d+|lines? \d+-\d+)\b/.test(desc) ||
      /\b(file|\.tsx?|\.py|\.ts)\b.*\b(line|function|class)\b/.test(desc);
    if (hasDetailedContext && ladder[0] === 'ancillary' && !wasPreviouslyBlocked) {
      ladder = ['secondary', 'primary', 'primary'];
      log(`[${goal.project}] Detailed goal description — starting at secondary instead of ancillary`);
    }

    if (attempts >= ladder.length) {
      blockGoalWithAudit(goal.id, goal.project, `Failed on all 3 attempts. Needs human rewrite.`, goal.output ?? undefined);
      log(`🛑 [${goal.project}] ${goal.title.slice(0, 50)} — blocked after ${attempts} attempts`, 'warn');
      continue;
    }

    const escalatedModel = ladder[attempts];

    // Deduplication: skip goals that are highly similar to recently completed ones
    const recentSimilar = findSimilarGoals(goal.project, goal.title, {
      includeStatuses: ['completed'],
      sinceMs: 48 * 60 * 60 * 1000, // 48 hours
    });
    const highSimilar = recentSimilar.filter(m => m.similarity >= 0.6);
    if (highSimilar.length > 0 && (goal.attemptCount || 0) === 0) {
      const top = highSimilar[0];
      const pct = Math.round(top.similarity * 100);
      log(`[Dedup] Skipping "${goal.title.slice(0, 50)}" — ${pct}% similar to completed "${top.goal.title.slice(0, 50)}" (${top.goal.id})`, 'warn');
      markGoalBlocked(goal.id, `Likely duplicate: ${pct}% similar to completed goal "${top.goal.title}" (${top.goal.id}). Use /redo or /approve to override.`);
      logEvent('goal_dedup_blocked', { goalId: goal.id, project: goal.project, details: `${pct}% similar to ${top.goal.id}` });
      continue;
    }

    // Planning agent: decompose complex goals on first attempt
    if (goal.complexity === 'complex' && (goal.attemptCount || 0) === 0 && !goal.source?.startsWith('planning:') && !goal.source?.startsWith('decomposition:')) {
      try {
        const childIds = planAndDecompose(goal);
        if (childIds.length > 0) {
          log(`[${goal.project}] Planning agent decomposed "${goal.title.slice(0, 40)}" into ${childIds.length} sub-goals`);
          logEvent('planning_complete', { goalId: goal.id, project: goal.project, details: `${childIds.length} sub-goals created` });
          continue; // Skip this goal — children will be dispatched
        }
      } catch (e) {
        log(`[${goal.project}] Planning agent error (proceeding without decomposition): ${e}`, 'warn');
      }
    }

    // Pre-dispatch: validate TEST_COMMANDS syntax (catch broken commands before spending tokens)
    const testCommands = parseTestCommands(goal.description || '');
    if (testCommands.length > 0) {
      const syntaxWarnings = validateTestCommandSyntax(testCommands);
      if (syntaxWarnings.length > 0) {
        log(`[${goal.project}] TEST_COMMANDS syntax warnings for "${goal.title.slice(0, 40)}": ${syntaxWarnings.join('; ')}`, 'warn');
        logEvent('test_command_syntax_warning', { goalId: goal.id, project: goal.project, details: syntaxWarnings.join('; ') });
      }

      // Enrich build-only TEST_COMMANDS with behavioral checks for runtime bugs
      if (isBuildOnlyTestCommands(testCommands)) {
        const category = classifyBugCategory(goal.title, goal.description);
        if (category !== 'build-time') {
          const enriched = enrichTestCommands(goal);
          if (enriched !== (goal.description || '')) {
            goal.description = enriched;
            log(`[${goal.project}] Enriched build-only TEST_COMMANDS with ${category} checks for "${goal.title.slice(0, 40)}"`);
            logEvent('test_commands_enriched', { goalId: goal.id, project: goal.project, details: `category=${category}` });
          }
        }
      }
    }

    // Enqueue
    try {
      const built = buildGoalPrompt(goal, goal.project);
      const costLimit = built.archetype === 'integration' || built.archetype === 'research'
        ? config.perGoalCostComplex
        : config.perGoalCostDefault;

      // Add failure context for retry attempts
      let prompt = built.prompt;
      if (attempts > 0 && (goal.lastRejectionReason || goal.output)) {
        const prevModel = ladder[attempts - 1];
        const sections: string[] = [
          `## Previous Attempt (${prevModel})`,
          `Your work is on a feature branch with the previous agent's commits intact.`,
          `Build on what already works. Fix what failed. Do NOT start over.`,
          ``,
        ];

        // NOTE: lastRejectionReason is already injected by prompt-builder (section 4c)
        // with richer gate-specific formatting. Don't duplicate it here.

        // Get full-fidelity output from agent_runs (50K) instead of truncated goals.json (5K)
        let agentOutput = goal.output || '';
        try {
          const runs = getRunsByGoal(goal.id);
          const lastRun = runs[runs.length - 1];
          if (lastRun?.output_text) agentOutput = lastRun.output_text;
        } catch (e) { slog.swallow('get-runs-by-goal', e); }

        const debriefMatch = agentOutput.match(/---DEBRIEF---([\s\S]*?)---END_DEBRIEF---/);
        if (debriefMatch) {
          sections.push(`**Previous agent's debrief:**`);
          sections.push(debriefMatch[1].trim().slice(0, 1500));
        }

        sections.push(`---`);
        sections.push(``);

        prompt = sections.join('\n') + prompt;
      }

      // Increment attemptCount on dispatch
      updateGoal(goal.id, { attemptCount: attempts + 1 });

      enqueueWorkItem(goal.id, goal.project, prompt, escalatedModel, built.archetype, costLimit);
      markGoalStarted(goal.id);
      projectLoad.set(goal.project, (projectLoad.get(goal.project) || 0) + 1);
      setLastDispatchedProject(goal.project);
      slots--;
      dispatched++;

      // Pre-goal snapshot (fire-and-forget)
      import('../orchestration/smoke-test.js')
        .then(({ capturePreGoalSnapshot }) => capturePreGoalSnapshot(goal.project))
        .catch(err => log(`Pre-goal snapshot failed for ${goal.project}: ${err}`, 'warn'));

      const escalationNote = attempts > 0 ? ` (escalated from ${ladder[attempts - 1]})` : '';
      const ladderLabel = ladder.join('→');
      log(`Enqueued [${goal.project}] ${goal.title.slice(0, 50)} — model=${escalatedModel}${escalationNote}, attempt ${attempts + 1}/3, ladder=${ladderLabel}, archetype=${built.archetype}`);
      logEvent('dispatch', { goalId: goal.id, project: goal.project, details: `model=${escalatedModel}, attempt=${attempts + 1}, ladder=${ladderLabel}` });
    } catch (e) {
      log(`Enqueue error for ${goal.id}: ${e}`, 'error');
    }
  }

  // Log summary when pending goals exist but none were dispatched
  if (dispatched === 0 && pending.length > 0 && skipReasons.size > 0) {
    const reasons = [...skipReasons.entries()]
      .map(([reason, titles]) => `${reason} (${titles.length})`).join(', ');
    logSkip(`${pending.length} pending but all skipped: ${reasons}`);
  } else if (dispatched > 0) {
    // Reset skip tracking on successful dispatch
    lastSkipReason = '';
    skipCount = 0;
  }
}
