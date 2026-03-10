/**
 * Task Runner - Executes Claude Code CLI for autonomous work
 * Supports continuation loops and goal completion detection.
 *
 * Two execution backends:
 *   1. CLI: spawns `claude --print` via child_process (legacy, default)
 *   2. SDK: uses @anthropic-ai/claude-agent-sdk query() (behind DREAMTEAM_USE_SDK=1)
 */

import { spawn, ChildProcess } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getProject } from './registry.js';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { ensureDevServerRunning } from './dev-server.js';
import {
  submitAssessment,
  escalateConcern,
  ConfidenceLevel,
  ConcernType,
} from '../orchestration/quality.js';
import {
  trackProcess,
  untrackProcess,
} from '../orchestration/process-tracker.js';
import {
  insertAgentRun,
  updateAgentRun,
  generateAutoTags,
  type AgentRunUpdate,
} from '../db/execution-log.js';
import { saveCheckpoint } from '../db/checkpoints.js';
import type { GoalTraceContext } from '../tracing/langfuse.js';

export interface TaskResult {
  success: boolean;
  output: string;
  goalComplete: boolean;
  blocked: boolean;
  blockedReason?: string;
  iterations: number;
  assumptions: string[];
  /** True if agent tried to surrender (declare something unfixable) */
  surrenderDetected?: boolean;
  /** The pattern that triggered surrender detection */
  surrenderPattern?: string;
  /** Cost and token data from JSON output */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** True if JSON output parsing failed (fell back to text mode) */
  jsonParseFailed: boolean;
  /** Decomposed sub-tasks, if agent emitted DECOMPOSITION block */
  subtasks?: Array<{ step: string; description: string; criteria?: string }>;
  /** Screenshot paths captured via SCREENSHOT: signals */
  screenshots?: string[];
  /** Database run ID */
  runId?: string;
  /** Completion artifact data from .dreamteam/complete.json */
  completionArtifact?: {
    status?: string;
    summary?: string;
    filesModified?: string[];
    testsRun?: string;
    verified?: string;
  };
}

// Re-export ModelTier from the central model configuration
export type { ModelTier } from '../orchestration/model-config.js';
import type { ModelTier } from '../orchestration/model-config.js';
import { resolveModel, getCliConfig, resolveBackendModel } from '../orchestration/model-config.js';
import type { CliBackend, CliInvocationOptions } from '../orchestration/cli-backend.js';

export interface TaskOptions {
  autonomous: boolean;
  maxIterations: number;
  onProgress?: (output: string) => void;
  // Model selection for cost optimization
  model?: ModelTier;
  // Use sub-agents (spawns Sonnet agents from Opus orchestrator)
  useSubAgents?: boolean;
  // Goal ID for process tracking (critical for orphan recovery)
  goalId?: string;
  // Agent archetype (frontend/backend/integration/test-fix/docs/devops)
  archetype?: string;
  // Enable sequential thinking MCP tool for complex reasoning
  useSequentialThinking?: boolean;
  // Enable web search tool for research tasks
  enableWebSearch?: boolean;
  // Archetype-specific MCP tools to enable
  allowedTools?: string[];
  // Override working directory (for worktree-based execution)
  cwdOverride?: string;
  // CLI backend name (default: 'claude'). Use 'codex' for OpenAI Codex CLI.
  backend?: string;
  // Per-iteration timeout in ms (default: 10 min routine, 20 min complex)
  timeoutMs?: number;
  // Langfuse trace context (passed from worker)
  _traceContext?: GoalTraceContext;
  // Work item ID for checkpointing
  _workItemId?: string;
}

/** Resolve a ModelTier to a concrete model name string (e.g. 'primary' → 'opus') */
function resolveModelName(tier: ModelTier): string {
  return resolveModel(tier);
}

/** Feature flag: set DREAMTEAM_USE_SDK=1 to use the Agent SDK instead of CLI */
const USE_SDK = process.env.DREAMTEAM_USE_SDK === '1';

const DEFAULT_OPTIONS: TaskOptions = {
  autonomous: true,
  maxIterations: 50,
  model: 'primary', // Default to primary (most capable) for complex autonomous work
  useSubAgents: true, // Enable Sonnet sub-agents for cost optimization
};

// Session/usage limit patterns — hours-long (or days-long) cooldown.
// These mean "your plan's session/weekly quota is exhausted" — NOT a per-request throttle.
export const SESSION_LIMIT_PATTERNS = [
  /you[''\u2019]ve hit your limit/i,
  /usage.?limit.*reset/i,
  /session.?limit/i,
  /daily.?limit/i,
  /weekly.?limit/i,
  /limit.*resets?\s+\d{1,2}\s*[ap]m/i,
  /limit.*resets?\s+[A-Z][a-z]{2}\s+\d{1,2}/i,  // "resets Feb 20" (weekly)
];

export function isSessionLimit(output: string): boolean {
  return SESSION_LIMIT_PATTERNS.some(p => p.test(output));
}

// Month abbreviation lookup
const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse reset time from session limit message. Handles:
 *   "resets 4am"                              → today/tomorrow at 4:00
 *   "resets 2pm (UTC)"                        → today/tomorrow at 14:00
 *   "resets Feb 20, 5pm"                      → Feb 20 at 17:00 (weekly)
 *   "resets Feb 11, 7pm (America/New_York)"   → Feb 11 at 19:00 (weekly)
 * Returns null if no reset time found.
 */
export function parseResetTime(output: string): Date | null {
  // Format 1: Date + time — "resets Feb 20, 5pm" or "resets Feb 11, 7pm (America/New_York)"
  const dateMatch = output.match(
    /resets?\s+([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{1,2})\s*(am|pm)/i
  );
  if (dateMatch) {
    const monthStr = dateMatch[1].toLowerCase();
    const day = parseInt(dateMatch[2]);
    let hours = parseInt(dateMatch[3]);
    const isPM = dateMatch[4].toLowerCase() === 'pm';
    if (isPM && hours < 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;

    const month = MONTH_MAP[monthStr];
    if (month !== undefined) {
      const reset = new Date();
      reset.setMonth(month, day);
      reset.setHours(hours, 0, 0, 0);
      // If the date is in the past, it's next year
      if (reset.getTime() < Date.now()) {
        reset.setFullYear(reset.getFullYear() + 1);
      }
      return reset;
    }
  }

  // Format 2: Time only — "resets 4am" or "resets 2pm (UTC)"
  const timeMatch = output.match(/resets?\s+(\d{1,2})\s*(am|pm)/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const isPM = timeMatch[2].toLowerCase() === 'pm';
    if (isPM && hours < 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;

    const reset = new Date();
    // If the reset hour is in the past (or current hour), it means tomorrow
    if (reset.getHours() >= hours) {
      reset.setDate(reset.getDate() + 1);
    }
    reset.setHours(hours, 0, 0, 0);
    return reset;
  }

  return null;
}

// Lockout detection patterns — exported for use by supervisor/worker
// These are brief per-request rate limits (429s, throttling), NOT session-wide limits.
// IMPORTANT: These are tested against FULL agent output, so they must not match
// normal code discussion (e.g., an agent implementing rate limiting or error messages).
// Only match patterns that look like actual API/CLI error responses.
export const LOCKOUT_PATTERNS = [
  /(?:anthropic|claude|api|http|429).*rate.?limit/i,
  /quota.?exceeded/i,
  /(?:status|error|response).?(?:code)?.?429/i,
  /too.?many.?requests.*(?:retry|wait|slow)/i,
  /(?:anthropic|claude|api).*exceeded.*limit/i,
  /(?:please|you must)\s+try.?again.?later/i,
];

export function isLockoutError(output: string): boolean {
  // Session limits are handled separately — don't double-count
  if (isSessionLimit(output)) return false;
  return LOCKOUT_PATTERNS.some(pattern => pattern.test(output));
}

// Signals the agent should emit
const GOAL_COMPLETE_SIGNAL = 'GOAL_COMPLETE';
const BLOCKED_SIGNAL = 'BLOCKED:';
const ASSUMPTION_SIGNAL = 'ASSUMPTION:';

// Surrender patterns — agents trying to give up instead of escalating.
// IMPORTANT: These patterns must not match legitimate explanations of scope or progress.
// "out of scope" and "partially complete" are commonly used by agents explaining what
// they chose NOT to do (correct behavior), not surrendering.
const SURRENDER_PATTERNS = [
  /unfixable/i,
  /impossible to (?:fix|resolve|repair|solve)/i,
  /cannot (?:be )?(?:fixed|resolved|repaired|solved)/i,
  /unable to (?:fix|resolve|repair|solve) (?:this|the|any)/i,
  /GOAL_COMPLETE\s*\(partial\)/i,
  /(?:this|the) (?:issue|bug|problem) (?:is |appears )?(?:in|with) the (?:framework|library|dependency|build tool)/i,
  /recommend(?:ation)?:?\s*(?:file a bug|report|downgrade|upgrade)/i,
  // Removed: "beyond scope", "out of scope", "partially complete", "not possible/feasible"
  // These are commonly used in legitimate agent output explaining scoping decisions.
];

// Parse self-assessment from output
function parseAssessment(output: string, goalId: string, project: string): void {
  const assessmentMatch = output.match(/ASSESSMENT:[\s\S]*?(?=ESCALATE:|GOAL_COMPLETE|BLOCKED:|$)/i);
  if (!assessmentMatch) return;

  const block = assessmentMatch[0];

  const workingWellMatch = block.match(/WORKING_WELL:\s*(.+)/i);
  const needsWorkMatch = block.match(/NEEDS_WORK:\s*(.+)/i);
  const confidenceMatch = block.match(/CONFIDENCE:\s*(high|medium|low|uncertain)/i);
  const confidenceReasonMatch = block.match(/CONFIDENCE_REASON:\s*(.+)/i);

  const workingWell = workingWellMatch?.[1]?.split(',').map(s => s.trim()).filter(Boolean) || [];
  const needsWork = needsWorkMatch?.[1]?.split(',').map(s => s.trim()).filter(Boolean) || [];
  const confidence = (confidenceMatch?.[1]?.toLowerCase() || 'medium') as ConfidenceLevel;
  const confidenceReason = confidenceReasonMatch?.[1]?.trim() || 'No reason provided';

  submitAssessment({
    goalId,
    project,
    workingWell,
    notWorkingWell: needsWork,
    confidence,
    confidenceReason,
    claims: workingWell.map(claim => ({
      claim,
      confidence,
    })),
  });
}

// Parse escalation from output
function parseEscalation(output: string, goalId: string, project: string): void {
  const escalateMatch = output.match(/ESCALATE:\s*(quality|scope|breaking|security|architecture|performance|other)/i);
  if (!escalateMatch) return;

  const type = escalateMatch[1].toLowerCase() as ConcernType;
  const severityMatch = output.match(/SEVERITY:\s*(info|warning|critical)/i);
  const descriptionMatch = output.match(/DESCRIPTION:\s*(.+)/i);
  const needsDecisionMatch = output.match(/NEEDS_DECISION:\s*(true|false)/i);

  escalateConcern(goalId, project, {
    type,
    severity: (severityMatch?.[1]?.toLowerCase() || 'warning') as 'info' | 'warning' | 'critical',
    description: descriptionMatch?.[1]?.trim() || 'No description',
    needsHumanDecision: needsDecisionMatch?.[1]?.toLowerCase() === 'true',
  });
}

export async function runTask(
  projectName: string,
  prompt: string,
  options: Partial<TaskOptions> = {}
): Promise<TaskResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const project = getProject(projectName);

  // Use worktree path if provided, otherwise fall back to project.path
  const cwd = opts.cwdOverride || project.path;

  // Try to start dev server, but don't block if it fails
  // Dev servers always run from project.path (shared), not worktrees
  if (project.hasDevServer) {
    const serverReady = await ensureDevServerRunning(projectName);
    if (!serverReady) {
      console.log(`[TaskRunner] Dev server for ${projectName} failed to start - agent will handle it`);
    }
  }

  // Clean up stale completion artifact BEFORE running agent.
  // Old complete.json from a previous goal can trick the exit-signal parser
  // into reporting GOAL_COMPLETE on a rate-limited or empty run.
  const staleArtifact = join(cwd, '.dreamteam', 'complete.json');
  try { unlinkSync(staleArtifact); } catch { /* doesn't exist — fine */ }

  let fullOutput = '';
  let iterations = 0;
  let goalComplete = false;
  let blocked = false;
  let blockedReason: string | undefined;
  let surrenderDetected = false;
  let surrenderPattern: string | undefined;
  const assumptions: string[] = [];
  const screenshots: string[] = [];

  // Cost/token accumulators across iterations
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let anyJsonParseFailed = false;

  const startTime = Date.now();

  // Insert agent_run record at the start
  let runId: string | undefined;
  const goalId = opts.goalId || `task-${Date.now()}`;
  try {
    const toolsList = ['playwright', 'puppeteer', 'github', 'memory'];
    if (opts.useSequentialThinking) toolsList.push('sequential-thinking');
    if (opts.enableWebSearch) toolsList.push('web-search');

    runId = insertAgentRun({
      goalId,
      project: projectName,
      modelAssigned: opts.model || 'primary',
      archetype: opts.archetype,
      backend: opts.backend || 'claude',
      promptText: prompt.slice(0, 10000), // cap stored prompt size
      toolsEnabled: toolsList,
    });
    console.log(`[TaskRunner] Created agent_run ${runId} for goal ${goalId}`);
  } catch (e) {
    console.error('[TaskRunner] Failed to insert agent_run:', e);
  }

  // Enhanced prompt with instructions for autonomous work
  const enhancedPrompt = buildEnhancedPrompt(prompt, opts.autonomous, opts.useSubAgents);

  // SDK mode: single query() call handles everything (turns, continuation, timeout)
  if (USE_SDK) {
    console.log(`[TaskRunner] Using SDK mode for ${goalId}`);
    const sdkResult = await runClaudeViaSDK(
      cwd,
      enhancedPrompt,
      {
        model: opts.model,
        goalId: opts.goalId,
        project: projectName,
        maxTurns: opts.maxIterations * 100, // SDK turns ≈ individual tool calls, much more granular
        onProgress: opts.onProgress,
      }
    );

    fullOutput = sdkResult.output;
    iterations = 1; // SDK is single invocation
    totalCostUsd = sdkResult.costUsd;
    totalInputTokens = sdkResult.inputTokens;
    totalOutputTokens = sdkResult.outputTokens;
    totalCacheReadTokens = sdkResult.cacheReadTokens;
    totalCacheCreationTokens = sdkResult.cacheCreationTokens;
    anyJsonParseFailed = sdkResult.jsonParseFailed;

    // Check for session/rate limits before completion signals
    if (isSessionLimit(sdkResult.output)) {
      console.log(`[TaskRunner] SESSION LIMIT detected (SDK mode): "${sdkResult.output.slice(0, 100)}"`);
      blocked = true;
      blockedReason = `Session rate limit hit: ${sdkResult.output.slice(0, 200)}`;
      const resetTime = parseResetTime(sdkResult.output);
      if (resetTime) {
        blockedReason += ` (resets at ${resetTime.toISOString()})`;
      }
    } else if (sdkResult.output.includes(GOAL_COMPLETE_SIGNAL)) {
      const surrenderMatch = SURRENDER_PATTERNS.find(p => p.test(sdkResult.output));
      if (surrenderMatch) {
        surrenderDetected = true;
        surrenderPattern = surrenderMatch.toString();
      } else {
        goalComplete = true;
      }
    }
    if (sdkResult.output.includes(BLOCKED_SIGNAL)) {
      blocked = true;
      const match = sdkResult.output.match(/BLOCKED:\s*(.+?)(?:\n|$)/);
      blockedReason = match?.[1] || 'Unknown blocker';
    }

    // Extract assumptions and screenshots
    for (const match of sdkResult.output.matchAll(/ASSUMPTION:\s*(.+?)(?:\n|$)/g)) {
      assumptions.push(match[1]);
    }
    for (const match of sdkResult.output.matchAll(/SCREENSHOT:\s*(.+?)(?:\n|$)/g)) {
      screenshots.push(match[1].trim());
    }
  } else {

  // CLI mode: iteration loop with --continue

  const traceCtx = opts._traceContext;
  const workItemId = opts._workItemId;

  while (iterations < opts.maxIterations && !goalComplete && !blocked) {
    iterations++;

    const iterSpan = traceCtx?.span(`iteration-${iterations}`, { model: opts.model });
    const iterGen = traceCtx?.generation(`claude-iteration-${iterations}`, {
      model: resolveModelName(opts.model || 'primary'),
      input: iterations === 1 ? enhancedPrompt?.slice(0, 500) : '[continuation]',
    });

    const isFirstRun = iterations === 1;
    const backendName = opts.backend || 'claude';
    const result = backendName === 'claude'
      ? await runClaudeOnce(
            cwd,
            isFirstRun ? enhancedPrompt : undefined,
            !isFirstRun, // use --continue for subsequent runs
            {
              model: opts.model,
              useSubAgents: opts.useSubAgents,
              goalId: opts.goalId,
              project: projectName,
              prompt: isFirstRun ? enhancedPrompt?.slice(0, 500) : undefined,
              allowedTools: opts.allowedTools,
              timeoutMs: opts.timeoutMs,
            }
          )
      : await runCliOnce(
            cwd,
            isFirstRun ? enhancedPrompt : undefined,
            !isFirstRun,
            backendName,
            {
              model: opts.model,
              modelTier: opts.model,
              goalId: opts.goalId,
              project: projectName,
              prompt: isFirstRun ? enhancedPrompt?.slice(0, 500) : undefined,
              allowedTools: opts.allowedTools,
            }
          );

    // Cost/token accounting:
    // Claude CLI with --continue reports CUMULATIVE total_cost_usd for the session,
    // not the incremental cost of just this iteration. So for continuations,
    // take the MAX (latest cumulative value) instead of summing.
    // The usage.input_tokens/output_tokens fields ARE incremental, so those sum normally.
    if (!isFirstRun && result.costUsd > 0) {
      // Continuation: total_cost_usd is cumulative — take the higher value
      totalCostUsd = Math.max(totalCostUsd, result.costUsd);
    } else {
      totalCostUsd += result.costUsd;
    }
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    totalCacheReadTokens += result.cacheReadTokens;
    totalCacheCreationTokens += result.cacheCreationTokens;
    if (result.jsonParseFailed) anyJsonParseFailed = true;

    fullOutput += result.output;
    opts.onProgress?.(result.output);

    // End iteration trace span
    iterGen?.end({
      output: result.output.slice(-500),
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        totalCostUsd: result.costUsd,
      },
      statusMessage: result.timedOut ? 'timeout' : `exit:${result.exitCode}`,
    });
    iterSpan?.end({ exitCode: result.exitCode, timedOut: result.timedOut });

    // Save checkpoint after each iteration (crash recovery)
    if (workItemId) {
      try {
        saveCheckpoint({
          goalId: goalId,
          workItemId,
          runId,
          project: projectName,
          iteration: iterations,
          outputSoFar: fullOutput,
          costUsdSoFar: totalCostUsd,
          inputTokensSoFar: totalInputTokens,
          outputTokensSoFar: totalOutputTokens,
          cacheReadTokensSoFar: totalCacheReadTokens,
          cacheCreationTokensSoFar: totalCacheCreationTokens,
        });
      } catch (e) {
        console.warn(`[TaskRunner] Checkpoint save failed:`, e);
      }
    }

    // CRITICAL: Detect session/rate limits BEFORE checking for completion signals.
    // A rate-limited run returns in ~2s with "You've hit your limit" as the entire output.
    // Without this check, the run burns through all attempts counting each as a failure.
    if (isSessionLimit(result.output)) {
      console.log(`[TaskRunner] SESSION LIMIT detected in iteration ${iterations}: "${result.output.slice(0, 100)}"`);
      blocked = true;
      blockedReason = `Session rate limit hit: ${result.output.slice(0, 200)}`;
      const resetTime = parseResetTime(result.output);
      if (resetTime) {
        blockedReason += ` (resets at ${resetTime.toISOString()})`;
      }
      break;
    }

    // CRITICAL: Detect silent failures — if output is tiny or exit code is non-zero,
    // the continuation likely failed. Log it and break instead of looping forever.
    if (result.exitCode !== 0 && result.output.length < 500) {
      console.error(`[TaskRunner] Iteration ${iterations} failed: exit code ${result.exitCode}, output ${result.output.length} bytes`);
      console.error(`[TaskRunner] Output: ${result.output.slice(0, 200)}`);
      // Don't keep retrying the same broken continuation — break out
      break;
    }

    // Check for signals in output
    if (result.output.includes(GOAL_COMPLETE_SIGNAL)) {
      // Timeout rejection: if this iteration was killed by timeout, ignore GOAL_COMPLETE
      // (the signal may be in the output buffer from before the kill)
      if (result.timedOut) {
        console.log(`[TaskRunner] Ignoring GOAL_COMPLETE from timed-out iteration ${iterations}`);
        // Don't set goalComplete — let the loop continue or end naturally
        continue;
      }

      // Surrender detection: check if agent is giving up disguised as completion
      const surrenderMatch = SURRENDER_PATTERNS.find(p => p.test(result.output));
      if (surrenderMatch) {
        surrenderDetected = true;
        surrenderPattern = surrenderMatch.toString();
        console.log(`[TaskRunner] SURRENDER DETECTED in iteration ${iterations}: pattern "${surrenderMatch}" matched. Rejecting completion and retrying.`);
        const retryPrompt = [
          'Your previous attempt was REJECTED because it contained surrender language.',
          `Detected pattern: "${surrenderMatch}"`,
          '',
          'Rules:',
          '- You CANNOT declare something "unfixable" or "impossible"',
          '- You CANNOT output GOAL_COMPLETE with partial results',
          '- You MUST try at least 3 fundamentally different approaches',
          '- If truly stuck after exhausting ALL approaches, use ESCALATE: <what you tried>',
          '',
          'Try a COMPLETELY DIFFERENT approach. What you tried before did not work — think laterally.',
          'Continue working on the original task.',
        ].join('\n');

        const retryResult = await runClaudeOnce(
          cwd,
          retryPrompt,
          false,
          {
            model: opts.model,
            useSubAgents: opts.useSubAgents,
            goalId: opts.goalId,
            project: projectName,
            prompt: retryPrompt.slice(0, 500),
          }
        );

        // Accumulate retry cost/tokens
        totalCostUsd += retryResult.costUsd;
        totalInputTokens += retryResult.inputTokens;
        totalOutputTokens += retryResult.outputTokens;
        totalCacheReadTokens += retryResult.cacheReadTokens;
        totalCacheCreationTokens += retryResult.cacheCreationTokens;
        if (retryResult.jsonParseFailed) anyJsonParseFailed = true;

        fullOutput += retryResult.output;
        opts.onProgress?.(retryResult.output);

        if (retryResult.output.includes(GOAL_COMPLETE_SIGNAL)) {
          const stillSurrendering = SURRENDER_PATTERNS.find(p => p.test(retryResult.output));
          if (!stillSurrendering) {
            goalComplete = true;
          } else {
            console.log(`[TaskRunner] Agent still surrendering after retry. Will ESCALATE.`);
            blocked = true;
            blockedReason = `Agent unable to complete — surrendered twice. Last attempt matched: "${stillSurrendering}"`;
          }
        }
      } else {
        goalComplete = true;
      }
    }

    if (result.output.includes(BLOCKED_SIGNAL)) {
      blocked = true;
      const match = result.output.match(/BLOCKED:\s*(.+?)(?:\n|$)/);
      blockedReason = match?.[1] || 'Unknown blocker';
    }

    // Also detect surrender without GOAL_COMPLETE (agent just giving up mid-stream)
    if (!goalComplete && !blocked) {
      const midStreamSurrender = SURRENDER_PATTERNS.find(p => p.test(result.output));
      if (midStreamSurrender && !result.output.includes('ESCALATE:')) {
        console.log(`[TaskRunner] Mid-stream surrender detected in iteration ${iterations}: "${midStreamSurrender}". Nudging agent.`);
      }
    }

    // Extract assumptions
    const assumptionMatches = result.output.matchAll(/ASSUMPTION:\s*(.+?)(?:\n|$)/g);
    for (const match of assumptionMatches) {
      assumptions.push(match[1]);
    }

    // Extract screenshot paths
    const screenshotMatches = result.output.matchAll(/SCREENSHOT:\s*(.+?)(?:\n|$)/g);
    for (const match of screenshotMatches) {
      screenshots.push(match[1].trim());
    }

    // If not autonomous mode, only run once
    if (!opts.autonomous) {
      break;
    }

    // Small delay between iterations
    if (!goalComplete && !blocked) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  } // end CLI mode else block

  const durationMs = Date.now() - startTime;

  // Check for completion artifact file (more reliable than stdout parsing)
  const artifactPath = join(cwd, '.dreamteam', 'complete.json');
  let completionArtifact: { status?: string; summary?: string; filesModified?: string[]; testsRun?: string; verified?: string; reason?: string } | null = null;
  try {
    if (existsSync(artifactPath)) {
      completionArtifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      console.log(`[TaskRunner] Found completion artifact: status=${completionArtifact?.status}`);

      if (completionArtifact?.status === 'complete' && !goalComplete && !blocked) {
        // Artifact says complete but stdout didn't have GOAL_COMPLETE — trust the artifact
        // But never override if we already detected a block (e.g. rate limit)
        console.log(`[TaskRunner] Artifact confirms completion (stdout signal was missing)`);
        goalComplete = true;
      } else if (completionArtifact?.status === 'blocked' && !blocked) {
        blocked = true;
        blockedReason = completionArtifact.reason || 'Blocked (from artifact)';
      }

      // Clean up artifact file
      try { unlinkSync(artifactPath); } catch { /* ignore */ }
    }
  } catch (e) {
    console.log(`[TaskRunner] Could not read completion artifact: ${e}`);
  }

  // Parse self-assessment and escalations
  try {
    parseAssessment(fullOutput, goalId, projectName);
    parseEscalation(fullOutput, goalId, projectName);
  } catch (e) {
    console.error('Error parsing assessment/escalation:', e);
  }

  // Parse sub-task decomposition
  const subtasks = parseDecomposition(fullOutput);

  // Determine exit signal
  let exitSignal: string | undefined;
  if (goalComplete) exitSignal = 'GOAL_COMPLETE';
  else if (blocked) exitSignal = 'BLOCKED';
  else if (fullOutput.includes('ESCALATE:')) exitSignal = 'ESCALATE';
  else if (durationMs >= CLAUDE_TIMEOUT_MS) exitSignal = 'TIMEOUT';

  // Collect hook outputs
  const hookOutputs = collectHookOutputs(goalId);

  // Generate auto-tags
  const tags = generateAutoTags(prompt);

  // Update agent_run with execution results
  if (runId) {
    try {
      const updateData: AgentRunUpdate = {
        endedAt: new Date().toISOString(),
        durationMs,
        exitCode: goalComplete ? 0 : (blocked ? 1 : 2),
        iterationCount: iterations,
        costUsd: totalCostUsd,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        exitSignal,
        outputText: fullOutput.slice(-50000), // last 50k chars
        subtaskDescriptions: subtasks,
        commandsRun: hookOutputs.commandsRun,
        screenshots: screenshots.length > 0 ? screenshots : undefined,
        tags,
        jsonParseFailed: anyJsonParseFailed,
      };
      updateAgentRun(runId, updateData);
      console.log(`[TaskRunner] Updated agent_run ${runId}: ${exitSignal || 'NO_SIGNAL'}, $${totalCostUsd.toFixed(4)}, ${iterations} iterations`);
    } catch (e) {
      console.error('[TaskRunner] Failed to update agent_run:', e);
    }
  }

  return {
    success: goalComplete || (!blocked && iterations > 0),
    output: fullOutput,
    goalComplete,
    blocked,
    blockedReason,
    iterations,
    assumptions,
    surrenderDetected,
    surrenderPattern,
    costUsd: totalCostUsd,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    durationMs,
    jsonParseFailed: anyJsonParseFailed,
    subtasks,
    screenshots: screenshots.length > 0 ? screenshots : undefined,
    runId,
    completionArtifact: completionArtifact && completionArtifact.status === 'complete' ? {
      status: completionArtifact.status,
      summary: completionArtifact.summary,
      filesModified: completionArtifact.filesModified,
      testsRun: completionArtifact.testsRun,
      verified: completionArtifact.verified,
    } : undefined,
  };
}

function buildEnhancedPrompt(basePrompt: string, autonomous: boolean, _useSubAgents: boolean = true): string {
  if (!autonomous) return `## Task\n\n${basePrompt}`;

  return `## Autonomous Agent

You are working autonomously. Rules:
- Make progress. If blocked by a minor issue, make a reasonable assumption (log with ASSUMPTION: <what>) and continue.
- Stay in scope. ONLY do what the goal asks. Note anything else under NEXT in your debrief.
- Test your work before declaring complete.
- Commit your work with descriptive messages.
- If genuinely blocked (missing credentials, service down), output BLOCKED: <reason>.
- If stuck after trying 3 different approaches, output ESCALATE: <what you tried>.

## Completion Protocol

When your work is done and committed, create a completion artifact file at \`.dreamteam/complete.json\` with this structure:
\`\`\`json
{
  "status": "complete",
  "summary": "Brief description of what was done",
  "filesModified": ["list", "of", "files"],
  "testsRun": "description of tests performed",
  "verified": "what you checked before marking complete"
}
\`\`\`
Then output GOAL_COMPLETE as usual. If blocked, write \`{"status": "blocked", "reason": "..."}\` instead.

## Task

${basePrompt}`;
}

/** Timeout per iteration — complex goals get 20 min, routine goals get 10 min */
const CLAUDE_TIMEOUT_MS_ROUTINE = 10 * 60 * 1000;
const CLAUDE_TIMEOUT_MS_COMPLEX = 20 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = CLAUDE_TIMEOUT_MS_ROUTINE; // default, overridden per-goal below

/** Parsed result from a single Claude CLI invocation */
export interface ClaudeRunResult {
  /** Text content (extracted from JSON result or raw output on fallback) */
  output: string;
  exitCode: number;
  /** Cost in USD from Claude CLI JSON output */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** True if JSON parse failed and we fell back to text mode */
  jsonParseFailed: boolean;
  /** True if the process was killed due to timeout */
  timedOut: boolean;
}

interface ClaudeRunOptions {
  model?: ModelTier;
  useSubAgents?: boolean;
  goalId?: string;
  project?: string;
  prompt?: string;
  /** MCP tools to explicitly enable (passed as --allowedTools) */
  allowedTools?: string[];
  /** Per-iteration timeout in ms (default: 10 min routine, 20 min complex) */
  timeoutMs?: number;
}

async function runClaudeOnce(
  cwd: string,
  prompt?: string,
  continueMode: boolean = false,
  options: ClaudeRunOptions = {}
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    // Add model selection for cost optimization
    if (options.model) {
      args.push('--model', resolveModelName(options.model));
    }

    // Set timeout to kill hung processes
    let timeoutHandle: NodeJS.Timeout | null = null;

    if (continueMode) {
      args.push('--continue');
    }

    // Add archetype-specific allowed tools
    if (options.allowedTools && options.allowedTools.length > 0) {
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    // Use full path to claude to ensure it's found in all environments
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    console.log(`[TaskRunner] Spawning ${claudePath} in ${cwd} with args:`, args);

    const childProc = spawn(claudePath, args, {
      cwd,
      shell: false,  // Don't use shell since we have full path
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude({
        // Hook env vars — hooks check for DREAMTEAM_GOAL_ID to activate
        ...(options.goalId ? { DREAMTEAM_GOAL_ID: options.goalId } : {}),
        ...(options.project ? { DREAMTEAM_PROJECT: options.project } : {}),
      }),
    });

    // CRITICAL: Track the spawned process for orphan recovery
    // This allows the orchestrator to recover processes if it crashes/restarts
    if (options.goalId && options.project && childProc.pid) {
      const logFile = `/tmp/${options.project}-auto.log`;
      trackProcess(childProc.pid, options.goalId, options.project, options.prompt || '', logFile);
    }

    // Write prompt to stdin instead of passing as argument (more reliable for long prompts)
    // CRITICAL: --continue with --print REQUIRES stdin input, or Claude exits immediately
    if (prompt) {
      childProc.stdin?.write(prompt);
      childProc.stdin?.end();
    } else if (continueMode) {
      // Must send a continuation prompt for --continue + --print to work
      childProc.stdin?.write('Continue working on the task. If complete, output GOAL_COMPLETE. If blocked, output BLOCKED: <reason>.');
      childProc.stdin?.end();
    } else {
      childProc.stdin?.end();
    }

    let output = '';
    let resolved = false;
    let timedOut = false;

    // Handle spawn errors
    childProc.on('error', (err) => {
      console.error(`[TaskRunner] Spawn error:`, err);
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        output: `[SPAWN ERROR: ${err.message}]`,
        exitCode: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        jsonParseFailed: true,
        timedOut: false,
      });
    });

    // Timeout handler — use per-goal timeout if provided, else default
    const iterationTimeout = options.timeoutMs || CLAUDE_TIMEOUT_MS;
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        console.log(`[TaskRunner] Timeout after ${iterationTimeout / 1000}s, killing process`);
        output += '\n[TIMEOUT: Claude process killed after timeout]\n';
        timedOut = true;
        childProc.kill('SIGKILL');
      }
    }, iterationTimeout);

    // Write output to project log file for health monitoring
    const logFile = options.project ? `/tmp/${options.project}-agent.log` : null;

    childProc.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Also write to log file so health monitor can track output
      if (logFile) {
        try { appendFileSync(logFile, text); } catch { /* ignore */ }
      }
    });

    childProc.stderr?.on('data', (data) => {
      const text = `[stderr] ${data.toString()}`;
      output += text;
      if (logFile) {
        try { appendFileSync(logFile, text); } catch { /* ignore */ }
      }
    });

    childProc.on('exit', (code) => {
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Untrack the process now that it's done
      if (options.goalId) {
        untrackProcess(options.goalId);
      }

      console.log(`[TaskRunner] Claude exited with code ${code}, output length: ${output.length}, timedOut: ${timedOut}`);

      // Parse JSON output with fallback to text mode
      const result = parseClaudeJsonOutput(output, code || 0);
      result.timedOut = timedOut;
      resolve(result);
    });

    // stdin is already closed above after writing prompt/continuation message
  });
}

/**
 * Run Claude via the Agent SDK. Uses query() with maxTurns and maxBudgetUsd.
 * The SDK manages continuation internally — no need for --continue + stdin injection.
 * Timeout via AbortController (clean cancellation instead of SIGKILL).
 *
 * Returns the same ClaudeRunResult shape for drop-in compatibility.
 */
interface SDKRunOptions {
  model?: ModelTier;
  goalId?: string;
  project?: string;
  maxTurns?: number;
  onProgress?: (output: string) => void;
}

async function runClaudeViaSDK(
  cwd: string,
  prompt: string,
  options: SDKRunOptions = {}
): Promise<ClaudeRunResult> {
  // Dynamic import to avoid loading SDK when not in use
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    console.log(`[TaskRunner/SDK] Timeout after ${CLAUDE_TIMEOUT_MS / 1000}s, aborting`);
    abortController.abort();
  }, CLAUDE_TIMEOUT_MS);

  const logFile = options.project ? `/tmp/${options.project}-agent.log` : null;

  let textOutput = '';
  let sessionId: string | null = null;
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let timedOut = false;
  let exitCode = 0;

  try {
    const sdkEnv: Record<string, string | undefined> = {
      ...process.env,
    };
    // Remove CLAUDECODE to avoid nested session detection
    delete sdkEnv.CLAUDECODE;
    // Add DreamTeam env vars for hooks
    if (options.goalId) sdkEnv.DREAMTEAM_GOAL_ID = options.goalId;
    if (options.project) sdkEnv.DREAMTEAM_PROJECT = options.project;

    const q = query({
      prompt,
      options: {
        cwd,
        model: options.model ? resolveModelName(options.model) : undefined,
        maxTurns: options.maxTurns || 300,
        maxBudgetUsd: 3,
        abortController,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        env: sdkEnv,
      },
    });

    for await (const message of q) {
      // Capture session_id from any message
      if ('session_id' in message && message.session_id) {
        sessionId = message.session_id as string;
      }

      // Extract text from assistant messages
      if (message.type === 'assistant' && 'message' in message) {
        const msg = message.message as { content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              textOutput += block.text + '\n';
              options.onProgress?.(block.text);
              if (logFile) {
                try { appendFileSync(logFile, block.text + '\n'); } catch { /* ignore */ }
              }
            }
          }
        }
      }

      // Extract cost/usage from result messages
      if (message.type === 'result') {
        const result = message as {
          type: 'result';
          subtype: string;
          result?: string;
          total_cost_usd?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          is_error?: boolean;
          session_id?: string;
        };

        totalCostUsd = result.total_cost_usd ?? 0;
        inputTokens = result.usage?.input_tokens ?? 0;
        outputTokens = result.usage?.output_tokens ?? 0;
        cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
        cacheCreationTokens = result.usage?.cache_creation_input_tokens ?? 0;

        // The result.result field contains the final text output
        if (result.result && !textOutput.includes(result.result)) {
          textOutput += result.result;
        }

        if (result.is_error) {
          exitCode = 1;
        }

        if (result.session_id) {
          sessionId = result.session_id;
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
      timedOut = true;
      textOutput += '\n[TIMEOUT: SDK query aborted after timeout]\n';
      console.log(`[TaskRunner/SDK] Aborted (timeout)`);
    } else {
      console.error(`[TaskRunner/SDK] Error:`, err);
      textOutput += `\n[SDK ERROR: ${(err as Error).message}]\n`;
      exitCode = 1;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  console.log(`[TaskRunner/SDK] Completed: ${textOutput.length} bytes, $${totalCostUsd.toFixed(4)}, session=${sessionId?.slice(0, 8) || 'none'}, timedOut=${timedOut}`);

  return {
    output: textOutput,
    exitCode,
    costUsd: totalCostUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    jsonParseFailed: false,
    timedOut,
  };
}

/**
 * Parse Claude CLI JSON output with fallback to text mode.
 * See plan section 1f for the full fallback mechanism.
 */
function parseClaudeJsonOutput(rawOutput: string, exitCode: number): ClaudeRunResult {
  try {
    const parsed = JSON.parse(rawOutput);

    // Extract text content from the JSON result
    const text = typeof parsed.result === 'string'
      ? parsed.result
      : rawOutput; // fallback if structure unexpected

    return {
      output: text,
      exitCode,
      costUsd: parsed.total_cost_usd ?? 0,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      jsonParseFailed: false,
      timedOut: false,
    };
  } catch {
    // JSON parse failed — degrade gracefully to text mode
    console.warn(`[TaskRunner] JSON parse failed (${rawOutput.length} bytes), falling back to text mode`);

    return {
      output: rawOutput,
      exitCode,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      jsonParseFailed: true,
      timedOut: false,
    };
  }
}


/**
 * Parse DECOMPOSITION blocks from agent output.
 * Format:
 *   DECOMPOSITION:
 *   - step1: "description" [acceptance criteria]
 *   - step2: "description" [acceptance criteria]
 *   END_DECOMPOSITION
 */
function parseDecomposition(output: string): Array<{ step: string; description: string; criteria?: string }> | undefined {
  const match = output.match(/DECOMPOSITION:\s*\n([\s\S]*?)END_DECOMPOSITION/);
  if (!match) return undefined;

  const lines = match[1].split('\n').filter(l => l.trim().startsWith('-'));
  const subtasks: Array<{ step: string; description: string; criteria?: string }> = [];

  for (const line of lines) {
    const parsed = line.match(/^-\s*(\w+):\s*"?([^"[\]]+)"?\s*(?:\[(.+?)\])?/);
    if (parsed) {
      subtasks.push({
        step: parsed[1],
        description: parsed[2].trim(),
        criteria: parsed[3]?.trim(),
      });
    }
  }

  return subtasks.length > 0 ? subtasks : undefined;
}

/**
 * Collect hook output files from /tmp and clean up.
 */
function collectHookOutputs(goalId: string): {
  commandsRun?: Array<{ cmd: string; exitCode: number; durationMs?: number }>;
  scopeFlags?: Array<{ path: string; reason: string }>;
} {
  const result: ReturnType<typeof collectHookOutputs> = {};

  // Read command log from post-command hook
  const cmdLogPath = `/tmp/dreamteam-cmds-${goalId}.jsonl`;
  if (existsSync(cmdLogPath)) {
    try {
      const lines = readFileSync(cmdLogPath, 'utf-8').split('\n').filter(Boolean);
      result.commandsRun = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      unlinkSync(cmdLogPath);
    } catch { /* ignore */ }
  }

  // Read scope flags from file-change hook
  const scopeFlagPath = `/tmp/dreamteam-scope-flags-${goalId}.jsonl`;
  if (existsSync(scopeFlagPath)) {
    try {
      const lines = readFileSync(scopeFlagPath, 'utf-8').split('\n').filter(Boolean);
      result.scopeFlags = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      unlinkSync(scopeFlagPath);
    } catch { /* ignore */ }
  }

  // Clean up test failure flag
  const testFlagPath = `/tmp/dreamteam-test-fail-${goalId}.flag`;
  if (existsSync(testFlagPath)) {
    try { unlinkSync(testFlagPath); } catch { /* ignore */ }
  }

  return result;
}

/**
 * Run a single CLI invocation using a pluggable backend (Claude, Codex, etc.).
 *
 * This is the backend-agnostic equivalent of runClaudeOnce().
 * For Claude, it delegates to the existing runClaudeOnce().
 * For other backends, it uses the CliBackend interface.
 */
export async function runCliOnce(
  cwd: string,
  prompt: string | undefined,
  continueMode: boolean,
  backendName: string,
  options: ClaudeRunOptions & { modelTier?: ModelTier } = {},
): Promise<ClaudeRunResult> {
  // For Claude, use the existing optimized code path
  if (backendName === 'claude') {
    return runClaudeOnce(cwd, prompt, continueMode, options);
  }

  // Load backend dynamically
  let backend: CliBackend;
  try {
    // Import backend modules to trigger self-registration
    if (backendName === 'codex') {
      await import('../orchestration/backends/codex-backend.js');
    }
    const { getBackend } = await import('../orchestration/cli-backend.js');
    backend = getBackend(backendName);
  } catch (err) {
    console.error(`[TaskRunner] Failed to load backend "${backendName}":`, err);
    // Fall back to Claude
    return runClaudeOnce(cwd, prompt, continueMode, options);
  }

  return new Promise((resolve) => {
    const modelName = options.modelTier
      ? resolveBackendModel(backendName, options.modelTier)
      : '';

    const invocationOpts: CliInvocationOptions = {
      model: modelName,
      cwd,
      prompt,
      continueMode,
      goalId: options.goalId,
      project: options.project,
      allowedTools: options.allowedTools,
    };

    const args = continueMode && backend.supportsContinuation && backend.buildContinuationArgs
      ? backend.buildContinuationArgs(invocationOpts)
      : backend.buildArgs(invocationOpts);

    const binaryPath = backend.resolveBinaryPath();
    const env = backend.buildEnv({
      ...(options.goalId ? { DREAMTEAM_GOAL_ID: options.goalId } : {}),
      ...(options.project ? { DREAMTEAM_PROJECT: options.project } : {}),
    });

    console.log(`[TaskRunner] Spawning ${backendName}: ${binaryPath} ${args.join(' ')} in ${cwd}`);

    const childProc = spawn(binaryPath, args, {
      cwd: backendName === 'codex' ? undefined : cwd, // Codex uses -C flag
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });

    if (options.goalId && options.project && childProc.pid) {
      const logFile = `/tmp/${options.project}-auto.log`;
      trackProcess(childProc.pid, options.goalId, options.project, options.prompt || '', logFile);
    }

    // Write prompt to stdin
    if (prompt) {
      childProc.stdin?.write(prompt);
      childProc.stdin?.end();
    } else if (continueMode) {
      childProc.stdin?.write('Continue working on the task. If complete, output GOAL_COMPLETE. If blocked, output BLOCKED: <reason>.');
      childProc.stdin?.end();
    } else {
      childProc.stdin?.end();
    }

    let output = '';
    let resolved = false;
    let timedOut = false;

    childProc.on('error', (err) => {
      console.error(`[TaskRunner/${backendName}] Spawn error:`, err);
      resolved = true;
      resolve({
        output: `[SPAWN ERROR: ${err.message}]`,
        exitCode: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        jsonParseFailed: true,
        timedOut: false,
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        console.log(`[TaskRunner/${backendName}] Timeout after ${CLAUDE_TIMEOUT_MS / 1000}s`);
        output += '\n[TIMEOUT: Process killed after timeout]\n';
        timedOut = true;
        childProc.kill('SIGKILL');
      }
    }, CLAUDE_TIMEOUT_MS);

    const logFile = options.project ? `/tmp/${options.project}-agent.log` : null;

    childProc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (logFile) {
        try { appendFileSync(logFile, text); } catch { /* ignore */ }
      }
    });

    childProc.stderr?.on('data', (data: Buffer) => {
      const text = `[stderr] ${data.toString()}`;
      output += text;
      if (logFile) {
        try { appendFileSync(logFile, text); } catch { /* ignore */ }
      }
    });

    childProc.on('exit', (code) => {
      resolved = true;
      clearTimeout(timeoutHandle);

      if (options.goalId) {
        untrackProcess(options.goalId);
      }

      console.log(`[TaskRunner/${backendName}] Exited with code ${code}, output: ${output.length} bytes`);

      const parsed = backend.parseOutput(output, code || 0);
      resolve({
        output: parsed.text,
        exitCode: code || 0,
        costUsd: parsed.costUsd,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        jsonParseFailed: parsed.jsonParseFailed,
        timedOut,
      });
    });
  });
}

export async function runQuickCommand(
  projectName: string,
  command: string
): Promise<string> {
  const project = getProject(projectName);

  return new Promise((resolve) => {
    const childProc = spawn('claude', [
      '--print',
      '--dangerously-skip-permissions',
      command,
    ], {
      cwd: project.path,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude(),
    });

    let output = '';

    childProc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    childProc.stderr?.on('data', (data) => {
      output += data.toString();
    });

    childProc.on('exit', () => {
      resolve(output);
    });
  });
}
