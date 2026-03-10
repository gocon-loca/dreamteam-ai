/**
 * Review Agent — Post-completion quality gate (v2: Claude Code Review integration)
 *
 * Two review backends:
 *   1. Claude Code Review (default): spawns Claude CLI in project directory with full
 *      codebase context, REVIEW.md rules, confidence scoring, and multi-perspective analysis.
 *      No diff truncation — Claude reads files directly.
 *   2. Legacy Sonnet Review (fallback): single-shot Sonnet with truncated diff.
 *      Used when Claude CLI is unavailable or for very small diffs.
 *
 * Routing logic:
 *   - Small diffs (<4000 chars): legacy Sonnet (faster, cheaper)
 *   - Large diffs (>=4000 chars): Claude Code Review (no truncation limit)
 *   - Complex/auth goals: Claude Code Review always
 *   - Env override: DREAMTEAM_REVIEW_BACKEND=legacy|claude-code|auto (default: auto)
 *
 * Phase 1: Drop-in Gate 1 replacement with Claude Code Review
 * Phase 2: REVIEW.md per project for review-specific rules
 * Phase 3: Dual-gate mode (both backends, require agreement)
 * Phase 4: GitHub PR review integration
 * Phase 5: Review feedback loop into prompts
 */

import { execSync, spawn as spawnProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getProject } from '../projects/registry.js';
import { runTask } from '../projects/task-runner.js';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { ensureReviewMd } from './review-config.js';
import type { Goal } from './goal-manager.js';
import type { SmokeTestResult, SmokeSnapshot } from './smoke-test.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ──────────────────────────────────────────────────

export interface ReviewIssue {
  type: 'fake_data' | 'code_quality' | 'scope_creep' | 'design_mismatch' | 'regression' | 'incomplete' | 'security' | 'bug' | 'nit';
  severity: 'critical' | 'warning' | 'nit';
  detail: string;
  file?: string;
  line?: number;
  /** Confidence score 0-100 (Claude Code Review only) */
  confidence?: number;
}

export interface ReviewResult {
  verdict: 'approve' | 'reject' | 'concern';
  feedback: string;
  issues: ReviewIssue[];
  costUsd: number;
  /** Which review backend was used */
  backend?: 'claude-code' | 'legacy-sonnet';
  /** Average confidence across findings (Claude Code Review only) */
  avgConfidence?: number;
  /** Number of findings filtered by confidence threshold */
  filteredCount?: number;
}

/** Confidence threshold — findings below this are filtered out */
const CONFIDENCE_THRESHOLD = 80;

/** Diff size threshold for routing to Claude Code Review */
const LARGE_DIFF_THRESHOLD = 4000;

/** Review backend selection */
type ReviewBackend = 'claude-code' | 'legacy' | 'auto';

function getReviewBackend(): ReviewBackend {
  const env = process.env.DREAMTEAM_REVIEW_BACKEND?.toLowerCase();
  if (env === 'legacy' || env === 'claude-code' || env === 'auto') return env;
  return 'auto';
}

// ── Project Context ────────────────────────────────────────

interface ProjectContext {
  currentRoutes: string[];
}

function getProjectContext(project: string): ProjectContext {
  const ctx: ProjectContext = { currentRoutes: [] };

  try {
    const snapshotPath = join(__dirname, '../../data/snapshots', `${project}-latest.json`);
    if (existsSync(snapshotPath)) {
      const snapshot: SmokeSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
      ctx.currentRoutes = snapshot.routes.map(r => r.path);
    }
  } catch { /* ignore */ }

  return ctx;
}

// ── Git Diff ───────────────────────────────────────────────

function getGoalDiff(projectPath: string, goalId?: string): string {
  try {
    const branch = goalId ? `goal/${goalId}` : 'HEAD';
    return execSync(
      `git diff main...${branch}`,
      { cwd: projectPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    try {
      return execSync(
        `git diff HEAD~10..HEAD`,
        { cwd: projectPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    } catch { return ''; }
  }
}

function getGoalDiffStat(projectPath: string, goalId?: string): string {
  try {
    const branch = goalId ? `goal/${goalId}` : 'HEAD';
    return execSync(
      `git diff main...${branch} --stat`,
      { cwd: projectPath, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    try {
      return execSync(
        `git diff HEAD~10..HEAD --stat`,
        { cwd: projectPath, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    } catch { return ''; }
  }
}

// ── Archetype File Boundary Check ─────────────────────────

const FRONTEND_FILE_PATTERNS = /\.(html|css|scss|hbs|ejs|njk|jinja2?|j2|pug|svelte|vue)$|\/templates\/|\/static\/|\/public\//;
const BACKEND_FILE_PATTERNS = /\/(models|services|pipelines?|migrations?|db|database)\//;

function checkArchetypeBoundary(projectPath: string, archetype: string | undefined, goalId?: string): string[] {
  if (archetype !== 'backend' && archetype !== 'frontend') return [];
  try {
    const branch = goalId ? `goal/${goalId}` : 'HEAD';
    const files = execSync(`git diff main...${branch} --name-only`, { cwd: projectPath, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!files) return [];
    const pattern = archetype === 'backend' ? FRONTEND_FILE_PATTERNS : BACKEND_FILE_PATTERNS;
    return files.split('\n').filter(f => pattern.test(f));
  } catch { return []; }
}

// ── Smart Diff Truncation (legacy mode only) ──────────────

/**
 * Truncate a diff to maxChars, prioritizing file sections that match goal keywords.
 * Only used in legacy Sonnet review mode. Claude Code Review doesn't need this.
 */
export function truncateDiffSmart(diff: string, goalText: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  const sections = diff.split(/^(?=diff --git )/m);
  if (sections.length <= 1) return diff.slice(0, maxChars) + '\n... (diff truncated)';

  const keywords = goalText.toLowerCase().split(/\W+/).filter(w => w.length >= 3);

  const scored = sections.map(section => {
    const lower = section.toLowerCase();
    const score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0);
    return { section, score };
  });

  scored.sort((a, b) => b.score - a.score);

  let result = '';
  let included = 0;
  for (const { section } of scored) {
    if (result.length + section.length > maxChars && included > 0) {
      result += `\n... (${scored.length - included} more files truncated)`;
      break;
    }
    result += section;
    included++;
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  CLAUDE CODE REVIEW (Phase 1)
// ══════════════════════════════════════════════════════════════

/**
 * Run code review using Claude Code CLI in the project directory.
 *
 * Advantages over legacy Sonnet review:
 * - Full codebase context (Claude reads files directly, no truncation)
 * - Reads REVIEW.md for project-specific review rules
 * - Confidence scoring on each finding (filters false positives)
 * - Multi-perspective analysis (bugs, style, security, architecture)
 */
async function reviewWithClaudeCode(
  goal: Goal,
  diff: string,
  diffStat: string,
  projectPath: string,
): Promise<ReviewResult> {
  // Ensure REVIEW.md exists in the project (Phase 2)
  try {
    ensureReviewMd(goal.project);
  } catch (err) {
    console.log(`[ReviewAgent/CC] Could not ensure REVIEW.md: ${err}`);
  }

  // Create a worktree at the goal branch for isolated review
  const branch = `goal/${goal.id}`;
  const wtPath = `/tmp/review-${goal.id}`;
  let reviewCwd = projectPath;
  let worktreeCreated = false;

  try {
    // Clean up stale worktree
    try {
      execSync(`git worktree remove ${wtPath} --force`, { cwd: projectPath, timeout: 10000, stdio: 'pipe' });
    } catch { /* doesn't exist */ }

    execSync(`git worktree add --detach ${wtPath} ${branch}`, { cwd: projectPath, timeout: 15000, stdio: 'pipe' });
    reviewCwd = wtPath;
    worktreeCreated = true;
    console.log(`[ReviewAgent/CC] Created review worktree at ${wtPath}`);
  } catch (err) {
    console.log(`[ReviewAgent/CC] Worktree fallback to project path: ${err}`);
  }

  // Copy REVIEW.md to worktree if it exists in the project but not in worktree
  if (worktreeCreated) {
    try {
      const reviewMdSrc = join(projectPath, 'REVIEW.md');
      const reviewMdDst = join(wtPath, 'REVIEW.md');
      if (existsSync(reviewMdSrc) && !existsSync(reviewMdDst)) {
        const content = readFileSync(reviewMdSrc, 'utf-8');
        writeFileSync(reviewMdDst, content);
      }
    } catch { /* non-blocking */ }
  }

  const reviewPrompt = buildClaudeCodeReviewPrompt(goal, diff, diffStat);

  try {
    const result = await spawnClaudeForReview(reviewCwd, reviewPrompt);
    return parseClaudeCodeReviewOutput(result.output, result.costUsd);
  } catch (err) {
    console.error(`[ReviewAgent/CC] Claude Code review failed:`, err);
    // Fall back to legacy review
    return {
      verdict: 'concern',
      feedback: `Claude Code Review failed (${err}), flagged as concern.`,
      issues: [{ type: 'code_quality', severity: 'warning', detail: `Review infrastructure error: ${err}` }],
      costUsd: 0,
      backend: 'claude-code',
    };
  } finally {
    // Clean up worktree
    if (worktreeCreated) {
      try {
        execSync(`git worktree remove ${wtPath} --force`, { cwd: projectPath, timeout: 10000, stdio: 'pipe' });
      } catch { /* ignore */ }
    }
  }
}

function buildClaudeCodeReviewPrompt(goal: Goal, diff: string, diffStat: string): string {
  // Check if goal is from design-research or UX pipeline — add STYLE.md conformance
  const isUxSourced = goal.source === 'design-research'
    || goal.title.toLowerCase().includes('design research')
    || goal.title.toLowerCase().includes('style');

  const styleConformance = isUxSourced
    ? `\n6. **STYLE.md Conformance**: If the project has a STYLE.md, check that all UI changes conform to its design tokens (colors, typography, spacing, component patterns). Flag any new colors, fonts, or patterns that conflict with STYLE.md.`
    : '';

  return `You are performing a code review of changes for the goal: "${goal.title}"

## Goal Description
${goal.description || 'No description provided.'}

## Files Changed
${diffStat || 'No diff stat available.'}

## Full Diff
\`\`\`diff
${diff}
\`\`\`

## Review Instructions

You have full access to the codebase. Read any file you need for context. If the project has a REVIEW.md, read it first for project-specific review rules. Also read CLAUDE.md for project conventions.${isUxSourced ? ' Also read STYLE.md if it exists for design system conformance.' : ''}

Analyze this change from FIVE perspectives:
1. **Bug Detection**: Runtime errors, logic flaws, null/undefined risks, race conditions
2. **Security**: Injection risks, auth bypass, data exposure, unsafe operations
3. **CLAUDE.md Compliance**: Does the code follow project conventions?
4. **Regression Risk**: Could this break existing functionality?
5. **Code Quality**: Fake data, console.log leftovers, unused imports, dead code${styleConformance}

IMPORTANT: Files shown as added (+) in the diff are NEW files being created. They WILL exist after merge. Do NOT flag new files as "missing".

For each finding, assign a confidence score (0-100). Only report findings you are >=70% confident about. Mark severity as:
- "critical": Bugs that should be fixed before merging
- "warning": Issues worth fixing but not blocking
- "nit": Minor style/quality issues

## Output Format
Respond with ONLY a JSON object (no markdown fences, no other text):
{
  "verdict": "approve" | "reject" | "concern",
  "feedback": "<2-3 sentence summary>",
  "findings": [
    {
      "perspective": "bug" | "security" | "compliance" | "regression" | "quality",
      "type": "bug" | "security" | "fake_data" | "code_quality" | "scope_creep" | "design_mismatch" | "regression" | "incomplete" | "nit",
      "severity": "critical" | "warning" | "nit",
      "confidence": <0-100>,
      "detail": "<specific description>",
      "file": "<filename>",
      "line": <line number or null>
    }
  ]
}

Decision guide:
- REJECT if any critical findings with confidence >= ${CONFIDENCE_THRESHOLD}
- CONCERN if only warnings/nits with high confidence
- APPROVE if no significant issues found

If everything looks good: {"verdict":"approve","feedback":"Changes match the goal. Code is clean and production-ready.","findings":[]}`;
}

/**
 * Spawn Claude CLI for review. Uses secondary model (Sonnet) for cost efficiency.
 * Returns raw output and cost.
 */
function spawnClaudeForReview(
  cwd: string,
  prompt: string,
): Promise<{ output: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', '5', // Allow a few turns to read files for context
    ];

    const childProc = spawnProcess(claudePath, args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude(),
    });

    // Write review prompt to stdin
    childProc.stdin?.write(prompt);
    childProc.stdin?.end();

    let output = '';
    let stderr = '';

    const timeoutHandle = setTimeout(() => {
      childProc.kill('SIGKILL');
      reject(new Error('Review timed out after 3 minutes'));
    }, 3 * 60 * 1000);

    childProc.stdout?.on('data', (data) => { output += data.toString(); });
    childProc.stderr?.on('data', (data) => { stderr += data.toString(); });

    childProc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });

    childProc.on('exit', (code) => {
      clearTimeout(timeoutHandle);

      // Parse JSON output from Claude CLI
      let textOutput = output;
      let costUsd = 0;

      try {
        const parsed = JSON.parse(output);
        textOutput = typeof parsed.result === 'string' ? parsed.result : output;
        costUsd = parsed.total_cost_usd ?? 0;
      } catch {
        // Raw text fallback
        console.warn(`[ReviewAgent/CC] JSON parse failed (${output.length} bytes), using raw output`);
      }

      if (code !== 0 && !textOutput) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      resolve({ output: textOutput, costUsd });
    });
  });
}

/**
 * Parse Claude Code Review output with confidence filtering.
 */
function parseClaudeCodeReviewOutput(output: string, costUsd: number): ReviewResult {
  let parsed: {
    verdict: string;
    feedback: string;
    findings: Array<{
      perspective?: string;
      type: string;
      severity: string;
      confidence: number;
      detail: string;
      file?: string;
      line?: number | null;
    }>;
  };

  try {
    parsed = JSON.parse(output.trim());
  } catch {
    console.warn(`[ReviewAgent/CC] JSON parse failed on raw output (${output.length} bytes), trying regex extraction`);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn(`[ReviewAgent/CC] JSON extraction also failed — falling back to text review (will flag as concern)`);
        return parseTextReview(output, costUsd, 'claude-code');
      }
    } else {
      console.warn(`[ReviewAgent/CC] JSON extraction also failed — falling back to text review (will flag as concern)`);
      return parseTextReview(output, costUsd, 'claude-code');
    }
  }

  // Convert findings to ReviewIssues with confidence filtering
  const allFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const filteredCount = allFindings.filter(f => (f.confidence ?? 100) < CONFIDENCE_THRESHOLD).length;
  const highConfFindings = allFindings.filter(f => (f.confidence ?? 100) >= CONFIDENCE_THRESHOLD);

  const issues: ReviewIssue[] = highConfFindings.map(f => ({
    type: mapFindingType(f.type),
    severity: mapSeverity(f.severity),
    detail: f.detail,
    file: f.file,
    line: f.line ?? undefined,
    confidence: f.confidence,
  }));

  // Re-evaluate verdict based on filtered findings
  let verdict: ReviewResult['verdict'];
  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasWarning = issues.some(i => i.severity === 'warning');

  if (hasCritical) {
    verdict = 'reject';
  } else if (hasWarning) {
    verdict = 'concern';
  } else {
    verdict = 'approve';
  }

  // Override with parsed verdict if it's stricter
  const parsedVerdict = parsed.verdict?.toLowerCase();
  if (parsedVerdict === 'reject' && hasCritical) verdict = 'reject';
  if (parsedVerdict === 'concern' && verdict === 'approve' && issues.length > 0) verdict = 'concern';

  const avgConfidence = highConfFindings.length > 0
    ? Math.round(highConfFindings.reduce((sum, f) => sum + (f.confidence ?? 100), 0) / highConfFindings.length)
    : undefined;

  if (filteredCount > 0) {
    console.log(`[ReviewAgent/CC] Filtered ${filteredCount} low-confidence findings (threshold: ${CONFIDENCE_THRESHOLD})`);
  }

  return {
    verdict,
    feedback: parsed.feedback || 'Review completed.',
    issues,
    costUsd,
    backend: 'claude-code',
    avgConfidence,
    filteredCount,
  };
}

function mapFindingType(type: string): ReviewIssue['type'] {
  const map: Record<string, ReviewIssue['type']> = {
    bug: 'bug',
    security: 'security',
    fake_data: 'fake_data',
    code_quality: 'code_quality',
    scope_creep: 'scope_creep',
    design_mismatch: 'design_mismatch',
    regression: 'regression',
    incomplete: 'incomplete',
    nit: 'nit',
  };
  return map[type] || 'code_quality';
}

function mapSeverity(severity: string): ReviewIssue['severity'] {
  if (severity === 'critical') return 'critical';
  if (severity === 'nit') return 'nit';
  return 'warning';
}

// ══════════════════════════════════════════════════════════════
//  LEGACY SONNET REVIEW (fallback)
// ══════════════════════════════════════════════════════════════

function buildLegacyReviewPrompt(
  goal: Goal,
  diff: string,
  diffStat: string,
  smokeResult: SmokeTestResult | null,
  routes: string[],
): string {
  const truncatedDiff = truncateDiffSmart(diff, goal.title + ' ' + (goal.description || ''), 8000);

  let prompt = `You are a senior engineer reviewing a junior developer's work on the "${goal.project}" project. Be strict but fair.

## Goal
**${goal.title}**
${goal.description || 'No description provided.'}

## Files Changed
${diffStat || 'No diff stat available.'}

## Code Diff
\`\`\`
${truncatedDiff || 'No diff available.'}
\`\`\`
`;

  if (smokeResult) {
    const warnings = smokeResult.qualityWarnings.length > 0
      ? ` | Warnings: ${smokeResult.qualityWarnings.map(w => `${w.path}: ${w.type}`).join(', ')}`
      : '';
    prompt += `\n## Smoke Test: ${smokeResult.passed ? 'PASSED' : 'FAILED'} — ${smokeResult.summary}${warnings}\n`;
  }

  if (routes.length > 0) {
    prompt += `\n## Existing Routes (do NOT break): ${routes.join(', ')}\n`;
  }

  prompt += `
## Review Criteria

**IMPORTANT:** Files shown as added (+) in the diff are NEW files being created by this change. They WILL exist after merge. Do NOT reject because new files "don't exist" — they are being created. Judge the diff on its own merits.

**REJECT if ANY of these are true:**
- Hardcoded fake data (names like "Sarah Johnson", "John Smith", placeholder emails, Lorem ipsum, sample data that isn't from the real database)
- New console.log statements left in production code (debugging leftovers — note: console.error in catch/error handler blocks is acceptable server-side logging)
- Files deleted or routes removed without explicit instruction to do so
- The change doesn't match what the goal description asked for
- Import of unused dependencies
- Code that is clearly broken or will cause runtime errors

**CONCERN if ANY of these are true:**
- Large refactors that weren't requested (scope creep)
- Changes to shared utilities that could affect other features
- New dependencies added
- TODO/FIXME/HACK comments added (minor issue, not a rejection)
- Commented-out code blocks
- The change works but quality is noticeably poor

**APPROVE if:**
- The change matches the goal description
- No fake data introduced
- Code is clean and production-ready
- No obvious regressions

## Output Format
Respond with ONLY a JSON object (no markdown fences, no other text):
{
  "verdict": "approve" | "reject" | "concern",
  "feedback": "<2-3 sentence summary of your review>",
  "issues": [
    {
      "type": "fake_data" | "code_quality" | "scope_creep" | "design_mismatch" | "regression" | "incomplete",
      "severity": "critical" | "warning",
      "detail": "<specific issue description>",
      "file": "<filename if applicable>",
      "line": <line number if applicable>
    }
  ]
}

Be specific. Reference exact file names. If everything looks good, return {"verdict":"approve","feedback":"Changes match the goal spec. Code is clean.","issues":[]}.`;

  return prompt;
}

async function reviewWithLegacySonnet(
  goal: Goal,
  diff: string,
  diffStat: string,
  smokeResult: SmokeTestResult | null,
  routes: string[],
): Promise<ReviewResult> {
  const reviewPrompt = buildLegacyReviewPrompt(goal, diff, diffStat, smokeResult, routes);

  const result = await runTask(goal.project, reviewPrompt, {
    autonomous: false,
    maxIterations: 1,
    model: 'secondary',
  });

  const review = parseLegacyReviewResult(result.output);
  review.backend = 'legacy-sonnet';
  review.costUsd = result.costUsd;
  return review;
}

function parseLegacyReviewResult(output: string): ReviewResult {
  let parsed: { verdict: string; feedback: string; issues: ReviewIssue[] };

  try {
    parsed = JSON.parse(output.trim());
  } catch {
    console.warn(`[ReviewAgent/Legacy] JSON parse failed (${output.length} bytes), trying regex extraction`);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn(`[ReviewAgent/Legacy] JSON extraction also failed — falling back to text review (will flag as concern)`);
        return parseTextReview(output, 0, 'legacy-sonnet');
      }
    } else {
      console.warn(`[ReviewAgent/Legacy] JSON extraction also failed — falling back to text review (will flag as concern)`);
      return parseTextReview(output, 0, 'legacy-sonnet');
    }
  }

  const validVerdicts = ['approve', 'reject', 'concern'];
  const verdict = validVerdicts.includes(parsed.verdict)
    ? parsed.verdict as ReviewResult['verdict']
    : 'concern';

  return {
    verdict,
    feedback: parsed.feedback || 'No feedback provided.',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    costUsd: 0,
  };
}

// ── Shared Text Parsing (fallback for both backends) ──────

function parseTextReview(output: string, costUsd: number, backend: ReviewResult['backend']): ReviewResult {
  const lower = output.toLowerCase();

  if (/\bverdict\s*:\s*reject\b/.test(lower) || /^reject\b/m.test(lower) || /\breject(?:ed|ing)?\s+(?:this|the|goal|change|pr|diff)\b/.test(lower)) {
    return {
      verdict: 'reject',
      feedback: output.slice(0, 500),
      issues: [{ type: 'code_quality', severity: 'critical', detail: output.slice(0, 300) }],
      costUsd,
      backend,
    };
  }

  if (/\bverdict\s*:\s*concern\b/.test(lower) || /^concern\b/m.test(lower) || /\bconcern(?:s|ed)?\s+(?:about|with|regarding)\b/.test(lower)) {
    return {
      verdict: 'concern',
      feedback: output.slice(0, 500),
      issues: [{ type: 'code_quality', severity: 'warning', detail: output.slice(0, 300) }],
      costUsd,
      backend,
    };
  }

  // Default: if we can't parse JSON and can't detect verdict from text,
  // flag as concern rather than silently approving
  return {
    verdict: 'concern',
    feedback: `Review output could not be parsed as JSON. Raw output (truncated): ${output.slice(0, 300)}`,
    issues: [{ type: 'code_quality', severity: 'warning', detail: 'Review agent output could not be parsed — manual review recommended' }],
    costUsd,
    backend,
  };
}

// ══════════════════════════════════════════════════════════════
//  DUAL-GATE REVIEW (Phase 3)
// ══════════════════════════════════════════════════════════════

/**
 * Run both review backends and require agreement for approval.
 * Used for complex/auth goals where extra scrutiny is warranted.
 */
async function reviewDualGate(
  goal: Goal,
  diff: string,
  diffStat: string,
  projectPath: string,
  smokeResult: SmokeTestResult | null,
  routes: string[],
): Promise<ReviewResult> {
  console.log(`[ReviewAgent] Dual-gate review for "${goal.title}"`);

  // Run both in parallel
  const [ccResult, legacyResult] = await Promise.all([
    reviewWithClaudeCode(goal, diff, diffStat, projectPath).catch(err => {
      console.error(`[ReviewAgent/DualGate] Claude Code failed:`, err);
      return null;
    }),
    reviewWithLegacySonnet(goal, diff, diffStat, smokeResult, routes).catch(err => {
      console.error(`[ReviewAgent/DualGate] Legacy failed:`, err);
      return null;
    }),
  ]);

  // If one failed, use the other
  if (!ccResult && legacyResult) return legacyResult;
  if (ccResult && !legacyResult) return ccResult;
  if (!ccResult && !legacyResult) {
    return {
      verdict: 'concern',
      feedback: 'Both review backends failed. Manual review recommended.',
      issues: [{ type: 'code_quality', severity: 'warning', detail: 'Review infrastructure failure' }],
      costUsd: 0,
      backend: 'claude-code',
    };
  }

  // Both succeeded — merge results
  const combinedIssues = [
    ...ccResult!.issues.map(i => ({ ...i, detail: `[CC] ${i.detail}` })),
    ...legacyResult!.issues.map(i => ({ ...i, detail: `[Legacy] ${i.detail}` })),
  ];

  // Strictest verdict wins
  let verdict: ReviewResult['verdict'] = 'approve';
  if (ccResult!.verdict === 'reject' || legacyResult!.verdict === 'reject') {
    verdict = 'reject';
  } else if (ccResult!.verdict === 'concern' || legacyResult!.verdict === 'concern') {
    verdict = 'concern';
  }

  return {
    verdict,
    feedback: `Dual-gate: CC=${ccResult!.verdict}, Legacy=${legacyResult!.verdict}. ${ccResult!.feedback}`,
    issues: combinedIssues,
    costUsd: (ccResult!.costUsd || 0) + (legacyResult!.costUsd || 0),
    backend: 'claude-code',
    avgConfidence: ccResult!.avgConfidence,
    filteredCount: ccResult!.filteredCount,
  };
}

// ══════════════════════════════════════════════════════════════
//  GITHUB PR REVIEW (Phase 4)
// ══════════════════════════════════════════════════════════════

/**
 * Create a GitHub PR for the goal branch and post review findings as comments.
 * Returns the PR URL, or null if PR creation failed.
 */
export async function createReviewPR(
  goal: Goal,
  reviewResult: ReviewResult,
): Promise<string | null> {
  const project = getProject(goal.project);
  if (!project?.path) return null;

  try {
    // Check if gh CLI is available
    execSync('which gh', { stdio: 'pipe' });
  } catch {
    console.log(`[ReviewAgent/PR] gh CLI not found — skipping PR creation`);
    return null;
  }

  const branch = `goal/${goal.id}`;
  try {
    // Push the branch to remote
    execSync(`git push -u origin ${branch} 2>&1`, {
      cwd: project.path,
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    });

    // Create PR
    const title = `[DreamTeam] ${goal.title}`.slice(0, 70);
    const body = formatPRBody(goal, reviewResult);

    const prUrl = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base main --head "${branch}" 2>&1`,
      { cwd: project.path, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    ).trim();

    console.log(`[ReviewAgent/PR] Created PR: ${prUrl}`);

    // Post review findings as inline comments
    if (reviewResult.issues.length > 0) {
      await postReviewComments(project.path, prUrl, reviewResult);
    }

    return prUrl;
  } catch (err) {
    console.error(`[ReviewAgent/PR] Failed to create PR:`, err);
    return null;
  }
}

function formatPRBody(goal: Goal, review: ReviewResult): string {
  const lines = [
    '## Summary',
    `Goal: **${goal.title}**`,
    goal.description ? `\n${goal.description.slice(0, 500)}` : '',
    '',
    '## Review',
    `Verdict: **${review.verdict.toUpperCase()}**`,
    `Backend: ${review.backend || 'unknown'}`,
    review.avgConfidence ? `Avg confidence: ${review.avgConfidence}%` : '',
    review.filteredCount ? `Filtered findings: ${review.filteredCount}` : '',
    '',
    review.feedback,
  ];

  if (review.issues.length > 0) {
    lines.push('', '## Findings');
    for (const issue of review.issues) {
      const conf = issue.confidence ? ` (${issue.confidence}%)` : '';
      const loc = issue.file ? ` in \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`` : '';
      lines.push(`- ${issue.severity === 'critical' ? '🔴' : issue.severity === 'nit' ? '🟣' : '🟡'} **${issue.type}**${loc}${conf}: ${issue.detail}`);
    }
  }

  lines.push('', '---', '🤖 Generated by DreamTeam Review Agent');
  return lines.filter(l => l !== undefined).join('\n');
}

async function postReviewComments(
  cwd: string,
  prUrl: string,
  review: ReviewResult,
): Promise<void> {
  // Extract PR number from URL
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) return;

  for (const issue of review.issues.slice(0, 10)) { // Cap at 10 comments
    if (!issue.file) continue;

    const body = `**${issue.severity.toUpperCase()}** (${issue.type})${issue.confidence ? ` — ${issue.confidence}% confidence` : ''}\n\n${issue.detail}`;

    try {
      execSync(
        `gh pr comment ${prMatch[1]} --body "${body.replace(/"/g, '\\"')}" 2>&1`,
        { cwd, encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
      );
    } catch {
      // Non-blocking — skip individual comment failures
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  REVIEW FEEDBACK LOOP (Phase 5)
// ══════════════════════════════════════════════════════════════

/**
 * Format review findings for injection into retry prompts.
 * Called by prompt-builder when a goal was rejected by review.
 */
export function formatReviewFeedbackForRetry(reviewResult: ReviewResult): string {
  const lines = [
    '## Previous Review Feedback (MUST ADDRESS)',
    `The previous attempt was ${reviewResult.verdict === 'reject' ? 'REJECTED' : 'flagged with concerns'} by the code review agent.`,
    `Review backend: ${reviewResult.backend || 'unknown'}`,
    '',
    `**Summary:** ${reviewResult.feedback}`,
  ];

  if (reviewResult.issues.length > 0) {
    lines.push('', '**Specific issues to fix:**');
    for (const issue of reviewResult.issues) {
      const loc = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
      const conf = issue.confidence ? ` [${issue.confidence}% confidence]` : '';
      lines.push(`- [${issue.severity}] ${issue.type}${loc}${conf}: ${issue.detail}`);
    }
  }

  lines.push('', 'You MUST address ALL critical issues listed above before completing the goal.');
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  MAIN REVIEW FUNCTION (router)
// ══════════════════════════════════════════════════════════════

/**
 * Review a completed goal's changes.
 *
 * Routes to the appropriate review backend based on:
 * - Diff size (small → legacy, large → Claude Code)
 * - Goal complexity (complex/auth → dual-gate or Claude Code)
 * - Environment override (DREAMTEAM_REVIEW_BACKEND)
 * - DREAMTEAM_REVIEW_DUAL_GATE=1 for dual-gate mode
 */
export async function reviewGoalCompletion(
  goal: Goal,
  smokeResult: SmokeTestResult | null,
): Promise<ReviewResult> {
  const project = getProject(goal.project);
  if (!project?.path) {
    return {
      verdict: 'approve',
      feedback: 'No project path — skipping review.',
      issues: [],
      costUsd: 0,
    };
  }

  // Archetype file boundary check
  const boundaryViolations = checkArchetypeBoundary(project.path, goal.archetype, goal.id);
  if (boundaryViolations.length > 0) {
    console.log(`[ReviewAgent] Boundary note: ${goal.archetype} goal touched ${boundaryViolations.join(', ')} — passing to review`);
  }

  // Get diff
  const diff = getGoalDiff(project.path, goal.id);
  const diffStat = getGoalDiffStat(project.path, goal.id);

  // No changes? Reject.
  if (!diff && !diffStat) {
    return {
      verdict: 'reject',
      feedback: 'No code changes on branch — agent signaled completion but committed nothing.',
      issues: [{ type: 'incomplete', severity: 'critical', detail: 'Empty diff vs main — no work was committed.' }],
      costUsd: 0,
    };
  }

  const { currentRoutes } = getProjectContext(goal.project);
  const backend = getReviewBackend();
  const dualGate = process.env.DREAMTEAM_REVIEW_DUAL_GATE === '1';
  const goalComplexity = goal.complexity || 'routine';

  console.log(`[ReviewAgent] Reviewing "${goal.title}" (diff=${diff.length} chars, backend=${backend}, complexity=${goalComplexity}, dualGate=${dualGate})`);

  let result: ReviewResult;

  try {
    // Phase 3: Dual-gate for complex/auth goals
    if (dualGate && (goalComplexity === 'complex' || goal.archetype === 'backend')) {
      result = await reviewDualGate(goal, diff, diffStat, project.path, smokeResult, currentRoutes);
    }
    // Route based on backend setting and diff size
    else if (backend === 'claude-code') {
      result = await reviewWithClaudeCode(goal, diff, diffStat, project.path);
    } else if (backend === 'legacy') {
      result = await reviewWithLegacySonnet(goal, diff, diffStat, smokeResult, currentRoutes);
    } else {
      // Auto routing: large diffs or complex goals → Claude Code, small diffs → legacy
      if (diff.length >= LARGE_DIFF_THRESHOLD || goalComplexity === 'complex') {
        result = await reviewWithClaudeCode(goal, diff, diffStat, project.path);
      } else {
        result = await reviewWithLegacySonnet(goal, diff, diffStat, smokeResult, currentRoutes);
      }
    }
  } catch (err) {
    console.error(`[ReviewAgent] Error reviewing goal ${goal.id}:`, err);
    return {
      verdict: 'concern',
      feedback: `Review agent error: ${err}. Flagged as concern — manual check recommended.`,
      issues: [{ type: 'code_quality', severity: 'warning', detail: `Review infrastructure error: ${err}` }],
      costUsd: 0,
    };
  }

  // Phase 4: Optionally create GitHub PR with review findings
  if (process.env.DREAMTEAM_REVIEW_CREATE_PR === '1' && result.verdict !== 'approve') {
    try {
      const prUrl = await createReviewPR(goal, result);
      if (prUrl) {
        result.feedback += ` PR: ${prUrl}`;
      }
    } catch (err) {
      console.log(`[ReviewAgent] PR creation failed: ${err}`);
    }
  }

  console.log(`[ReviewAgent] Result: ${result.verdict} (backend=${result.backend}, cost=$${result.costUsd?.toFixed(4)}, findings=${result.issues.length}${result.filteredCount ? `, filtered=${result.filteredCount}` : ''})`);

  return result;
}
