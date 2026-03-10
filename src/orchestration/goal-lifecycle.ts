/**
 * Goal lifecycle — post-completion hooks orchestrator.
 *
 * runPostCompletionHooks() is the big 15-step pipeline that runs after
 * an agent signals GOAL_COMPLETE.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { acquireGitLock } from '../utils/git-lock.js';
import {
  isLinearEnabled,
  postStructuredComment,
  setIssueLabels,
  generateRunLabels,
} from '../integrations/linear.js';
import { checkpointAfterGoal } from './checkpoint.js';
import { runCascadeRetest } from './cascade-retest.js';
import { addKnowledge } from '../director/knowledge.js';
import { getProject } from '../projects/registry.js';
import { reviewGoalCompletion, type ReviewResult } from './review-agent.js';
import { parseTestCommands, runTestCommands, formatTestCommandFailures } from './test-commands.js';
import { updateAgentRun, getAgentRun, type AgentRunUpdate } from '../db/execution-log.js';
import { classifyGoalType } from './model-router.js';
import { classifyGoalArchetype } from './archetypes.js';
import { smartMerge } from './merge-resolver.js';
import { runPostPushReactions } from './post-push-reactions.js';
import { scanBranchForSecrets, formatSecretFindings } from './secret-scanner.js';
import { isJamSourced, runBehavioralVerification } from './behavioral-verify.js';

import { getGoal, updateGoal } from './goal-crud.js';
import { validateCompletion } from './goal-validation.js';
import { recordLesson, parseDebrief, getRecentCommits } from './goal-debrief.js';
import type { StructuredDebrief } from './goal-types.js';
import { createLogger } from '../utils/logger.js';
import { createGoalTrace } from '../tracing/langfuse.js';

const log = createLogger('goal-lifecycle');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const DEBRIEFS_DIR = join(DATA_DIR, 'debriefs');

/**
 * Run all post-completion hooks after a goal finishes.
 * Called by the overnight daemon after markGoalCompleted().
 * All operations are non-blocking — failures don't propagate.
 */
export async function runPostCompletionHooks(
  goalId: string,
  agentOutput: string,
  runId?: string,
): Promise<StructuredDebrief | null> {
  const goal = getGoal(goalId);
  if (!goal) return null;

  // Create Langfuse trace for quality gate pipeline
  const trace = createGoalTrace({
    goalId,
    project: goal.project,
    title: `gates:${goal.title.slice(0, 80)}`,
    archetype: goal.archetype,
    attemptNumber: goal.attemptCount,
  });

  // Pre-gate: Flag timed-out completions but DON'T auto-reject.
  // The continuation loop often recovers from a single timed-out iteration —
  // if the agent completed via --continue after a timeout, the work is likely valid.
  // Let the normal quality gates (sanity check, review, smoke test) decide.
  if (goal.timedOut) {
    log.info(`Goal "${goal.title}" had timedOut flag — clearing and proceeding to quality gates (continuation may have recovered)`);
    updateGoal(goalId, { timedOut: false });
    recordLesson(goal, 'timeout-recovered', 'GOAL_COMPLETE after timeout — letting quality gates decide');
  }

  // 0. Validate completion — reject if agent surrendered or missed criteria
  const gate0Span = trace.span('gate-0-validation');
  const validation = validateCompletion(goal, agentOutput);
  if (!validation.valid) {
    log.info(`REJECTING completion for "${goal.title}": ${validation.reasons.join('; ')}`);
    log.info(`Keeping commits on branch — next agent will continue from here`);

    const rejectionParts = [`Validation failed: ${validation.reasons.join('; ')}`];
    if (validation.failureModeContext) {
      rejectionParts.push(validation.failureModeContext);
    }
    const rejectionReason = rejectionParts.join('\n').slice(0, 2000);
    updateGoal(goalId, {
      status: 'pending',
      completedAt: undefined,
      lastRejectionReason: rejectionReason,
      output: agentOutput.slice(-5000),
    });
    recordLesson(goal, 'sanity-check', validation.reasons.join('; '));

    gate0Span.end({ verdict: 'reject', reasons: validation.reasons });
    trace.update({ statusMessage: 'rejected:gate-0' });
    trace.end();
    return null;
  }
  gate0Span.end({ verdict: 'pass' });

  // Even when validation passes, store failure mode warnings for retry context
  // (warnings don't reject but inform the next attempt if it gets retried later)
  if (validation.failureModeContext) {
    log.info(`Failure mode warnings stored for "${goal.title}"`);
  }

  // 0.5. TEST_COMMANDS gate — goal-specific acceptance criteria
  // NOTE: By the time verification runs, the worker may have already switched to a
  // different branch for the next goal. We use a git worktree to verify against the
  // goal's actual branch, avoiding false rejections from branch race conditions.
  const project = getProject(goal.project);
  let verifyPath = project?.path || null;
  let worktreeCreated = false;

  if (project?.path) {
    try {
      const branch = `goal/${goalId}`;
      const wtPath = `/tmp/verify-${goalId}`;
      // Clean up stale worktree if it exists
      try {
        execSync(`git worktree remove ${wtPath} --force`, { cwd: project.path, timeout: 10000, stdio: 'pipe' });
      } catch (e) { log.swallow('remove-stale-worktree', e); }
      // Create worktree at the branch's HEAD commit (--detach avoids "branch already
      // checked out" errors when the worker is still on this branch or has moved on)
      execSync(`git worktree add --detach ${wtPath} ${branch}`, { cwd: project.path, timeout: 15000, stdio: 'pipe' });
      verifyPath = wtPath;
      worktreeCreated = true;
      log.info(`Created verification worktree at ${wtPath}`);
    } catch (err) {
      // Branch may not exist (e.g., no commits). Fall back to project path.
      log.info(`Worktree fallback to project path`, { err: String(err) });
      verifyPath = project.path;
    }
  }

  // Gate 0.5: TEST_COMMANDS — ADVISORY mode.
  // Results are logged and included in review context, but do NOT hard-reject.
  // Fragile shell one-liners (grep patterns, path assumptions) caused cascading
  // false rejections that tripped circuit breakers and stalled entire projects.
  // The review agent and smoke test are better quality signals.
  let testCommandWarnings: string | undefined;
  const gate05Span = trace.span('gate-0.5-test-commands');
  try {
    const testCommands = parseTestCommands(goal.description || '');
    if (testCommands.length > 0 && verifyPath) {
      log.info(`Running ${testCommands.length} TEST_COMMANDS for "${goal.title}"${worktreeCreated ? ' (worktree)' : ''} [advisory mode]`);
      const testResults = await runTestCommands(verifyPath, testCommands, {
        originalProjectPath: project?.path || undefined,
      });
      const failures = testResults.filter(r => !r.passed);

      if (failures.length > 0) {
        const failureMsg = formatTestCommandFailures(testResults);
        log.info(`TEST_COMMANDS advisory failures for "${goal.title}": ${failureMsg}`);
        testCommandWarnings = `TEST_COMMANDS (advisory): ${failureMsg}`.slice(0, 2000);
        recordLesson(goal, 'TEST_COMMANDS', failureMsg);
        gate05Span.end({ verdict: 'advisory-fail', failures: failures.length });
      } else {
        log.info(`TEST_COMMANDS passed: ${testResults.length}/${testResults.length}`);
        gate05Span.end({ verdict: 'pass', commandCount: testCommands.length });
      }
    } else {
      gate05Span.end({ verdict: 'skipped' });
    }
  } catch (err) {
    log.error(`TEST_COMMANDS error for ${goalId}`, err);
    gate05Span.end({ verdict: 'error', error: String(err) });
  }

  // Clean up verification worktree
  if (worktreeCreated && project?.path) {
    try { execSync(`git worktree remove /tmp/verify-${goalId} --force`, { cwd: project.path, timeout: 10000, stdio: 'pipe' }); } catch (e) { log.swallow('remove-verification-worktree', e); }
  }

  // Fast path: skip smoke test + review agent for trivial/docs/research goals
  // These gates cost ~$0.15 and 30-70s but rarely catch issues on small changes.
  // Research goals produce documents, not code — code review and smoke test don't apply.
  // Validation (Gate 0) and TEST_COMMANDS (Gate 0.5) still ran above.
  const goalType = classifyGoalType(goal);
  const effectiveArchetype = goal.archetype || classifyGoalArchetype(goal);
  const fastPath = goalType === 'trivial' || goalType === 'docs' || effectiveArchetype === 'research';
  if (fastPath) {
    log.info(`Fast path: skipping smoke test + review for "${goal.title}" (type=${goalType}, archetype=${effectiveArchetype})`);
  }

  // 1. Parse DEBRIEF from agent output
  const parsed = parseDebrief(agentOutput);
  const hasBlock = agentOutput.includes('---DEBRIEF---');
  log.info(`Debrief parse: hasBlock=${hasBlock}, parsed=${parsed ? 'yes' : 'null'}, output preview: ${agentOutput.slice(-500).replace(/\n/g, '\\n')}`);
  if (parsed) {
    log.info(`Parsed fields: commits=${parsed.commits?.length || 0}, working=${(parsed.working || '').slice(0, 80)}, broken=${(parsed.broken || '').slice(0, 80)}`);
  }
  const debrief: StructuredDebrief = {
    goalId,
    project: goal.project,
    title: goal.title,
    completedAt: new Date().toISOString(),
    commits: parsed?.commits || [],
    working: parsed?.working || '',
    broken: parsed?.broken || '',
    tests: parsed?.tests || '',
    verified: parsed?.verified || '',
    confidence: parsed?.confidence || 'unknown',
    next: parsed?.next || '',
    groundTruthCommits: [],
    retestPassed: null,
  };

  // Log warning if agent didn't describe any verification (informational, not rejection)
  if (!parsed?.verified) {
    log.info(`Note: Agent did not report VERIFIED field for "${goal.title}"`);
  }

  // Include TEST_COMMANDS advisory warnings in debrief (from Gate 0.5)
  if (testCommandWarnings) {
    debrief.qualityWarnings = [
      ...(debrief.qualityWarnings || []),
      testCommandWarnings,
    ];
  }

  // Pre-launch smoke test in parallel with review (read-only Playwright crawl, safe to
  // run concurrently). The promise is awaited after review completes. If review rejects,
  // the smoke test result is simply discarded. Saves ~30-70s on passing goals.
  const smokeTestPromise = !fastPath
    ? import('./smoke-test.js')
        .then(({ verifySmokeTest }) => {
          const arch = (goal.archetype === 'backend' || goal.archetype === 'frontend')
            ? goal.archetype
            : classifyGoalArchetype(goal);
          return verifySmokeTest(goal.project, goalId, { goal, archetype: arch });
        })
        .catch(err => { log.error(`Smoke test pre-launch error for ${goalId}`, err); return null; })
    : Promise.resolve(null);

  // 1b. Review agent — Claude Code Review (multi-perspective, confidence scoring)
  //     Routes: large diffs → Claude Code Review, small diffs → legacy Sonnet
  //     REJECT: keep commits on branch, re-queue goal with review feedback
  //     CONCERN: allow push but flag for human review
  //     APPROVE: normal flow
  //     SKIPPED for trivial/docs/research goals (fast path) — saves ~$0.10-0.25 per goal.
  let reviewResult: ReviewResult | null = null;
  const gate1Span = trace.span('gate-1-review');
  if (fastPath) {
    log.info(`Skipping review agent (fast path: ${goalType})`);
    gate1Span.end({ verdict: 'skipped', reason: 'fast-path' });
  } else try {
    reviewResult = await reviewGoalCompletion(goal, null);
    debrief.reviewVerdict = reviewResult.verdict;
    debrief.reviewFeedback = reviewResult.feedback;
    debrief.reviewBackend = reviewResult.backend;
    debrief.reviewAvgConfidence = reviewResult.avgConfidence;
    debrief.reviewFilteredCount = reviewResult.filteredCount;

    if (reviewResult.verdict === 'reject') {
      log.info(`REVIEW REJECTED "${goal.title}" (${reviewResult.backend}): ${reviewResult.feedback}`);
      log.info(`Keeping commits on branch — next agent will continue from here`);

      const issueDetails = reviewResult.issues
        .map(i => {
          const conf = i.confidence ? ` [${i.confidence}%]` : '';
          return `- [${i.severity}] ${i.type}${conf}: ${i.detail}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}`;
        })
        .join('\n');

      const reviewReason = `Review agent (${reviewResult.backend || 'unknown'}): ${reviewResult.feedback}${issueDetails ? '\n' + issueDetails : ''}`;
      // Review rejection should NOT burn a full attempt — the agent completed work,
      // just the review didn't approve it. Decrement attemptCount so the next dispatch
      // doesn't escalate unnecessarily. This prevents review false positives from
      // exhausting all 3 attempts (92% of review rejections are false positives per data).
      const currentAttempts = goal.attemptCount ?? 0;
      updateGoal(goalId, {
        status: 'pending',
        completedAt: undefined,
        lastRejectionReason: reviewReason.slice(0, 1000),
        output: agentOutput.slice(-5000),
        attemptCount: Math.max(0, currentAttempts - 1),
      });
      recordLesson(goal, `review-${reviewResult.backend || 'unknown'}`, reviewResult.feedback);

      gate1Span.end({ verdict: 'reject', backend: reviewResult.backend, issueCount: reviewResult.issues.length });
      trace.update({ statusMessage: 'rejected:review' });
      trace.end();
      return null;
    }

    if (reviewResult.verdict === 'concern') {
      // For user-reported, Jam-sourced, and direct user feedback goals, 'concern' is blocking.
      // For internal sources (system, design-research, pm-sweep), it's advisory.
      const isUserFacingSource = goal.source === 'jam'
        || goal.source?.startsWith('jam:')
        || goal.source === 'user-feedback'
        || goal.source === 'user'
        || goal.source === 'feedback'; // set by feedback-processor.ts for Director-created feedback goals

      if (isUserFacingSource) {
        log.info(`REVIEW CONCERN (BLOCKING) "${goal.title}" (${reviewResult.backend}) [source: ${goal.source}]: ${reviewResult.feedback}`);
        log.info(`Keeping commits on branch — next agent will continue from here`);

        const issueDetails = reviewResult.issues
          .map(i => {
            const conf = i.confidence ? ` [${i.confidence}%]` : '';
            return `- [${i.severity}] ${i.type}${conf}: ${i.detail}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}`;
          })
          .join('\n');

        const reviewReason = `Review agent (${reviewResult.backend || 'unknown'}): ${reviewResult.feedback}${issueDetails ? '\n' + issueDetails : ''}`;
        updateGoal(goalId, {
          status: 'pending',
          completedAt: undefined,
          lastRejectionReason: reviewReason.slice(0, 1000),
          output: agentOutput.slice(-5000),
        });
        recordLesson(goal, `review-concern-${reviewResult.backend || 'unknown'}`, reviewResult.feedback);

        gate1Span.end({ verdict: 'reject', backend: reviewResult.backend, issueCount: reviewResult.issues.length, reason: 'user-facing-concern' });
        trace.update({ statusMessage: 'rejected:review-concern' });
        trace.end();
        return null;
      } else {
        // Internal sources: 'concern' is advisory only
        log.info(`REVIEW CONCERN (ADVISORY) "${goal.title}" (${reviewResult.backend}) [source: ${goal.source}]: ${reviewResult.feedback}`);
        debrief.reviewConcerns = reviewResult.feedback;
      }
    }

    if (reviewResult.verdict === 'approve') {
      log.info(`Review approved (${reviewResult.backend}): ${reviewResult.feedback}`);
    }
    gate1Span.end({ verdict: reviewResult.verdict, backend: reviewResult.backend });
  } catch (err) {
    log.error(`Review agent error for ${goalId}`, err);
    gate1Span.end({ verdict: 'error', error: String(err) });
  }

  // 1.5. Behavioral verification — Jam-sourced goal interaction replay
  //      For goals originating from Jam bug recordings, replays the user's
  //      interaction via Playwright and verifies the reported bug is resolved.
  //      Only runs for goals where source starts with "jam:".
  const gate15Span = trace.span('gate-1.5-behavioral-verify');
  if (fastPath) {
    gate15Span.end({ verdict: 'skipped', reason: 'fast-path' });
  } else if (!isJamSourced(goal)) {
    gate15Span.end({ verdict: 'skipped', reason: 'not-jam-sourced' });
  } else try {
    const behavioralResult = await runBehavioralVerification(goal);
    if (behavioralResult) {
      debrief.behavioralVerifyPassed = behavioralResult.passed;
      debrief.behavioralVerifySummary = behavioralResult.summary;
      debrief.behavioralVerifyCostUsd = behavioralResult.costUsd;

      if (!behavioralResult.passed) {
        log.info(`BEHAVIORAL VERIFY REJECTED "${goal.title}": ${behavioralResult.summary}`);
        log.info(`Keeping commits on branch — next agent will continue from here`);

        updateGoal(goalId, {
          status: 'pending',
          completedAt: undefined,
          lastRejectionReason: `Behavioral verification: ${behavioralResult.summary}`.slice(0, 1000),
          output: agentOutput.slice(-5000),
        });
        recordLesson(goal, 'behavioral-verify', behavioralResult.summary);

        gate15Span.end({ verdict: 'reject', errors: behavioralResult.errors.length });
        trace.update({ statusMessage: 'rejected:behavioral-verify' });
        trace.end();
        return null;
      }

      log.info(`Behavioral verification passed: ${behavioralResult.summary}`);
      gate15Span.end({ verdict: 'pass' });
    } else {
      gate15Span.end({ verdict: 'skipped', reason: 'not-applicable' });
    }
  } catch (err) {
    log.error(`Behavioral verification error for ${goalId}`, err);
    gate15Span.end({ verdict: 'error', error: String(err) });
  }

  // 1c. Smoke test — route health regression detection (runs in parallel with review)
  //     Only hard-fails on newly broken routes. Placeholder/empty → warning only.
  //     SKIPPED for trivial/docs/research goals (fast path) — not worth the 30-70s cost.
  const gate2Span = trace.span('gate-2-smoke-test');
  if (fastPath) {
    log.info(`Skipping smoke test (fast path: ${goalType})`);
    gate2Span.end({ verdict: 'skipped', reason: 'fast-path' });
  } else try {
    const smokeResult = await smokeTestPromise;
    if (!smokeResult) {
      log.info(`Smoke test returned null for "${goal.title}" — skipping`);
      gate2Span.end({ verdict: 'error', error: 'null result from pre-launch' });
    } else {
    debrief.smokeTestPassed = smokeResult.passed;

    if (!smokeResult.passed) {
      log.info(`SMOKE TEST FAILED for "${goal.title}": ${smokeResult.summary}`);

      updateGoal(goalId, {
        status: 'pending',
        completedAt: undefined,
        lastRejectionReason: `Smoke test: ${smokeResult.summary}`,
        output: agentOutput.slice(-5000),
      });
      recordLesson(goal, 'smoke-test', smokeResult.summary);

      // Revert commits on the branch to restore working state, then return to main
      try {
        const project = getProject(goal.project);
        if (project?.path) {
          try {
            execSync('git reset HEAD -- .', { cwd: project.path, encoding: 'utf8', timeout: 10000 });
            execSync('git checkout -- .', { cwd: project.path, encoding: 'utf8', timeout: 10000 });
            execSync('git clean -fd', { cwd: project.path, encoding: 'utf8', timeout: 10000 });
          } catch (e) { log.swallow('clean-working-tree-before-revert', e); }

          const featureBranch = `goal/${goalId}`;
          try {
            const branchCommits = execSync(
              `git log --oneline ${featureBranch} --not main`,
              { cwd: project.path, encoding: 'utf8', timeout: 10000 }
            ).trim();
            const commitCount = branchCommits ? branchCommits.split('\n').length : 0;
            if (commitCount > 0) {
              try {
                execSync(`git revert --no-commit HEAD~${commitCount}..HEAD`, {
                  cwd: project.path, encoding: 'utf8', timeout: 30000,
                });
                execSync(`git commit -m "revert: smoke test failed for ${goal.title.replace(/"/g, '\\"').slice(0, 60)}"`, {
                  cwd: project.path, encoding: 'utf8', timeout: 10000,
                });
                log.info(`Reverted ${commitCount} commits on branch after smoke test failure`);
              } catch (e) {
                try { execSync('git revert --abort', { cwd: project.path, encoding: 'utf8' }); } catch (e2) { log.swallow('abort-revert', e2); }
                log.info(`Revert had conflicts — aborted, leaving branch as-is`);
              }
            }
          } catch (e) { log.swallow('count-branch-commits-for-revert', e); }
          execSync('git checkout main', { cwd: project.path, encoding: 'utf8', timeout: 10000 });
        }
      } catch (revertErr) {
        log.error(`Git revert/checkout failed (manual cleanup needed)`, revertErr);
      }

      gate2Span.end({ verdict: 'reject', summary: smokeResult.summary });
      trace.update({ statusMessage: 'rejected:smoke-test' });
      trace.end();
      return null;
    }

    log.info(`Smoke test passed: ${smokeResult.summary}`);

    if (smokeResult.qualityWarnings.length > 0) {
      log.info(`Quality warnings for "${goal.title}": ${smokeResult.qualityWarnings.map(w => `${w.path}: ${w.type}`).join(', ')}`);
      debrief.qualityWarnings = smokeResult.qualityWarnings.map(
        w => `${w.path}: ${w.type} — ${w.detail}`
      );
    }

    // Capture visual review results in debrief
    if (smokeResult.visualReview) {
      debrief.visualReviewVerdict = smokeResult.visualReview.verdict;
      debrief.visualReviewSummary = smokeResult.visualReview.summary;
      debrief.visualReviewCostUsd = smokeResult.visualReview.costUsd;
    }
    gate2Span.end({ verdict: 'pass', warnings: smokeResult.qualityWarnings.length });
    } // end smokeResult !== null
  } catch (err) {
    log.error(`Smoke test error for ${goalId}`, err);
    gate2Span.end({ verdict: 'error', error: String(err) });
  }

  // 2. Checkpoint state (non-blocking)
  try {
    await checkpointAfterGoal(goal, true);
  } catch (err) {
    log.error(`Checkpoint failed for ${goalId}`, err);
  }

  // 3. Get ground-truth commits
  try {
    const project = getProject(goal.project);
    if (project?.path) {
      debrief.groundTruthCommits = getRecentCommits(project.path, goal.startedAt);
    }
  } catch (err) {
    log.error(`Git log failed for ${goalId}`, err);
  }

  // 3a.5 Secret scanning — reject if secrets found in diff
  try {
    const projectForScan = getProject(goal.project);
    if (projectForScan?.path) {
      const secretScan = scanBranchForSecrets(projectForScan.path, goalId);
      if (!secretScan.passed) {
        const findingsMsg = formatSecretFindings(secretScan.findings);
        log.warn(`SECRET SCAN FAILED for "${goal.title}": ${secretScan.summary}`);

        updateGoal(goalId, {
          status: 'pending',
          completedAt: undefined,
          lastRejectionReason: `Secret scan: ${secretScan.summary}\n${findingsMsg}`.slice(0, 2000),
          output: agentOutput.slice(-5000),
        });
        recordLesson(goal, 'secret-scan', secretScan.summary);

        trace.event('secret-scan-failed', { findings: secretScan.findings.length });
        trace.update({ statusMessage: 'rejected:secret-scan' });
        trace.end();
        return null;
      }
      if (secretScan.findings.length > 0) {
        // Warnings only — don't block but log
        log.info(`Secret scan warnings for "${goal.title}": ${secretScan.summary}`);
        debrief.secretScanWarnings = secretScan.findings.map(
          f => `${f.pattern} in ${f.file}:${f.line}`
        );
      }
    }
  } catch (err) {
    log.error(`Secret scan error for ${goalId}`, err);
  }

  // 3b. Dependency audit — check for vulnerabilities when package.json changes
  try {
    const projectForAudit = getProject(goal.project);
    if (projectForAudit?.path) {
      const branch = `goal/${goalId}`;
      let diffFiles = '';
      try {
        diffFiles = execSync(`git diff --name-only main...${branch}`, {
          cwd: projectForAudit.path,
          encoding: 'utf8',
          timeout: 10000,
        });
      } catch { /* branch may not exist */ }

      if (diffFiles.includes('package.json') || diffFiles.includes('pnpm-lock.yaml')) {
        log.info(`Running dependency audit for "${goal.title}" (package changes detected)`);
        try {
          const auditOutput = execSync('pnpm audit --json 2>/dev/null || true', {
            cwd: projectForAudit.path,
            encoding: 'utf8',
            timeout: 30000,
          });
          const auditData = JSON.parse(auditOutput || '{}');
          const criticalCount = auditData?.metadata?.vulnerabilities?.critical || 0;
          const highCount = auditData?.metadata?.vulnerabilities?.high || 0;

          if (criticalCount > 0 || highCount > 0) {
            log.warn(`Dependency audit: ${criticalCount} critical, ${highCount} high vulnerabilities`);
            trace.event('dep-audit-warning', { critical: criticalCount, high: highCount });
            // Warning only — don't block merge, but record for visibility
            debrief.qualityWarnings = [
              ...(debrief.qualityWarnings || []),
              `Dependency audit: ${criticalCount} critical, ${highCount} high vulnerabilities`,
            ];
          } else {
            log.info(`Dependency audit passed — no critical/high vulnerabilities`);
          }
        } catch (auditErr) {
          log.info(`Dependency audit parse error (non-blocking)`, { err: String(auditErr) });
        }
      }
    }
  } catch (err) {
    log.error(`Dependency audit error for ${goalId}`, err);
  }

  // 3c. Merge feature branch to main and push
  {
    const project = getProject(goal.project);
    if (project?.path) {
      const cwd = project.path;
      const featureBranch = `goal/${goalId}`;

      // Acquire inter-process git lock (prevents worker from doing branch ops concurrently)
      const releaseGitLock = await acquireGitLock(goal.project);
      try {
        // Clean working tree before merge operations (agents may leave temp/staged files)
        try {
          execSync('git reset HEAD -- .', { cwd, encoding: 'utf8', timeout: 10000 });
          execSync('git checkout -- .', { cwd, encoding: 'utf8', timeout: 10000 });
          execSync('git clean -fd', { cwd, encoding: 'utf8', timeout: 10000 });
        } catch (e) { log.swallow('clean-tree-before-merge', e); }

        // Check if the goal's feature branch exists (worker may have already moved on)
        let branchExists = false;
        try {
          execSync(`git rev-parse --verify ${featureBranch}`, { cwd, encoding: 'utf8', timeout: 5000 });
          branchExists = true;
        } catch (e) { log.swallow('verify-feature-branch', e); }

        // Also check if we happen to be on this or another feature branch
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();

        if (branchExists) {
          // Ensure we're on main before merging
          if (currentBranch !== 'main') {
            execSync('git checkout main', { cwd, encoding: 'utf8', timeout: 10000 });
          }

          // Check if branch has commits not in main
          const branchCommits = execSync(
            `git log --oneline ${featureBranch} --not main`,
            { cwd, encoding: 'utf8', timeout: 10000 }
          ).trim();

          if (branchCommits) {
            // Use 4-tier smart merge resolver
            const mergeResult = await smartMerge(cwd, featureBranch, goal.title);
            if (mergeResult.success) {
              log.info(`Merged ${featureBranch} via tier "${mergeResult.tier}"${mergeResult.filesResolved?.length ? ` (resolved: ${mergeResult.filesResolved.join(', ')})` : ''}`);
            } else {
              log.error(`All merge tiers failed for ${featureBranch}: ${mergeResult.error}`);
            }
          } else {
            log.info(`${featureBranch} has no new commits — already merged or empty`);
          }

          // Delete the feature branch
          try {
            execSync(`git branch -D ${featureBranch}`, { cwd, encoding: 'utf8', timeout: 10000 });
            log.info(`Deleted branch ${featureBranch}`);
          } catch (e) { log.swallow('delete-feature-branch', e); }
        } else {
          // No feature branch — ensure we're on main
          if (currentBranch !== 'main') {
            execSync('git checkout main', { cwd, encoding: 'utf8', timeout: 10000 });
          }
          log.info(`No feature branch for ${goalId} — commits already on main`);
        }

        // Push main
        try {
          execSync('git push origin main 2>&1', {
            cwd,
            encoding: 'utf8',
            timeout: 30000,
          });
          log.info(`Pushed commits for ${goal.project}`);
        } catch (pushErr) {
          // Clean tree before pull --rebase (dev server or merge may have dirtied tracked files)
          try {
            execSync('git reset HEAD -- .', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
            execSync('git checkout -- .', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
            execSync('git clean -fd', { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
          } catch (e) { log.swallow('clean-tree-before-rebase', e); }
          // Pull rebase then retry push
          try {
            execSync('git pull --rebase origin main 2>&1', { cwd, encoding: 'utf8', timeout: 30000 });
            execSync('git push origin main 2>&1', { cwd, encoding: 'utf8', timeout: 30000 });
            log.info(`Pushed commits for ${goal.project} (after pull --rebase)`);
          } catch (retryErr) {
            try { execSync('git rebase --abort 2>&1', { cwd, encoding: 'utf8' }); } catch (e) { log.swallow('abort-rebase', e); }
            log.error(`Push failed for ${goal.project}`, retryErr);
          }
        }
      } catch (err) {
        log.error(`Git merge/push failed for ${goal.project}`, err);
      } finally {
        releaseGitLock();
      }
    }
  }

  // 3c. Post-push reactions (unblock dependents, restart dev server)
  try {
    const reactions = await runPostPushReactions(goal, debrief);
    if (reactions.unblockedGoals.length > 0) {
      log.info(`Unblocked: ${reactions.unblockedGoals.join(', ')}`);
    }
  } catch (err) {
    log.error(`Post-push reactions failed`, err);
  }

  // 4. Run cascade retest (non-blocking)
  try {
    const retestResult = await runCascadeRetest(goal.project);
    debrief.retestPassed = retestResult.result
      ? retestResult.result.failed === 0
      : null;
  } catch (err) {
    log.error(`Cascade retest failed for ${goalId}`, err);
  }

  // 5. Store structured debrief
  try {
    if (!existsSync(DEBRIEFS_DIR)) {
      mkdirSync(DEBRIEFS_DIR, { recursive: true });
    }
    writeFileSync(
      join(DEBRIEFS_DIR, `${goalId}.json`),
      JSON.stringify(debrief, null, 2)
    );
  } catch (err) {
    log.error(`Debrief save failed for ${goalId}`, err);
  }

  // 6. Extract knowledge from debrief
  try {
    if (debrief.working) {
      addKnowledge('insight', `[${goal.project}] Working: ${debrief.working}`, {
        project: goal.project,
        tags: ['debrief', 'working'],
        source: 'observation',
      });
    }
    if (debrief.broken) {
      addKnowledge('insight', `[${goal.project}] Broken: ${debrief.broken}`, {
        project: goal.project,
        tags: ['debrief', 'broken'],
        source: 'observation',
      });
    }
  } catch (err) {
    log.error(`Knowledge extraction failed for ${goalId}`, err);
  }

  // 6b. Update feature inventory from goal completion
  try {
    const { updateInventoryFromGoal } = await import('../director/feature-inventory.js');
    updateInventoryFromGoal(goal.project, goal, debrief);
  } catch (err) {
    log.error(`Feature inventory update failed`, err);
  }

  // 7. Update agent_run with post-completion data
  if (runId) {
    try {
      const postUpdate: AgentRunUpdate = {
        crossCheckResult: debrief.reviewVerdict || 'pass',
        crossCheckIssues: debrief.reviewFeedback
          ? [debrief.reviewFeedback]
          : undefined,
        debriefJson: debrief as unknown as Record<string, unknown>,
        qualityScore: debrief.confidence === 'high' ? 5
          : debrief.confidence === 'medium' ? 3
          : debrief.confidence === 'low' ? 2
          : debrief.confidence === 'uncertain' ? 1 : undefined,
      };

      // Add test data if available from debrief
      const testMatch = debrief.tests.match(/(\d+)\s*pass/i);
      const failMatch = debrief.tests.match(/(\d+)\s*fail/i);
      if (testMatch) postUpdate.testsPassed = parseInt(testMatch[1], 10);
      if (failMatch) postUpdate.testsFailed = parseInt(failMatch[1], 10);
      if (postUpdate.testsPassed !== undefined || postUpdate.testsFailed !== undefined) {
        postUpdate.testsRun = (postUpdate.testsPassed ?? 0) + (postUpdate.testsFailed ?? 0);
      }

      updateAgentRun(runId, postUpdate);
      log.info(`Updated agent_run ${runId} with review and debrief`);
    } catch (err) {
      log.error(`SQLite update failed for ${goalId}`, err);
    }
  }

  // 8. Post structured Linear comment + labels
  try {
    if (goal.linearId && isLinearEnabled()) {
      // Get run data from SQLite for cost/model/archetype info
      let runData: { model?: string; archetype?: string; costUsd?: number; durationMs?: number } = {};
      if (runId) {
        try {
          const run = getAgentRun(runId);
          if (run) {
            runData = {
              model: run.model_assigned,
              archetype: run.archetype ?? undefined,
              costUsd: run.cost_usd ?? undefined,
              durationMs: run.duration_ms ?? undefined,
            };
          }
        } catch (e) { log.swallow('read-agent-run-for-linear', e); }
      }

      // Parse test data from debrief
      let testsRun: number | undefined;
      let testsPassed: number | undefined;
      let testsFailed: number | undefined;
      const testPassMatch = debrief.tests.match(/(\d+)\s*pass/i);
      const testFailMatch = debrief.tests.match(/(\d+)\s*fail/i);
      if (testPassMatch) testsPassed = parseInt(testPassMatch[1], 10);
      if (testFailMatch) testsFailed = parseInt(testFailMatch[1], 10);
      if (testsPassed !== undefined || testsFailed !== undefined) {
        testsRun = (testsPassed ?? 0) + (testsFailed ?? 0);
      }

      // Get screenshot count from agent_run
      let screenshotCount: number | undefined;
      if (runId) {
        try {
          const runForScreenshots = getAgentRun(runId);
          if (runForScreenshots?.screenshots) {
            screenshotCount = (JSON.parse(runForScreenshots.screenshots) as string[]).length;
          }
        } catch (e) { log.swallow('read-screenshot-count', e); }
      }

      await postStructuredComment(goal.linearId, {
        exitSignal: 'GOAL_COMPLETE',
        model: runData.model,
        archetype: runData.archetype,
        costUsd: runData.costUsd,
        durationMs: runData.durationMs,
        testsRun,
        testsPassed,
        testsFailed,
        crossCheckResult: debrief.reviewVerdict || 'pass',
        crossCheckIssues: debrief.reviewFeedback ? [debrief.reviewFeedback] : undefined,
        qualityScore: debrief.confidence === 'high' ? 5
          : debrief.confidence === 'medium' ? 3
          : debrief.confidence === 'low' ? 2 : undefined,
        screenshotCount,
        debriefWorking: debrief.working,
        debriefBroken: debrief.broken,
        debriefNext: debrief.next,
      });

      // Set labels on the Linear issue
      const labels = generateRunLabels({
        model: runData.model,
        archetype: runData.archetype,
        exitSignal: 'GOAL_COMPLETE',
        project: goal.project,
      });
      if (labels.length > 0) {
        await setIssueLabels(goal.linearId, labels);
      }

      log.info(`Posted structured comment + ${labels.length} labels to Linear for ${goalId}`);
    }
  } catch (err) {
    log.error(`Linear structured comment failed for ${goalId}`, err);
  }

  // 8b. Post-completion: design-research Phase 2 template parsing
  //     When a Phase 2 design-research goal completes, parse goal-templates.md
  //     and log the parsed templates for visibility. Templates are NOT auto-created —
  //     they're surfaced via Telegram for user approval.
  try {
    const effectiveArch = goal.archetype || classifyGoalArchetype(goal);
    if (effectiveArch === 'design-research' && goal.title.includes('Phase 2')) {
      const projectForTemplates = getProject(goal.project);
      if (projectForTemplates?.path) {
        const { loadProjectGoalTemplates } = await import('./goal-template-parser.js');
        const templates = loadProjectGoalTemplates(projectForTemplates.path);
        if (templates && templates.length > 0) {
          log.info(`Design-research Phase 2 complete: parsed ${templates.length} goal templates for ${goal.project}`);
          // Store template count in debrief for Telegram notification
          debrief.qualityWarnings = [
            ...(debrief.qualityWarnings || []),
            `TEMPLATES_READY: ${templates.length} implementation goals parsed from goal-templates.md. Run /designResearch ${goal.project} to review.`,
          ];
        }
      }
    }
  } catch (err) {
    log.error(`Design-research template parsing failed`, err);
  }

  // End the quality gates trace
  trace.update({
    output: JSON.stringify({
      reviewVerdict: debrief.reviewVerdict,
      smokeTestPassed: debrief.smokeTestPassed,
      retestPassed: debrief.retestPassed,
      confidence: debrief.confidence,
    }),
    statusMessage: 'completed',
  });
  trace.end();

  return debrief;
}

export function formatDebriefForLinear(debrief: StructuredDebrief): string {
  const lines = [`## Agent Debrief`];
  if (debrief.working) lines.push(`**Working:** ${debrief.working}`);
  if (debrief.broken) lines.push(`**Broken:** ${debrief.broken}`);
  if (debrief.tests) lines.push(`**Tests:** ${debrief.tests}`);
  if (debrief.confidence) lines.push(`**Confidence:** ${debrief.confidence}`);
  if (debrief.groundTruthCommits.length > 0) {
    lines.push(`**Commits:** ${debrief.groundTruthCommits.join(', ')}`);
  }
  if (debrief.retestPassed !== null) {
    lines.push(`**Retest:** ${debrief.retestPassed ? 'Passed' : 'Failed'}`);
  }
  if (debrief.next) lines.push(`**Next:** ${debrief.next}`);
  return lines.join('\n');
}
