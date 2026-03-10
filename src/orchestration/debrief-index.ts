/**
 * Debrief Index — Relevance-based debrief lookup for prompt building.
 *
 * Replaces recency-based getRecentDebriefs() with keyword scoring.
 * Scores debrief title, working, broken, and next fields against the
 * current goal's title + description.
 *
 * Cost: $0 (pure string matching, no LLM). ~50ms at current scale (~250 debriefs).
 */

import type { Goal, StructuredDebrief } from './goal-manager.js';
import { getRecentDebriefs } from './goal-manager.js';

// Common English stop words to filter out of keyword extraction
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'its', 'be', 'are', 'was',
  'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'not', 'no', 'so', 'if', 'then', 'than', 'that', 'this', 'these',
  'those', 'what', 'which', 'who', 'whom', 'how', 'when', 'where',
  'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'about',
  'up', 'out', 'into', 'over', 'after', 'before', 'between', 'under',
  'again', 'further', 'once', 'here', 'there', 'also', 'as', 'until',
  // Domain stop words — too generic for goal matching
  'fix', 'add', 'update', 'remove', 'change', 'make', 'set', 'get',
  'use', 'new', 'now', 'still', 'need', 'work', 'working', 'broken',
  'goal', 'project', 'app', 'page', 'file', 'code', 'none',
]);

/** Max chars per debrief field injected into prompts (prevents prompt bloat) */
const MAX_WORKING_CHARS = 200;
const MAX_BROKEN_CHARS = 150;
const MAX_NEXT_CHARS = 150;

/**
 * Extract meaningful keywords from text.
 * Lowercases, removes punctuation, deduplicates, filters stop words.
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  return [...new Set(words)];
}

/**
 * Score how relevant a debrief is to a set of goal keywords.
 *
 * Weighting:
 *   - title match: 3x (most signal — debrief title describes what was done)
 *   - working/broken: 2x (describes systems touched)
 *   - next: 1x (describes follow-up work)
 */
export function scoreRelevance(goalKeywords: string[], debrief: StructuredDebrief): number {
  if (goalKeywords.length === 0) return 0;

  const titleKeywords = extractKeywords(debrief.title);
  const workingKeywords = extractKeywords(debrief.working);
  const brokenKeywords = extractKeywords(debrief.broken);
  const nextKeywords = extractKeywords(debrief.next);

  let score = 0;

  for (const kw of goalKeywords) {
    if (titleKeywords.includes(kw)) score += 3;
    if (workingKeywords.includes(kw)) score += 2;
    if (brokenKeywords.includes(kw)) score += 2;
    if (nextKeywords.includes(kw)) score += 1;
  }

  return score;
}

/**
 * Truncate a debrief field to maxLen chars, ending at a word boundary.
 */
function truncateField(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Find the most relevant debriefs for a goal, scored by keyword overlap.
 * Falls back to recency-based if all scores are 0 (no keyword matches).
 *
 * Returns debriefs with fields truncated to prevent prompt bloat.
 */
export function findRelevantDebriefs(
  goal: Goal,
  project: string,
  limit: number = 3,
): StructuredDebrief[] {
  // Load all debriefs for this project (no limit — we'll score them all)
  const allDebriefs = getRecentDebriefs({ project });
  if (allDebriefs.length === 0) return [];

  const goalText = `${goal.title} ${goal.description || ''}`;
  const goalKeywords = extractKeywords(goalText);

  if (goalKeywords.length === 0) {
    // No meaningful keywords — fall back to recency
    return allDebriefs.slice(0, limit).map(truncateDebrief);
  }

  // Score all debriefs
  const scored = allDebriefs.map(d => ({
    debrief: d,
    score: scoreRelevance(goalKeywords, d),
  }));

  // Check if any scored above 0
  const hasRelevant = scored.some(s => s.score > 0);

  if (!hasRelevant) {
    // No keyword matches at all — fall back to recency (already sorted by date)
    return allDebriefs.slice(0, limit).map(truncateDebrief);
  }

  // Sort by score descending, break ties by recency (allDebriefs is already newest-first)
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => truncateDebrief(s.debrief));
}

/**
 * Return a copy of the debrief with fields truncated to prevent prompt bloat.
 */
function truncateDebrief(d: StructuredDebrief): StructuredDebrief {
  return {
    ...d,
    working: truncateField(d.working, MAX_WORKING_CHARS),
    broken: truncateField(d.broken, MAX_BROKEN_CHARS),
    next: truncateField(d.next, MAX_NEXT_CHARS),
  };
}
