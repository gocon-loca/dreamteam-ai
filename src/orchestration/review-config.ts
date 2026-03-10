/**
 * Review Configuration — REVIEW.md management per project (Phase 2)
 *
 * Generates and maintains REVIEW.md files in each managed project.
 * REVIEW.md contains review-only rules that Claude Code reads during code review
 * but that don't clutter the general CLAUDE.md instructions.
 *
 * Rules are customized per project based on:
 * - Project type (web app, API, CLI, etc.)
 * - Common rejection patterns from LESSONS.md
 * - User-defined overrides
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { getProject, listProjectNames } from '../projects/registry.js';

// ── Types ──────────────────────────────────────────────────

interface ReviewRules {
  alwaysCheck: string[];
  skip: string[];
  projectSpecific: string[];
}

// ── Core Rules (apply to all projects) ─────────────────────

const CORE_ALWAYS_CHECK: string[] = [
  'No hardcoded fake data (names like "Sarah Johnson", "John Smith", Lorem ipsum, placeholder emails)',
  'No console.log debugging leftovers in production code (console.error in catch blocks is OK)',
  'No unused imports or dead code introduced by the change',
  'Changes match the goal description — no scope creep',
  'New files are properly imported and referenced',
  'No secrets, API keys, or credentials in committed code',
  'Error handling exists for external calls (API, DB, filesystem)',
];

const CORE_SKIP: string[] = [
  'Formatting-only changes (whitespace, semicolons, quotes)',
  'Lock file changes (package-lock.json, pnpm-lock.yaml, yarn.lock)',
  'Auto-generated files (dist/, build/, .next/, __pycache__/)',
  'Changes to .gitignore or .eslintrc that don\'t affect behavior',
];

// ── Project-Type Rules ─────────────────────────────────────

function getWebAppRules(): string[] {
  return [
    'New pages/routes have proper error boundaries',
    'Form inputs have validation',
    'API endpoints return appropriate HTTP status codes',
    'No XSS vectors (unsanitized HTML injection, dangerouslySetInnerHTML without sanitization)',
    'Mobile responsiveness considered for UI changes',
    'New routes added to navigation if user-facing',
  ];
}

function getAPIRules(): string[] {
  return [
    'New endpoints have authentication/authorization middleware',
    'Database migrations are backward-compatible (additive, not destructive)',
    'API request/response shapes match TypeScript types or schemas',
    'Rate limiting or input validation on public endpoints',
    'Database queries are parameterized (no SQL injection)',
  ];
}

function getCLIRules(): string[] {
  return [
    'Help text updated for new commands/flags',
    'Error messages are actionable (tell user what to do, not just what failed)',
    'Exit codes follow conventions (0=success, 1=error, 2=usage)',
  ];
}

function getTypeScriptRules(): string[] {
  return [
    'No `any` types unless explicitly justified',
    'Async functions have proper error handling (try/catch or .catch())',
    'New exports are added to barrel files (index.ts) if the project uses them',
  ];
}

function getPythonRules(): string[] {
  return [
    'Type hints on public functions',
    'No bare except clauses — use specific exception types',
    'New dependencies added to requirements.txt or pyproject.toml',
  ];
}

// ── Lessons Extraction ─────────────────────────────────────

/**
 * Extract recurring rejection patterns from a project's LESSONS.md
 * to generate project-specific review rules.
 */
function extractLessonPatterns(projectPath: string): string[] {
  const lessonsPath = join(projectPath, 'LESSONS.md');
  if (!existsSync(lessonsPath)) return [];

  try {
    const content = readFileSync(lessonsPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.startsWith('- **'));
    const patterns: Record<string, number> = {};

    for (const line of lines) {
      // Extract the gate and reason
      const match = line.match(/\[(\w[\w-]*)\]\s*(.+?):\s*(.+)/);
      if (match) {
        const reason = match[3].trim().slice(0, 100);
        patterns[reason] = (patterns[reason] || 0) + 1;
      }
    }

    // Return patterns that appeared 2+ times (recurring issues)
    return Object.entries(patterns)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => `${pattern} (rejected ${count}x)`);
  } catch {
    return [];
  }
}

// ── REVIEW.md Generation ───────────────────────────────────

/**
 * Generate REVIEW.md content for a project.
 */
function generateReviewMd(projectName: string): string {
  const project = getProject(projectName);
  const rules: ReviewRules = {
    alwaysCheck: [...CORE_ALWAYS_CHECK],
    skip: [...CORE_SKIP],
    projectSpecific: [],
  };

  // Add project-type rules
  if (project.hasDevServer) {
    rules.alwaysCheck.push(...getWebAppRules());
  }

  // Detect project language/framework
  try {
    if (existsSync(join(project.path, 'tsconfig.json')) || existsSync(join(project.path, 'package.json'))) {
      rules.alwaysCheck.push(...getTypeScriptRules());
    }
    if (existsSync(join(project.path, 'requirements.txt')) || existsSync(join(project.path, 'pyproject.toml'))) {
      rules.alwaysCheck.push(...getPythonRules());
    }
    if (existsSync(join(project.path, 'Dockerfile')) || existsSync(join(project.path, 'docker-compose.yml'))) {
      rules.skip.push('Dockerfile changes that only update base image versions');
    }

    // Check for API-related files
    const hasAPI = existsSync(join(project.path, 'src/api')) ||
                   existsSync(join(project.path, 'api')) ||
                   existsSync(join(project.path, 'routes'));
    if (hasAPI) {
      rules.alwaysCheck.push(...getAPIRules());
    }

    // Check for CLI
    const isCLI = existsSync(join(project.path, 'bin')) ||
                  existsSync(join(project.path, 'cli'));
    if (isCLI) {
      rules.alwaysCheck.push(...getCLIRules());
    }
  } catch { /* detection failed — use defaults */ }

  // Add patterns from LESSONS.md
  const lessonPatterns = extractLessonPatterns(project.path);
  if (lessonPatterns.length > 0) {
    rules.projectSpecific.push(...lessonPatterns);
  }

  // Deduplicate
  rules.alwaysCheck = [...new Set(rules.alwaysCheck)];
  rules.skip = [...new Set(rules.skip)];

  // Build REVIEW.md content
  const sections: string[] = [
    '# Code Review Rules',
    '',
    '> Auto-generated by DreamTeam. Edit to customize review behavior.',
    '> Claude Code reads this file during code reviews for project-specific guidance.',
    '',
    '## Always Check',
    '',
    ...rules.alwaysCheck.map(r => `- ${r}`),
    '',
    '## Skip',
    '',
    ...rules.skip.map(r => `- ${r}`),
  ];

  if (rules.projectSpecific.length > 0) {
    sections.push(
      '',
      '## Known Issues (from past rejections)',
      '',
      ...rules.projectSpecific.map(r => `- ${r}`),
    );
  }

  sections.push(
    '',
    '## Severity Guide',
    '',
    '- **Critical (reject)**: Bugs, security issues, hardcoded fake data, broken runtime behavior',
    '- **Warning (concern)**: Scope creep, missing tests, code quality issues',
    '- **Nit**: Style preferences, minor improvements, documentation gaps',
  );

  return sections.join('\n') + '\n';
}

// ── Public API ─────────────────────────────────────────────

/**
 * Ensure REVIEW.md exists in a project. Creates if missing.
 * Does NOT overwrite existing REVIEW.md (user may have customized it).
 * Regenerates if the file is older than 7 days and has the auto-generated header.
 */
export function ensureReviewMd(projectName: string): void {
  const project = getProject(projectName);
  if (!project?.path) return;

  const reviewPath = join(project.path, 'REVIEW.md');

  if (existsSync(reviewPath)) {
    // Check if it's auto-generated and stale (>7 days)
    try {
      const stat = statSync(reviewPath);
      const ageMs = Date.now() - stat.mtimeMs;
      const sevenDays = 7 * 24 * 60 * 60 * 1000;

      if (ageMs > sevenDays) {
        const content = readFileSync(reviewPath, 'utf-8');
        if (content.includes('Auto-generated by DreamTeam')) {
          console.log(`[ReviewConfig] Regenerating stale REVIEW.md for ${projectName}`);
          writeFileSync(reviewPath, generateReviewMd(projectName));
        }
      }
    } catch { /* stat failed — leave as is */ }
    return;
  }

  // Create new REVIEW.md
  console.log(`[ReviewConfig] Creating REVIEW.md for ${projectName}`);
  writeFileSync(reviewPath, generateReviewMd(projectName));
}

/**
 * Force-regenerate REVIEW.md for a project, incorporating latest LESSONS.md patterns.
 */
export function regenerateReviewMd(projectName: string): string {
  const project = getProject(projectName);
  if (!project?.path) throw new Error(`Project ${projectName} not found`);

  const content = generateReviewMd(projectName);
  writeFileSync(join(project.path, 'REVIEW.md'), content);
  return content;
}

/**
 * Ensure REVIEW.md exists in all registered projects.
 */
export function ensureAllReviewMds(): void {
  for (const name of listProjectNames()) {
    try {
      ensureReviewMd(name);
    } catch (err) {
      console.error(`[ReviewConfig] Failed for ${name}:`, err);
    }
  }
}
