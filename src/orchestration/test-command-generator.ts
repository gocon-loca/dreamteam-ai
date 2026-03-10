/**
 * Test Command Generator — Produces behavior-appropriate TEST_COMMANDS.
 *
 * Problem: Goals for runtime bugs (page crashes, API failures, broken buttons)
 * were getting `npm run build` as their TEST_COMMANDS. Build checks can't catch
 * runtime behavioral issues.
 *
 * This module classifies bug categories and generates test commands that
 * actually verify the fix works at runtime.
 */

import { getProject } from '../projects/registry.js';
import type { Goal } from './goal-types.js';

// ── Bug Categories ─────────────────────────────────────────

export type BugCategory =
  | 'build-time'      // Type errors, import failures, syntax errors
  | 'api-behavior'    // API returns wrong data, missing params, 500s
  | 'page-crash'      // Page throws error, blank screen, 500 on route
  | 'ui-interaction'  // Button doesn't work, form doesn't submit
  | 'data-integrity'  // Wrong data in DB, missing records, bad queries
  | 'server-error';   // Server won't start, process crash, config error

const BUILD_PATTERNS = /\b(type\s*error|import\s*(error|fail)|syntax\s*error|cannot\s*find\s*module|compilation|tsc|tsconfig|build\s*(fail|broken|error)|missing\s*export|undeclared|unexpected\s*token)\b/i;
const API_PATTERNS = /\b(api|endpoint|route|fetch|request|response|curl|graphql|rest|404|500|status\s*code|param(eter)?s?\s*(undefined|missing|wrong)|json|payload)\b/i;
const PAGE_PATTERNS = /\b(page\s*(crash|blank|empty|broken|error|500)|something\s*went\s*wrong|white\s*screen|hydration|render(ing)?\s*(fail|error|broken)|blank\s*screen|unhandled\s*error)\b/i;
const UI_PATTERNS = /\b(button|click|submit|form|input|toggle|dropdown|modal|dialog|select|checkbox|radio|drag|swipe|tap|hover|scroll|navigation|tab|menu)\b/i;
const DATA_PATTERNS = /\b(database|db|query|sql|migration|record|row|column|table|insert|update|delete|missing\s*data|wrong\s*data|data\s*(integrity|loss|corrupt))\b/i;
const SERVER_PATTERNS = /\b(server\s*(crash|error|won't\s*start|down)|process\s*(crash|exit)|eaddrinuse|port\s*(in\s*use|conflict)|segfault|oom|out\s*of\s*memory|config(uration)?\s*(error|invalid))\b/i;

/**
 * Classify a goal's bug category based on its title and description.
 */
export function classifyBugCategory(title: string, description?: string): BugCategory {
  const text = `${title} ${description || ''}`;

  // Order matters: more specific patterns first
  if (BUILD_PATTERNS.test(text)) return 'build-time';
  if (PAGE_PATTERNS.test(text)) return 'page-crash';
  if (API_PATTERNS.test(text)) return 'api-behavior';
  if (DATA_PATTERNS.test(text)) return 'data-integrity';
  if (SERVER_PATTERNS.test(text)) return 'server-error';
  if (UI_PATTERNS.test(text)) return 'ui-interaction';

  // Default: if it mentions "fix" or "bug" without matching above, treat as page-crash
  // since that's the most common runtime issue
  if (/\b(fix|bug|broken|issue|regression)\b/i.test(text)) return 'page-crash';

  return 'build-time'; // Safe default — build check is always valid
}

// ── Test Command Generation ────────────────────────────────

/**
 * Generate behavioral test commands based on bug category and project config.
 * Returns shell commands that verify runtime behavior, not just compilation.
 */
export function generateTestCommands(
  category: BugCategory,
  project: string,
  opts?: { port?: number; apiPath?: string }
): string[] {
  let port = opts?.port;
  let hasDevServer = false;

  try {
    const config = getProject(project);
    if (config) {
      port = port ?? config.devPort;
      hasDevServer = config.hasDevServer;
    }
  } catch { /* project not in registry — use defaults */ }

  const baseUrl = port ? `http://localhost:${port}` : null;

  switch (category) {
    case 'build-time':
      return ['pnpm build 2>&1 | tail -5'];

    case 'api-behavior': {
      if (!baseUrl) return ['pnpm build 2>&1 | tail -5'];
      const apiPath = opts?.apiPath || '/api/health';
      return [
        `curl -sf ${baseUrl}${apiPath} -o /dev/null -w '%{http_code}' | grep -E '^(200|201|204)$'`,
      ];
    }

    case 'page-crash': {
      if (!baseUrl) return ['pnpm build 2>&1 | tail -5'];
      return [
        `curl -sf ${baseUrl}/ -o /dev/null -w '%{http_code}' | grep -E '^(200|301|302)$'`,
      ];
    }

    case 'ui-interaction': {
      // UI interactions need a running app — use curl to verify the page loads
      if (!baseUrl) return ['pnpm build 2>&1 | tail -5'];
      return [
        `curl -sf ${baseUrl}/ -o /dev/null -w '%{http_code}' | grep -E '^(200|301|302)$'`,
      ];
    }

    case 'data-integrity':
      return ['pnpm build 2>&1 | tail -5'];

    case 'server-error': {
      if (!baseUrl) return ['pnpm build 2>&1 | tail -5'];
      return [
        `curl -sf ${baseUrl}/ -o /dev/null -w '%{http_code}' | grep -E '^(200|301|302)$'`,
      ];
    }

    default:
      return ['pnpm build 2>&1 | tail -5'];
  }
}

// ── Build-Only Detection ───────────────────────────────────

const BUILD_ONLY_COMMANDS = /^\s*(npm\s+run\s+build|pnpm\s+build|yarn\s+build|npx\s+tsc|tsc\b)/;

/**
 * Detect whether TEST_COMMANDS are build-only (compile checks with no runtime verification).
 * Returns true if ALL commands are build/compile commands and none test runtime behavior.
 */
export function isBuildOnlyTestCommands(commands: string[]): boolean {
  if (commands.length === 0) return false;

  return commands.every(cmd => {
    const trimmed = cmd.trim();
    // Strip cd prefix: `cd /foo && pnpm build` → `pnpm build`
    const withoutCd = trimmed.replace(/^cd\s+\S+\s*&&\s*/, '');
    // Strip output redirection: `pnpm build 2>&1 | tail -5` → `pnpm build`
    const base = withoutCd.replace(/\s*2>&1.*$/, '').replace(/\s*\|.*$/, '').trim();
    return BUILD_ONLY_COMMANDS.test(base);
  });
}

// ── Enrichment ─────────────────────────────────────────────

/**
 * Enrich a goal's TEST_COMMANDS by replacing build-only commands with
 * behavioral test commands when the goal is about a runtime bug.
 *
 * Returns the (possibly modified) goal description with updated TEST_COMMANDS block.
 * If TEST_COMMANDS are already behavioral or the goal is a build-time issue,
 * returns the description unchanged.
 */
export function enrichTestCommands(goal: Goal): string {
  const description = goal.description || '';
  if (!description) return description;

  // Parse existing test commands
  const match = description.match(/TEST_COMMANDS:\s*\n([\s\S]*?)(?:\n\n|\n[A-Z_]+:|\n---|\n##|$)/);
  if (!match) return description; // No TEST_COMMANDS block

  const block = match[1];
  const commands: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const cmd = trimmed.slice(2).trim();
      if (cmd.length > 0) commands.push(cmd);
    }
  }

  if (commands.length === 0) return description;
  if (!isBuildOnlyTestCommands(commands)) return description; // Already behavioral

  // Classify the bug
  const category = classifyBugCategory(goal.title, description);
  if (category === 'build-time') return description; // Build-only is correct for build bugs

  // Generate behavioral commands
  const behavioral = generateTestCommands(category, goal.project);

  // Keep the original build command and append behavioral ones
  const newLines = [
    ...commands.map(c => `- ${c}`),
    ...behavioral
      .filter(c => !commands.some(existing => existing.trim() === c.trim()))
      .map(c => `- ${c}`),
  ];

  const newBlock = newLines.join('\n');
  const fullMatch = match[0];
  // Preserve the trailing delimiter (blank line, section header, etc.)
  const trailingDelimiter = fullMatch.slice(match.input!.indexOf(match[1]) - match.input!.indexOf(fullMatch) + match[1].length);
  const replacement = `TEST_COMMANDS:\n${newBlock}${trailingDelimiter}`;

  return description.replace(fullMatch, replacement);
}
