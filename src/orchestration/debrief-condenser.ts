/**
 * Debrief Condenser — Compresses old debriefs into per-project summaries.
 *
 * With 350+ debrief files, loading and scoring all of them on every prompt build
 * is wasteful. This module periodically condenses old debriefs into a single
 * project-level summary file that captures the most useful patterns.
 *
 * Strategy:
 * - Keep the last N debriefs per project as-is (they're the most contextually relevant)
 * - Condense older debriefs into data/condensed/{project}.json with extracted patterns
 * - The condensed summary is injected into prompts alongside recent debriefs
 * - Runs as a periodic task (e.g., daily during digest generation)
 *
 * Cost: $0 — pure string processing, no LLM calls.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { StructuredDebrief } from './goal-manager.js';
import { getRecentDebriefs } from './goal-manager.js';
import { getAllProjects } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const CONDENSED_DIR = join(DATA_DIR, 'condensed');

/** Keep this many recent debriefs per project uncondesed */
const KEEP_RECENT = 20;

export interface CondensedProjectMemory {
  project: string;
  updatedAt: string;
  totalDebriefs: number;
  /** Common patterns that recur across debriefs */
  commonPatterns: string[];
  /** Known broken areas (recurring "broken" fields) */
  knownIssues: string[];
  /** Effective techniques (from "working" fields of successful debriefs) */
  workingTechniques: string[];
  /** Frequently mentioned files/components */
  hotFiles: string[];
}

/**
 * Extract the most common meaningful phrases from a list of strings.
 * Returns top N phrases by frequency.
 */
function extractCommonPhrases(texts: string[], topN: number = 5): string[] {
  const freq = new Map<string, number>();

  for (const text of texts) {
    if (!text || text === 'none' || text === 'None' || text.length < 5) continue;

    // Normalize and split into meaningful chunks
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s/.-]/g, ' ').trim();

    // Extract 2-4 word phrases
    const words = normalized.split(/\s+/).filter(w => w.length > 2);
    for (let len = 2; len <= Math.min(4, words.length); len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        freq.set(phrase, (freq.get(phrase) || 0) + 1);
      }
    }
  }

  // Filter to phrases that appear more than once, sort by frequency
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase, count]) => `${phrase} (${count}x)`);
}

/**
 * Extract file/component references from debrief text.
 */
function extractFileReferences(texts: string[]): string[] {
  const freq = new Map<string, number>();
  const filePattern = /(?:[\w-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|py|vue|svelte|css|scss|html|json|yaml|yml|md)/g;

  for (const text of texts) {
    if (!text) continue;
    const matches = text.match(filePattern);
    if (matches) {
      for (const m of matches) {
        freq.set(m, (freq.get(m) || 0) + 1);
      }
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => `${file} (${count}x)`);
}

/**
 * Condense all debriefs for a project into a summary.
 * Keeps the most recent KEEP_RECENT debriefs intact.
 */
export function condenseProject(project: string): CondensedProjectMemory | null {
  const allDebriefs = getRecentDebriefs({ project });
  if (allDebriefs.length <= KEEP_RECENT) {
    // Not enough debriefs to condense
    return null;
  }

  // Debriefs come newest-first — skip the recent ones, condense the rest
  const oldDebriefs = allDebriefs.slice(KEEP_RECENT);

  const workingTexts = oldDebriefs.map(d => d.working).filter(Boolean);
  const brokenTexts = oldDebriefs.map(d => d.broken).filter(Boolean);
  const allTexts = [
    ...oldDebriefs.map(d => d.working),
    ...oldDebriefs.map(d => d.broken),
    ...oldDebriefs.map(d => d.next),
    ...oldDebriefs.map(d => d.verified),
  ].filter(Boolean);

  const condensed: CondensedProjectMemory = {
    project,
    updatedAt: new Date().toISOString(),
    totalDebriefs: allDebriefs.length,
    commonPatterns: extractCommonPhrases(allTexts, 8),
    knownIssues: extractCommonPhrases(brokenTexts, 5),
    workingTechniques: extractCommonPhrases(workingTexts, 5),
    hotFiles: extractFileReferences(allTexts),
  };

  return condensed;
}

/**
 * Run condensation for all projects. Saves results to data/condensed/.
 */
export function condenseAll(): Map<string, CondensedProjectMemory> {
  const projects = Object.keys(getAllProjects());
  const results = new Map<string, CondensedProjectMemory>();

  if (!existsSync(CONDENSED_DIR)) {
    mkdirSync(CONDENSED_DIR, { recursive: true });
  }

  for (const project of projects) {
    const condensed = condenseProject(project);
    if (condensed) {
      writeFileSync(
        join(CONDENSED_DIR, `${project}.json`),
        JSON.stringify(condensed, null, 2),
      );
      results.set(project, condensed);
      console.log(`[Condenser] ${project}: condensed ${condensed.totalDebriefs} debriefs (${condensed.commonPatterns.length} patterns, ${condensed.hotFiles.length} hot files)`);
    }
  }

  return results;
}

/**
 * Load the condensed memory for a project (if it exists).
 */
export function loadCondensedMemory(project: string): CondensedProjectMemory | null {
  const filePath = join(CONDENSED_DIR, `${project}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format condensed memory into a prompt-ready string.
 * Compact format to minimize token usage.
 */
export function formatCondensedMemory(memory: CondensedProjectMemory): string {
  const parts: string[] = [`## Project Memory (${memory.totalDebriefs} past goals)`];

  if (memory.knownIssues.length > 0) {
    parts.push(`Known issues: ${memory.knownIssues.join(', ')}`);
  }

  if (memory.workingTechniques.length > 0) {
    parts.push(`What works: ${memory.workingTechniques.join(', ')}`);
  }

  if (memory.hotFiles.length > 0) {
    parts.push(`Frequently modified: ${memory.hotFiles.slice(0, 5).join(', ')}`);
  }

  return parts.join('\n');
}
