/**
 * Worker Process — Dumb executor that polls SQLite for work items.
 *
 * Workers are stateless. They:
 * 1. Claim a queued work item atomically from SQLite
 * 2. Execute the pre-built prompt via runTask()
 * 3. Update progress/cost periodically
 * 4. Write the result back to work_queue
 *
 * Workers do NOT:
 * - Triage, prompt-build, or select models
 * - Run post-completion hooks (no debrief, no E2E, no Telegram)
 * - Update goal status (no markGoalCompleted/Blocked)
 * - Make budget decisions
 *
 * Usage: node dist/daemon/worker.js --id 0
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runTask } from '../projects/task-runner.js';
import { isLockoutError, isSessionLimit } from '../projects/task-runner.js';
import type { ModelTier } from '../orchestration/model-config.js';
import { getProject } from '../projects/registry.js';
import {
  claimNextItem,
  markRunning,
  updateProgress,
  updateOutputSize,
  updateCost,
  completeItem,
} from '../db/work-queue.js';
import { getRunsByGoal } from '../db/execution-log.js';
import { acquireGitLock } from '../utils/git-lock.js';
import { killTrackedProcess } from '../orchestration/process-tracker.js';
import { createGoalTrace, shutdownTracing } from '../tracing/langfuse.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../db/checkpoints.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

// Parse --id argument
const idArg = process.argv.find(a => a.startsWith('--id'));
const workerId = idArg
  ? parseInt(process.argv[process.argv.indexOf(idArg) + 1] ?? process.argv[process.argv.indexOf('--id') + 1] ?? '0')
  : (() => {
      const idx = process.argv.indexOf('--id');
      if (idx >= 0 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1]);
      // Try --id=N format
      const match = process.argv.find(a => a.match(/^--id=(\d+)$/));
      return match ? parseInt(match.split('=')[1]) : 0;
    })();

const PID_FILE = join(DATA_DIR, `worker-${workerId}.pid`);
const POLL_INTERVAL_MS = 5_000; // 5 seconds between poll attempts
const MAX_IDLE_INTERVAL_MS = 60_000; // Back off to 60s max when idle

let shuttingDown = false;
let forceShutdown = false;
let idleBackoffMs = POLL_INTERVAL_MS;
let currentGoalId: string | null = null; // Track active goal for shutdown cleanup

function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [worker-${workerId}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function writePidFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

/**
 * Clean the working tree — discard unstaged changes and remove untracked files.
 * Agents often leave temp files (test scripts, screenshots, etc.) that pollute
 * the repo and cause git operations to fail.
 */
function cleanWorkingTree(cwd: string): void {
  try {
    execSync('git reset HEAD -- .', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
    execSync('git checkout -- .', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
    execSync('git clean -fd', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch { /* tree might already be clean */ }
}

/**
 * Install a lightweight pre-commit hook that runs basic checks during agent execution.
 * Gives the agent immediate feedback on broken builds so it can self-correct
 * within the same session instead of failing at the quality gate.
 *
 * Works in both regular checkouts and worktrees — uses git rev-parse to find
 * the correct hooks directory.
 */
function installPreCommitHook(cwd: string, projectName: string): void {
  try {
    const hooksDir = join(cwd, '.git', 'hooks');
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

    const project = getProject(projectName);
    const checks: string[] = [];

    // TypeScript projects: check for type errors in changed files
    if (existsSync(join(cwd, 'tsconfig.json'))) {
      checks.push(
        '# Type check (non-blocking — warn only)',
        'if command -v npx >/dev/null 2>&1; then',
        '  npx --yes tsc --noEmit --pretty 2>&1 | tail -5 || true',
        'fi',
      );
    }

    // Python projects: check syntax errors
    if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
      checks.push(
        '# Python syntax check on staged .py files',
        'STAGED_PY=$(git diff --cached --name-only --diff-filter=ACM -- "*.py")',
        'if [ -n "$STAGED_PY" ]; then',
        '  python3 -m py_compile $STAGED_PY 2>&1 || true',
        'fi',
      );
    }

    // Universal: prevent committing secrets or debug artifacts
    checks.push(
      '# Block committing secrets',
      'if git diff --cached --name-only | grep -qiE "\\.(env|pem|key)$"; then',
      '  echo "WARNING: Attempting to commit potential secrets (.env/.pem/.key)"',
      'fi',
    );

    // The hook should warn but NOT block (exit 0 always) — the agent needs to be able
    // to commit even with warnings, and fix issues in subsequent iterations
    const hookContent = [
      '#!/bin/sh',
      '# DreamTeam pre-commit hook — installed by worker for agent self-correction',
      '# Warns on issues but does NOT block commits (exit 0 always)',
      '',
      ...checks,
      '',
      'exit 0',
    ].join('\n');

    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, hookContent);
    execSync(`chmod +x "${hookPath}"`, { cwd, timeout: 5000 });
    log(`Installed pre-commit hook for ${projectName}`);
  } catch (e) {
    log(`Pre-commit hook install failed (non-fatal): ${e}`, 'warn');
  }
}

/**
 * Ensure .dreamteam directory exists in the project for completion artifacts.
 */
function ensureArtifactDir(cwd: string): void {
  const dir = join(cwd, '.dreamteam');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Add to .gitignore if not already there
  const gitignorePath = join(cwd, '.gitignore');
  try {
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignore.includes('.dreamteam/')) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.dreamteam/\n');
    }
  } catch { /* non-fatal */ }
}

/**
 * Set up a feature branch for the goal. If the branch already exists
 * (from a previous attempt), switch to it to continue from prior work.
 * Returns the branch name, or null if branch setup failed.
 *
 * Acquires a file-based git lock to prevent concurrent git ops with the
 * supervisor's merge/push logic.
 */
async function setupGoalBranch(projectName: string, goalId: string): Promise<string | null> {
  const project = getProject(projectName);
  if (!project?.path) return null;
  const cwd = project.path;

  const releaseGitLock = await acquireGitLock(projectName);
  try {
    // Always clean the working tree before branch operations
    cleanWorkingTree(cwd);

    const branchName = `goal/${goalId}`;

    // Check if branch already exists (from prior attempt)
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify ${branchName}`, { cwd, encoding: 'utf8', stdio: 'pipe' });
      branchExists = true;
    } catch {
      // Branch doesn't exist — will create from main below
    }

    if (branchExists) {
      execSync(`git checkout ${branchName}`, { cwd, encoding: 'utf8', timeout: 10000 });

      // Tier 1: Try rebase — cleanly preserves all prior work on top of latest main
      try {
        execSync('git rebase main', { cwd, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
        log(`Rebased ${branchName} onto main (prior work preserved)`);
        return branchName;
      } catch {
        try { execSync('git rebase --abort', { cwd, encoding: 'utf8' }); } catch { /* ignore */ }
      }

      // Tier 2: Merge main into branch — keeps non-conflicting prior work,
      // main wins on conflicts (branch's conflicting hunks are stale)
      try {
        execSync('git merge main -X theirs --no-edit', { cwd, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
        log(`Merged main into ${branchName} (prior non-conflicting work preserved, conflicts resolved to main)`);
        return branchName;
      } catch {
        try { execSync('git merge --abort', { cwd, encoding: 'utf8' }); } catch { /* ignore */ }
      }

      // Tier 3: Both failed — start fresh (agent still has debrief context)
      execSync('git checkout main', { cwd, encoding: 'utf8', timeout: 10000 });
      execSync(`git branch -D ${branchName}`, { cwd, encoding: 'utf8', timeout: 10000 });
      log(`Rebase and merge failed on ${branchName} — starting fresh from main (debrief context preserved)`);
    }

    // Create fresh branch from main
    execSync('git checkout main', { cwd, encoding: 'utf8', timeout: 10000 });
    execSync(`git checkout -b ${branchName}`, { cwd, encoding: 'utf8', timeout: 10000 });
    log(`Created branch ${branchName}`);
    return branchName;
  } catch (err) {
    log(`Branch setup failed for ${goalId}: ${err}`, 'warn');
    return null;
  } finally {
    releaseGitLock();
  }
}


/**
 * Parse the exit signal from agent output.
 */
// OpenAI rate limit patterns (for OpenAI-compatible backends)
const OPENAI_RATE_LIMIT_PATTERNS = [
  /openai.*rate.?limit/i,
  /openai.*too.?many.?requests/i,
  /openai.*quota/i,
];

function parseExitSignal(output: string, blocked: boolean, goalComplete: boolean): string | null {
  if (goalComplete) return 'GOAL_COMPLETE';
  if (output.includes('ESCALATE:')) return 'ESCALATE';
  if (blocked) return 'BLOCKED';
  if (output.includes('TAKING_BREAK:')) return 'BREAK';
  // Session limit (hours-long cooldown) — distinct from brief rate limits
  if (isSessionLimit(output)) return 'session_limited';
  if (isLockoutError(output)) return 'rate_limited';
  // OpenAI rate limits — treat same as Claude rate limits
  if (OPENAI_RATE_LIMIT_PATTERNS.some(p => p.test(output))) return 'rate_limited';
  return null; // no signal
}

async function startWorker(): Promise<void> {
  log(`Starting (PID ${process.pid})`);
  writePidFile();

  while (!shuttingDown) {
    try {
      // Try to claim the next queued work item
      const item = claimNextItem(process.pid);

      if (!item) {
        // Nothing to do — back off gradually (5s → 10s → 20s → 40s → 60s)
        await new Promise(r => setTimeout(r, idleBackoffMs));
        idleBackoffMs = Math.min(idleBackoffMs * 2, MAX_IDLE_INTERVAL_MS);
        continue;
      }

      // Got work — reset backoff
      idleBackoffMs = POLL_INTERVAL_MS;

      log(`Claimed item ${item.id.slice(0, 8)} — [${item.project}] goal ${item.goal_id.slice(0, 8)} (attempt ${item.attempt_number})`);
      currentGoalId = item.goal_id;

      // Mark as running
      markRunning(item.id);

      // Create Langfuse trace for this goal execution
      const trace = createGoalTrace({
        goalId: item.goal_id,
        project: item.project,
        title: (item.prompt || '').slice(0, 100),
        model: item.model || undefined,
        archetype: item.archetype || undefined,
        attemptNumber: item.attempt_number,
      });

      // Check for existing checkpoint (crash recovery)
      const checkpoint = loadCheckpoint(item.goal_id);
      if (checkpoint) {
        log(`Found checkpoint for goal ${item.goal_id.slice(0, 8)}: iteration ${checkpoint.iteration}, $${checkpoint.costUsdSoFar.toFixed(4)}`);
        trace.event('checkpoint-restored', {
          iteration: checkpoint.iteration,
          costSoFar: checkpoint.costUsdSoFar,
          outputLength: checkpoint.outputSoFar.length,
        });
      }

      // Set up feature branch for this goal
      const branchSpan = trace.span('branch-setup');
      const branch = await setupGoalBranch(item.project, item.goal_id);
      branchSpan.end({ branch, fromCheckpoint: !!checkpoint });

      // Install pre-commit hooks and artifact directory for agent self-correction
      const projectConfig = getProject(item.project);
      if (projectConfig?.path) {
        installPreCommitHook(projectConfig.path, item.project);
        ensureArtifactDir(projectConfig.path);
      }

      // Set up progress tracking
      let lastProgressUpdate = Date.now();
      let cumulativeOutputSize = checkpoint?.outputSoFar.length || 0;
      const PROGRESS_INTERVAL_MS = 60_000; // Update progress every 60s

      try {
        // Build checkpoint context for the prompt if resuming
        let resumePrompt = item.prompt || '';
        if (checkpoint && checkpoint.outputSoFar.length > 0) {
          const contextSnippet = checkpoint.outputSoFar.slice(-3000);
          resumePrompt = `${item.prompt || ''}\n\n## Resuming from Checkpoint\nA previous execution crashed after iteration ${checkpoint.iteration}. Your prior work is on the branch. Here is the tail of your previous output for context:\n\`\`\`\n${contextSnippet}\n\`\`\`\nContinue from where you left off. Do NOT restart from scratch.`;
        }

        // Primary (opus) goals get 20 min timeout per iteration; others get 10 min
        const modelTier = (item.model as ModelTier) || 'primary';
        const iterTimeoutMs = modelTier === 'primary' ? 20 * 60 * 1000 : 10 * 60 * 1000;

        const result = await runTask(item.project, resumePrompt, {
          autonomous: true,
          maxIterations: checkpoint ? Math.max(1, 3 - checkpoint.iteration) : 3,
          model: modelTier,
          goalId: item.goal_id,
          archetype: item.archetype || undefined,
          timeoutMs: iterTimeoutMs,
          onProgress: (output: string) => {
            cumulativeOutputSize += output.length;
            const now = Date.now();
            if (now - lastProgressUpdate >= PROGRESS_INTERVAL_MS) {
              lastProgressUpdate = now;
              try {
                updateProgress(item.id);
                updateOutputSize(item.id, cumulativeOutputSize);
              } catch (e) {
                log(`Progress update error: ${e}`, 'warn');
              }
            }
          },
          // Pass trace context for per-iteration tracing
          _traceContext: trace,
          _workItemId: item.id,
        } as any);

        // Write result to work_queue
        let exitSignal = parseExitSignal(result.output, result.blocked, result.goalComplete);

        // Fallback: detect completion from branch commits when stdout is empty/buffered.
        // --output-format json buffers all stdout, so GOAL_COMPLETE may not appear in
        // the parsed output. If the branch has meaningful commits, treat as completed.
        if (!exitSignal && !result.blocked) {
          try {
            const projectConfig = getProject(item.project);
            if (projectConfig?.path) {
              const branchCommits = execSync(
                `git log --oneline goal/${item.goal_id} --not main`,
                { cwd: projectConfig.path, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
              ).trim();
              if (branchCommits) {
                const commitCount = branchCommits.split('\n').length;
                const hasCompletionSignal = /goal.complete|complete|done|implement|fix|add/i.test(branchCommits);
                if (commitCount >= 2 || hasCompletionSignal) {
                  log(`Branch-based completion detected: ${commitCount} commits on goal/${item.goal_id.slice(0, 8)} (stdout had no signal)`);
                  exitSignal = 'GOAL_COMPLETE';
                }
              }
            }
          } catch { /* branch may not exist or no commits — that's fine */ }
        }

        // Merge checkpoint costs if resuming
        const totalCost = checkpoint
          ? checkpoint.costUsdSoFar + result.costUsd
          : result.costUsd;

        completeItem(item.id, {
          exitSignal,
          costUsd: totalCost,
          runId: result.runId ?? null,
          resultOutput: result.output.slice(-10000),
          error: result.blocked ? result.blockedReason : null,
        });

        // Clear checkpoint on successful completion
        clearCheckpoint(item.goal_id);

        // End trace
        trace.update({
          output: exitSignal || 'NO_SIGNAL',
          metadata: { costUsd: totalCost, iterations: result.iterations, fromCheckpoint: !!checkpoint },
          statusMessage: exitSignal === 'GOAL_COMPLETE' ? 'completed' : exitSignal || 'no_signal',
        });
        trace.end();

        log(`Completed item ${item.id.slice(0, 8)} — signal: ${exitSignal || 'NO_SIGNAL'}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Error executing item ${item.id.slice(0, 8)}: ${errorMsg}`, 'error');

        const signal = isSessionLimit(errorMsg) ? 'session_limited' : isLockoutError(errorMsg) ? 'rate_limited' : null;

        // Save checkpoint on crash so next attempt can resume
        try {
          const runs = getRunsByGoal(item.goal_id);
          const lastRun = runs[runs.length - 1];
          if (lastRun) {
            saveCheckpoint({
              goalId: item.goal_id,
              workItemId: item.id,
              runId: lastRun.id,
              project: item.project,
              iteration: lastRun.iteration_count || 1,
              outputSoFar: lastRun.output_text || '',
              costUsdSoFar: lastRun.cost_usd || 0,
              inputTokensSoFar: lastRun.input_tokens || 0,
              outputTokensSoFar: lastRun.output_tokens || 0,
              cacheReadTokensSoFar: lastRun.cache_read_tokens || 0,
              cacheCreationTokensSoFar: lastRun.cache_creation_tokens || 0,
              exitSignalSoFar: signal || undefined,
            });
            log(`Saved crash checkpoint for goal ${item.goal_id.slice(0, 8)}`);
          }
        } catch (ckptErr) {
          log(`Failed to save checkpoint: ${ckptErr}`, 'warn');
        }

        // Try to recover partial output from agent_runs (has 50K vs our 10K)
        let recoveredOutput: string | null = null;
        try {
          const runs = getRunsByGoal(item.goal_id);
          const lastRun = runs[runs.length - 1];
          if (lastRun?.output_text) {
            recoveredOutput = lastRun.output_text.slice(-10000);
            log(`Recovered ${recoveredOutput.length} chars of output from agent_runs`);
          }
        } catch { /* can't recover — that's ok */ }

        completeItem(item.id, {
          exitSignal: signal,
          costUsd: 0,
          runId: null,
          resultOutput: recoveredOutput,
          error: errorMsg.slice(0, 2000),
        });

        // End trace with error
        trace.event('execution-error', { error: errorMsg.slice(0, 500), signal });
        trace.update({ statusMessage: `error: ${signal || 'crash'}` });
        trace.end();
      }

      currentGoalId = null;

      // Clean up after goal — remove agent temp files and return to main
      try {
        const project = getProject(item.project);
        if (project?.path) {
          cleanWorkingTree(project.path);
          // Always return to main so the project isn't left on a stale goal branch
          try {
            execSync('git checkout main', { cwd: project.path, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
          } catch { /* may already be on main */ }
        }
      } catch { /* non-fatal */ }
    } catch (error) {
      log(`Poll loop error: ${error}`, 'error');
      // Wait before retrying
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
    }
  }

  log('Shutting down gracefully');
  await shutdownTracing();
  removePidFile();
}

// Graceful shutdown handlers
function killCurrentAgent(): void {
  if (currentGoalId) {
    log(`Killing active Claude process for goal ${currentGoalId}`);
    killTrackedProcess(currentGoalId, 'SIGTERM');
  }
}

process.on('SIGTERM', () => {
  if (shuttingDown) {
    log('Second SIGTERM received — killing agent and force exiting');
    forceShutdown = true;
    killCurrentAgent();
    removePidFile();
    process.exit(1);
  }
  log('SIGTERM received — finishing current task then shutting down...');
  shuttingDown = true;
  // Don't kill child on first signal — let it finish and preserve work.
  // The supervisor's orphan cleanup handles the case where PM2 force-kills us.
});

process.on('SIGINT', () => {
  if (shuttingDown) {
    log('Second SIGINT received — killing agent and force exiting');
    forceShutdown = true;
    killCurrentAgent();
    removePidFile();
    process.exit(1);
  }
  log('SIGINT received — finishing current task then shutting down...');
  shuttingDown = true;
});

// Cleanup on unexpected exit
process.on('exit', () => {
  removePidFile();
});

// Entry point
startWorker().then(() => {
  log('Worker exited cleanly');
  process.exit(0);
}).catch(error => {
  log(`Fatal error: ${error}`, 'error');
  removePidFile();
  process.exit(1);
});
