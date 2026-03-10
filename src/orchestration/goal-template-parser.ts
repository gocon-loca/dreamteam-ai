/**
 * Goal Template Parser — Parses structured goal templates from goal-templates.md
 *
 * Design-research Phase 2 generates a goal-templates.md file with structured
 * goal definitions. This module parses those templates into GoalTemplate objects
 * and creates goals from them.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { addGoal } from './goal-crud.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('goal-template-parser');

// ── Types ──────────────────────────────────────────────────

export interface GoalTemplate {
  title: string;
  description: string;
  archetype: string;
  testCommands: string[];
  priority: number;
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Parse goal templates from a goal-templates.md file content.
 *
 * Expected format (each template separated by ---GOAL_TEMPLATE---):
 * ```
 * ---GOAL_TEMPLATE---
 * TITLE: Redesign dashboard layout with card-based grid
 * ARCHETYPE: frontend
 * PRIORITY: 1
 * DESCRIPTION:
 * Implement the new dashboard layout using...
 *
 * TEST_COMMANDS:
 * - curl -sf http://localhost:3000/dashboard | grep -q 'grid'
 * - test -f src/components/DashboardCard.tsx
 * ---GOAL_TEMPLATE---
 * ```
 *
 * Also supports simpler markdown heading format:
 * ```
 * ## 1. Redesign dashboard layout
 * **Archetype:** frontend
 *
 * Description text here...
 *
 * TEST_COMMANDS:
 * - command1
 * - command2
 * ```
 */
export function parseGoalTemplates(content: string): GoalTemplate[] {
  const templates: GoalTemplate[] = [];

  // Try structured ---GOAL_TEMPLATE--- format first
  const structuredBlocks = content.split('---GOAL_TEMPLATE---').filter(b => b.trim());

  if (structuredBlocks.length > 1 || (structuredBlocks.length === 1 && content.includes('---GOAL_TEMPLATE---'))) {
    for (const block of structuredBlocks) {
      const template = parseStructuredBlock(block.trim());
      if (template) templates.push(template);
    }
    return templates;
  }

  // Fall back to markdown heading format
  const headingBlocks = content.split(/^##\s+/m).filter(b => b.trim());
  let priority = 1;

  for (const block of headingBlocks) {
    const template = parseMarkdownBlock(block.trim(), priority);
    if (template) {
      templates.push(template);
      priority++;
    }
  }

  return templates;
}

function parseStructuredBlock(block: string): GoalTemplate | null {
  if (!block) return null;

  const titleMatch = block.match(/^TITLE:\s*(.+)$/m);
  const archetypeMatch = block.match(/^ARCHETYPE:\s*(.+)$/m);
  const priorityMatch = block.match(/^PRIORITY:\s*(\d+)$/m);
  const descMatch = block.match(/^DESCRIPTION:\s*\n([\s\S]*?)(?=\nTEST_COMMANDS:|\n---GOAL_TEMPLATE---|$)/m);
  const testMatch = block.match(/TEST_COMMANDS:\s*\n([\s\S]*?)(?=\n---GOAL_TEMPLATE---|$)/m);

  if (!titleMatch) return null;

  const testCommands: string[] = [];
  if (testMatch) {
    for (const line of testMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const cmd = trimmed.slice(2).trim();
        if (cmd.length > 0) testCommands.push(cmd);
      }
    }
  }

  return {
    title: titleMatch[1].trim(),
    description: descMatch?.[1]?.trim() || '',
    archetype: archetypeMatch?.[1]?.trim().toLowerCase() || 'frontend',
    testCommands,
    priority: priorityMatch ? parseInt(priorityMatch[1], 10) : 99,
  };
}

function parseMarkdownBlock(block: string, defaultPriority: number): GoalTemplate | null {
  if (!block) return null;

  // First line is the title (after ## was stripped)
  const lines = block.split('\n');
  const titleLine = lines[0].trim();
  if (!titleLine) return null;

  // Strip leading number "1. " from title
  const title = titleLine.replace(/^\d+\.\s*/, '').trim();
  if (!title) return null;

  // Extract archetype from **Archetype:** line
  const archetypeMatch = block.match(/\*\*Archetype:\*\*\s*(\w+)/i);
  const archetype = archetypeMatch?.[1]?.toLowerCase() || 'frontend';

  // Extract description (everything between title and TEST_COMMANDS)
  const descMatch = block.match(/\n([\s\S]*?)(?=\nTEST_COMMANDS:|$)/);
  let description = descMatch?.[1]?.trim() || '';
  // Remove archetype line from description
  description = description.replace(/\*\*Archetype:\*\*\s*\w+\s*/i, '').trim();

  // Extract TEST_COMMANDS
  const testMatch = block.match(/TEST_COMMANDS:\s*\n([\s\S]*?)$/m);
  const testCommands: string[] = [];
  if (testMatch) {
    for (const line of testMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const cmd = trimmed.slice(2).trim();
        if (cmd.length > 0) testCommands.push(cmd);
      }
    }
  }

  return {
    title,
    description,
    archetype,
    testCommands,
    priority: defaultPriority,
  };
}

// ── Goal Creation ──────────────────────────────────────────

/**
 * Create goals from parsed templates.
 * Returns array of created goal IDs.
 */
export function createGoalsFromTemplates(
  project: string,
  templates: GoalTemplate[],
  options?: {
    /** If set, goals after the first will depend on the previous goal */
    chainDependencies?: boolean;
    /** Source tag for created goals */
    source?: string;
  },
): string[] {
  const ids: string[] = [];

  // Sort by priority
  const sorted = [...templates].sort((a, b) => a.priority - b.priority);

  for (const template of sorted) {
    let description = template.description;

    // Append TEST_COMMANDS block if present
    if (template.testCommands.length > 0) {
      description += `\n\nTEST_COMMANDS:\n${template.testCommands.map(c => `- ${c}`).join('\n')}`;
    }

    const goal = addGoal(
      project,
      template.title,
      description,
      options?.source || 'design-research',
    );

    ids.push(goal.id);
    log.info(`Created goal from template: "${template.title}" (${goal.id})`);
  }

  return ids;
}

/**
 * Load and parse goal templates from a project's docs/design-research/goal-templates.md.
 * Returns null if the file doesn't exist.
 */
export function loadProjectGoalTemplates(projectPath: string): GoalTemplate[] | null {
  const templatePath = join(projectPath, 'docs/design-research/goal-templates.md');
  if (!existsSync(templatePath)) return null;

  try {
    const content = readFileSync(templatePath, 'utf-8');
    return parseGoalTemplates(content);
  } catch (err) {
    log.error('Failed to load goal templates', err);
    return null;
  }
}
