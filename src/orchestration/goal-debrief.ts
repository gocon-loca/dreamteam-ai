/**
 * Goal debrief parsing, lesson recording, and debrief retrieval.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getProject } from '../projects/registry.js';
import type { Goal, StructuredDebrief } from './goal-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const DEBRIEFS_DIR = join(DATA_DIR, 'debriefs');

/**
 * Record a lesson from a rejected goal into the project's LESSONS.md.
 * Agents read this file on future attempts to avoid repeating mistakes.
 */
export function recordLesson(goal: Goal, gate: string, reason: string): void {
  try {
    const project = getProject(goal.project);
    if (!project?.path) return;

    const lessonsPath = join(project.path, 'LESSONS.md');
    const date = new Date().toISOString().slice(0, 10);
    const entry = `\n- **${date}** [${gate}] ${goal.title}: ${reason.slice(0, 300)}\n`;

    if (!existsSync(lessonsPath)) {
      writeFileSync(lessonsPath, `# Lessons\n\nPatterns that caused rejections — do NOT repeat these.\n${entry}`);
    } else {
      appendFileSync(lessonsPath, entry);
    }
  } catch { /* non-blocking — don't let lesson recording break the pipeline */ }
}

/**
 * Parse a DEBRIEF block from agent output.
 *
 * Handles:
 * - Standard format: FIELD: value
 * - Markdown bold: **FIELD:** value or **FIELD**: value
 * - Multiline values (content between field keys)
 * - Fallback: extract from free-form text if no ---DEBRIEF--- block found
 */
export function parseDebrief(output: string): Partial<StructuredDebrief> | null {
  const FIELDS = ['COMMITS', 'WORKING', 'BROKEN', 'VERIFIED', 'TESTS', 'CONFIDENCE', 'NEXT'] as const;

  // Try structured block first
  const match = output.match(/---DEBRIEF---([\s\S]*?)---END_DEBRIEF---/);
  const block = match?.[1] || '';

  if (block) {
    // Build a regex that captures each field's value up to the next field or end of block.
    // Handles optional ** around field names.
    const fieldPattern = FIELDS.map(f => `\\*{0,2}${f}\\*{0,2}`).join('|');
    const extract = (key: string): string => {
      const re = new RegExp(
        `\\*{0,2}${key}\\*{0,2}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${fieldPattern}):|---END_DEBRIEF---|$)`,
      );
      const m = block.match(re);
      // Strip leading/trailing ** and whitespace from captured value
      return m?.[1]?.replace(/^\*{2,}|^\s+|\s+$|\*{2,}$/g, '').trim() || '';
    };

    return {
      commits: extract('COMMITS').split(/[,\n]/).map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean),
      working: extract('WORKING'),
      broken: extract('BROKEN'),
      verified: extract('VERIFIED'),
      tests: extract('TESTS'),
      confidence: extract('CONFIDENCE'),
      next: extract('NEXT'),
    };
  }

  // Fallback: try to extract from free-form output (no ---DEBRIEF--- block)
  // Look for common patterns agents use when they skip the structured format
  const fallback: Partial<StructuredDebrief> = {};
  let foundAny = false;

  // Extract commit hashes (7+ hex chars at line start or after common prefixes)
  const commitMatches = output.match(/\b[0-9a-f]{7,40}\b.*(?:feat|fix|chore|refactor|style|docs|test).*$/gm);
  if (commitMatches?.length) {
    fallback.commits = commitMatches.map(s => s.trim());
    foundAny = true;
  }

  // Extract working/broken from ASSESSMENT block if present
  const assessmentBlock = output.match(/ASSESSMENT:[\s\S]*?(?=GOAL_COMPLETE|ESCALATE:|BLOCKED:|$)/i);
  if (assessmentBlock) {
    const workingMatch = assessmentBlock[0].match(/WORKING_WELL:\s*(.+)/i);
    const needsMatch = assessmentBlock[0].match(/NEEDS_WORK:\s*(.+)/i);
    const confMatch = assessmentBlock[0].match(/CONFIDENCE:\s*(\w+)/i);
    if (workingMatch) { fallback.working = workingMatch[1].trim(); foundAny = true; }
    if (needsMatch) { fallback.broken = needsMatch[1].trim(); foundAny = true; }
    if (confMatch) { fallback.confidence = confMatch[1].trim(); foundAny = true; }
  }

  return foundAny ? fallback : null;
}

/**
 * Get ground-truth commits from git log since a given time
 */
export function getRecentCommits(projectPath: string, since?: Date): string[] {
  try {
    const sinceArg = since ? `--since="${since.toISOString()}"` : '--max-count=10';
    const result = execSync(
      `git log --oneline ${sinceArg}`,
      { cwd: projectPath, encoding: 'utf8', timeout: 10000 }
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get recent debriefs for a project (used by Director and agent prompts)
 */
export function getRecentDebriefs(options: {
  project?: string;
  limit?: number;
} = {}): StructuredDebrief[] {
  try {
    if (!existsSync(DEBRIEFS_DIR)) return [];

    const files = readdirSync(DEBRIEFS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    const debriefs: StructuredDebrief[] = [];
    for (const file of files) {
      if (options.limit && debriefs.length >= options.limit) break;
      try {
        const content = readFileSync(join(DEBRIEFS_DIR, file), 'utf8');
        const d = JSON.parse(content) as StructuredDebrief;
        if (!options.project || d.project === options.project) {
          debriefs.push(d);
        }
      } catch {
        // Skip corrupt files
      }
    }
    return debriefs;
  } catch {
    return [];
  }
}
