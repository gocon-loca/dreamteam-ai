/**
 * PM Agent — Autonomous Product Manager
 *
 * Proactively tests each web-enabled project, detects quality issues,
 * and creates goals with specific, testable acceptance criteria.
 *
 * Design principles:
 * - Playwright for facts ($0), Haiku only when reasoning is needed (~$0.02)
 * - Heuristic-first: most issues are detectable without an LLM
 * - Tight feedback loop: PM verifies completed goals actually fixed the issue
 * - Self-limiting: max 5 PM-created goals at a time to avoid noise
 *
 * Cost per sweep: ~$0-0.05
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runSmokeTests } from './smoke-tests.js';
import type { SmokeTestResult, PMIssue, PMFindings, FlowResult, ConsoleError } from './types.js';
import { getProject, listProjectNames } from '../projects/registry.js';
import {
  getPendingGoals,
  getInProgressGoals,
} from '../orchestration/goal-manager.js';
import { storePendingProposal } from '../orchestration/pending-proposals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/pm');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const MAX_PM_GOALS_ACTIVE = 5;
const SWEEP_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between sweeps

// ── Public API ──────────────────────────────────────────

/**
 * Run a full PM sweep for a single project.
 * Detects issues, creates goals, saves findings.
 */
export async function runPMSweep(projectName: string): Promise<PMFindings> {
  console.log(`[PM] Starting sweep for ${projectName}`);

  // Run smoke tests
  const smokeResults = await runSmokeTests(projectName);

  // Analyze results into issues (heuristic, no LLM)
  const issues = analyzeResults(smokeResults);

  // Filter out issues that already have goals
  const newIssues = filterExistingGoals(issues, projectName);

  // Create goals for new issues (respecting limits)
  const goalsCreated = createGoalsFromIssues(newIssues, projectName);

  // Build and save findings
  const findings: PMFindings = {
    project: projectName,
    timestamp: new Date().toISOString(),
    smokeResults,
    issues,
    goalsCreated,
    costUsd: 0, // Pure heuristic, no LLM
  };

  saveFindingsToFile(findings);

  console.log(`[PM] Sweep complete for ${projectName}: ${issues.length} issues, ${goalsCreated.length} goals created`);
  return findings;
}

/**
 * Run PM sweep for all web-enabled projects.
 */
export async function runPMSweepAll(): Promise<PMFindings[]> {
  const allFindings: PMFindings[] = [];

  for (const name of listProjectNames()) {
    const project = getProject(name);
    if (!project.hasDevServer || !project.devPort) continue;

    // Skip if last sweep was recent
    if (!isSweepDue(name)) {
      console.log(`[PM] Skipping ${name} — last sweep was recent`);
      continue;
    }

    try {
      const findings = await runPMSweep(name);
      allFindings.push(findings);
    } catch (e) {
      console.error(`[PM] Sweep failed for ${name}:`, e);
    }
  }

  return allFindings;
}

/**
 * Get the latest findings for a project.
 */
export function getLatestFindings(project: string): PMFindings | null {
  const filePath = join(DATA_DIR, `${project}-findings.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get PM-generated acceptance criteria relevant to a specific goal.
 * Used by prompt-builder to inject testable criteria into agent prompts.
 */
export function getPMAcceptanceCriteria(project: string, goalTitle: string, goalDescription: string): string | null {
  const findings = getLatestFindings(project);
  if (!findings || findings.issues.length === 0) return null;

  const goalText = `${goalTitle} ${goalDescription}`.toLowerCase();

  // Find issues relevant to this goal
  const relevant = findings.issues.filter(issue => {
    const issueText = `${issue.title} ${issue.description}`.toLowerCase();
    // Check for keyword overlap
    const goalWords = goalText.split(/\s+/).filter(w => w.length > 3);
    const matchCount = goalWords.filter(w => issueText.includes(w)).length;
    return matchCount >= 2 || issue.affectedPages.some(p => goalText.includes(p));
  });

  if (relevant.length === 0) return null;

  const lines = ['## PM Agent Quality Checks', 'After completing this goal, the PM Agent will automatically verify:'];
  for (const issue of relevant.slice(0, 3)) {
    lines.push(`\n### ${issue.title}`);
    for (const criterion of issue.acceptanceCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
  }
  lines.push('\nThese checks will be run automatically. Do NOT declare GOAL_COMPLETE unless these will pass.');

  return lines.join('\n');
}

/**
 * Format findings as a concise Telegram summary.
 */
export function formatPMReport(findings: PMFindings): string {
  const { smokeResults, issues, goalsCreated } = findings;
  const s = smokeResults.summary;

  const lines = [
    `PM Sweep: ${findings.project}`,
    `Pages: ${s.pagesPassed}/${s.pagesChecked} OK | Flows: ${s.flowsPassed}/${s.flowsChecked} OK | Console errors: ${s.consoleErrorCount}`,
  ];

  if (issues.length === 0) {
    lines.push('No issues detected.');
  } else {
    const critical = issues.filter(i => i.severity === 'critical');
    const high = issues.filter(i => i.severity === 'high');
    const medium = issues.filter(i => i.severity === 'medium');

    if (critical.length) lines.push(`CRITICAL (${critical.length}): ${critical.map(i => i.title).join(', ')}`);
    if (high.length) lines.push(`HIGH (${high.length}): ${high.map(i => i.title).join(', ')}`);
    if (medium.length) lines.push(`MEDIUM (${medium.length}): ${medium.map(i => i.title).join(', ')}`);
  }

  if (goalsCreated.length > 0) {
    lines.push(`Goals created: ${goalsCreated.length}`);
  }

  return lines.join('\n');
}

// ── Issue Detection (Heuristic) ──────────────────────────

function analyzeResults(results: SmokeTestResult): PMIssue[] {
  const issues: PMIssue[] = [];
  let issueId = 0;

  // 1. Server errors (500+)
  for (const page of results.pages) {
    if (page.status >= 500) {
      issues.push({
        id: `pm-${++issueId}`,
        severity: 'critical',
        category: 'server-error',
        title: `Server error on ${page.path}`,
        description: `${page.path} returns HTTP ${page.status}. ${page.error || ''}`.trim(),
        affectedPages: [page.path],
        acceptanceCriteria: [
          `Navigate to ${page.path} — page returns HTTP 200`,
          `Page has meaningful content (not error page)`,
          `No server errors in dev console`,
        ],
      });
    }
  }

  // 2. Pages that failed to load
  for (const page of results.pages) {
    if (page.status === 0 && page.error) {
      issues.push({
        id: `pm-${++issueId}`,
        severity: 'critical',
        category: 'server-error',
        title: `Page failed to load: ${page.path}`,
        description: `${page.path} could not be loaded: ${page.error}`,
        affectedPages: [page.path],
        acceptanceCriteria: [
          `Navigate to ${page.path} — page loads successfully`,
          `No timeout or connection errors`,
        ],
      });
    }
  }

  // 3. Empty pages (loaded but no content)
  for (const page of results.pages) {
    if (page.status >= 200 && page.status < 400 && !page.hasContent) {
      issues.push({
        id: `pm-${++issueId}`,
        severity: 'medium',
        category: 'empty-page',
        title: `Empty page: ${page.path}`,
        description: `${page.path} loads but has minimal/no content`,
        affectedPages: [page.path],
        acceptanceCriteria: [
          `Navigate to ${page.path} — page displays meaningful content`,
          `Page has clear purpose and is not a placeholder`,
        ],
      });
    }
  }

  // 4. Failed flows
  for (const flow of results.flows) {
    if (!flow.passed) {
      const failedStep = flow.steps.find(s => !s.passed);
      issues.push({
        id: `pm-${++issueId}`,
        severity: 'critical',
        category: 'broken-flow',
        title: `${flow.name} flow broken`,
        description: `The ${flow.name} flow fails at: ${flow.failedAt || failedStep?.action || 'unknown'}. Error: ${flow.error || failedStep?.detail || 'unknown'}`,
        affectedPages: flow.name === 'sign-in' ? ['/login'] : [],
        acceptanceCriteria: buildFlowCriteria(flow),
      });
    }
  }

  // 5. Console errors (grouped by page)
  const errorsByPage = new Map<string, ConsoleError[]>();
  for (const err of results.consoleErrors) {
    const existing = errorsByPage.get(err.page) || [];
    existing.push(err);
    errorsByPage.set(err.page, existing);
  }
  for (const [pagePath, errors] of errorsByPage) {
    // Skip common noise
    const significantErrors = errors.filter(e =>
      !e.message.includes('favicon') &&
      !e.message.includes('manifest') &&
      !e.message.includes('devIndicators')
    );
    if (significantErrors.length === 0) continue;

    issues.push({
      id: `pm-${++issueId}`,
      severity: significantErrors.length > 3 ? 'high' : 'medium',
      category: 'console-error',
      title: `Console errors on ${pagePath}`,
      description: `${significantErrors.length} console error(s) on ${pagePath}: ${significantErrors[0].message.slice(0, 100)}`,
      affectedPages: [pagePath],
      acceptanceCriteria: [
        `Navigate to ${pagePath} — zero console.error messages`,
        `No unhandled exceptions or failed API calls`,
      ],
    });
  }

  // 6. Slow pages (>5s)
  for (const page of results.pages) {
    if (page.loadTimeMs > 5000 && page.status >= 200) {
      issues.push({
        id: `pm-${++issueId}`,
        severity: 'low',
        category: 'slow-load',
        title: `Slow page: ${page.path} (${Math.round(page.loadTimeMs / 1000)}s)`,
        description: `${page.path} took ${page.loadTimeMs}ms to load`,
        affectedPages: [page.path],
        acceptanceCriteria: [
          `Navigate to ${page.path} — page loads in under 3 seconds`,
        ],
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return issues;
}

function buildFlowCriteria(flow: FlowResult): string[] {
  const criteria: string[] = [];

  if (flow.name === 'sign-in') {
    criteria.push(
      'Navigate to /login — login page loads with email and password inputs',
      'Enter valid test credentials and click Sign In',
      'User is redirected to /dashboard within 5 seconds',
      'No error messages displayed during sign-in',
      'Dashboard page renders with user-specific content',
    );
  } else if (flow.name === 'create-world') {
    criteria.push(
      'Navigate to world creation page',
      'Fill in world name and submit',
      'API returns HTTP 2xx success response',
      'World appears in the worlds/communities list',
      'No "permission denied" or other error messages',
    );
  } else {
    // Generic flow criteria from steps
    for (const step of flow.steps) {
      criteria.push(`${step.action} — succeeds without errors`);
    }
  }

  return criteria;
}

// ── Goal Creation ──────────────────────────────────────────

function filterExistingGoals(issues: PMIssue[], project: string): PMIssue[] {
  const pending = getPendingGoals().filter(g => g.project === project);
  const inProgress = getInProgressGoals().filter(g => g.project === project);
  const existingGoals = [...pending, ...inProgress];

  return issues.filter(issue => {
    const issueWords = issue.title.toLowerCase().split(/\s+/);
    return !existingGoals.some(goal => {
      const goalText = `${goal.title} ${goal.description || ''}`.toLowerCase();
      // Check if enough words match to be a duplicate
      const matchCount = issueWords.filter(w => w.length > 3 && goalText.includes(w)).length;
      return matchCount >= 2;
    });
  });
}

function createGoalsFromIssues(issues: PMIssue[], project: string): string[] {
  const proposedIds: string[] = [];

  // Check how many PM goals already exist
  const pending = getPendingGoals().filter(g => g.project === project);
  const pmGoalCount = pending.filter(g =>
    g.title.startsWith('[PM]') || g.source === 'pm-agent'
  ).length;

  if (pmGoalCount >= MAX_PM_GOALS_ACTIVE) {
    console.log(`[PM] Already ${pmGoalCount} PM goals active for ${project} — skipping`);
    return [];
  }

  const budget = MAX_PM_GOALS_ACTIVE - pmGoalCount;

  // Only propose goals for critical and high severity issues
  const worthCreating = issues.filter(i => i.severity === 'critical' || i.severity === 'high');

  for (const issue of worthCreating.slice(0, budget)) {
    try {
      const description = [
        `## Issue detected by PM Agent`,
        `**Severity:** ${issue.severity}`,
        `**Category:** ${issue.category}`,
        `**Description:** ${issue.description}`,
        '',
        `## Affected Pages`,
        ...issue.affectedPages.map(p => `- ${p}`),
        '',
        `## Acceptance Criteria`,
        ...issue.acceptanceCriteria.map(c => `- [ ] ${c}`),
        '',
        `The PM Agent will automatically re-run these checks after goal completion.`,
        `Do NOT declare GOAL_COMPLETE unless all criteria above are met.`,
      ].join('\n');

      const title = `[PM] Fix: ${issue.title}`;

      // Store proposal for Telegram approval instead of auto-creating
      const proposal = storePendingProposal({ source: 'pm-agent', project, title, description });
      proposedIds.push(proposal.id);
      console.log(`[PM] Proposed goal (awaiting approval): ${title}`);
    } catch (e) {
      console.error(`[PM] Failed to propose goal for ${issue.title}:`, e);
    }
  }

  return proposedIds;
}

// ── Persistence ──────────────────────────────────────────

function saveFindingsToFile(findings: PMFindings): void {
  const filePath = join(DATA_DIR, `${findings.project}-findings.json`);
  writeFileSync(filePath, JSON.stringify(findings, null, 2));
}

function isSweepDue(project: string): boolean {
  const findings = getLatestFindings(project);
  if (!findings) return true;
  const elapsed = Date.now() - new Date(findings.timestamp).getTime();
  return elapsed >= SWEEP_COOLDOWN_MS;
}
