/**
 * Roadmap Module — Loads and formats ROADMAP.md files per project.
 *
 * Each project has a ROADMAP.md at its root with structured sections:
 * Vision, Current Phase, Next Steps, Tech Debt, Blockers.
 *
 * The Director uses concise roadmap summaries to propose aligned goals.
 * Agents get roadmap context via archetype docs when relevant.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getProject, listProjectNames } from '../projects/registry.js';

// ── Template ──────────────────────────────────────────────

export const ROADMAP_TEMPLATE = `# ROADMAP — {PROJECT_NAME}

## Vision
One-sentence description of what this project becomes when "done."

## Current Phase
What phase of development is this project in? What's the focus right now?

## Next Steps (priority order)
1. **[HIGH]** First priority item — brief description
2. **[HIGH]** Second priority item — brief description
3. **[MEDIUM]** Third item — brief description
4. **[LOW]** Fourth item — brief description

## Tech Debt
- Item that needs cleanup or refactoring
- Known shortcuts that should be revisited

## Blockers / At-Risk
- External dependency or decision that blocks progress
- Risk that could derail current phase

## Completed (recent)
- Recently finished milestone — date
`;

// ── Loader ────────────────────────────────────────────────

/**
 * Load ROADMAP.md from a project root. Returns null if not found.
 * Caps at 3000 chars to avoid bloating context.
 */
export function loadRoadmapDoc(projectName: string): string | null {
  try {
    const project = getProject(projectName);
    const roadmapPath = join(project.path, 'ROADMAP.md');
    if (existsSync(roadmapPath)) {
      const content = readFileSync(roadmapPath, 'utf-8');
      return content.slice(0, 3000);
    }
  } catch { /* project not found */ }
  return null;
}

// ── Director Context ──────────────────────────────────────

/**
 * Build a concise roadmap summary for the Director prompt.
 * Extracts "Next Steps" and "Blockers" sections from each project's ROADMAP.md.
 * Returns empty string if no roadmaps exist.
 */
export function getRoadmapContextForDirector(): string {
  const projects = listProjectNames();
  const summaries: string[] = [];

  for (const projectName of projects) {
    const roadmap = loadRoadmapDoc(projectName);
    if (!roadmap) continue;

    // Extract key sections concisely
    const nextSteps = extractSection(roadmap, 'Next Steps');
    const blockers = extractSection(roadmap, 'Blockers');
    const currentPhase = extractSection(roadmap, 'Current Phase');

    const parts: string[] = [`**${projectName}:**`];
    if (currentPhase) parts.push(`  Phase: ${currentPhase.split('\n')[0].trim()}`);
    if (nextSteps) {
      // Take just the first 3 items
      const items = nextSteps.split('\n')
        .filter(l => l.trim().match(/^\d+\.|^-/))
        .slice(0, 3)
        .map(l => `  ${l.trim()}`);
      if (items.length > 0) parts.push(...items);
    }
    if (blockers) {
      const items = blockers.split('\n')
        .filter(l => l.trim().startsWith('-'))
        .slice(0, 2)
        .map(l => `  BLOCKER: ${l.trim().replace(/^-\s*/, '')}`);
      if (items.length > 0) parts.push(...items);
    }

    if (parts.length > 1) {
      summaries.push(parts.join('\n'));
    }
  }

  if (summaries.length === 0) return '';

  return `## Project Roadmaps
${summaries.join('\n')}`;
}

/**
 * Extract a section from markdown by heading name.
 * Returns the content between the heading and the next heading of same or higher level.
 */
function extractSection(markdown: string, sectionName: string): string | null {
  const regex = new RegExp(`^##\\s+${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$)`, 'm');
  const match = markdown.match(regex);
  return match ? match[1].trim() : null;
}
