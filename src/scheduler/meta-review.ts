/**
 * Meta-Review — Extracted from overnight.ts
 *
 * Scans recent debriefs for recurring broken patterns and creates
 * investigation goals when issues cross a frequency threshold.
 */

import {
  getRecentDebriefs,
  getPendingGoals,
  getInProgressGoals,
  getAllGoals,
} from '../orchestration/goal-manager.js';
import { storePendingProposal } from '../orchestration/pending-proposals.js';

/**
 * Run meta-review: analyze debriefs for recurring issues, create fix goals.
 */
export async function runMetaReview(
  sendTelegram: (msg: string) => Promise<void>,
): Promise<void> {
  try {
    const debriefs = getRecentDebriefs({ limit: 20 });
    if (debriefs.length < 3) return; // Not enough data

    // Analyze patterns in debriefs
    const brokenByProject = new Map<string, string[]>();
    const reviewConcerns: string[] = [];

    for (const d of debriefs) {
      if (d.broken) {
        if (!brokenByProject.has(d.project)) brokenByProject.set(d.project, []);
        brokenByProject.get(d.project)!.push(d.broken);
      }
      if (d.reviewConcerns) {
        reviewConcerns.push(`[${d.project}] ${d.reviewConcerns}`);
      }
    }

    // Detect recurring issues (same problem mentioned 2+ times)
    // Patterns that indicate "nothing is broken" — skip these entries entirely
    const nothingBrokenPatterns = [
      /^nothing\s+(broken|new|newly|is)/i,
      /^nothing\.?\s*$/i,
      /^nothing\.\s+/i,
      /^none\b/i,
      /^no\s+(known|new|issues|bugs|breaking)/i,
      /^n\/a$/i,
      /^-$/,
    ];

    for (const [project, brokenItems] of brokenByProject) {
      // Filter out entries where agent explicitly says nothing is broken
      const realBrokenItems = brokenItems.filter(item => {
        const trimmed = item.trim();
        return !nothingBrokenPatterns.some(p => p.test(trimmed));
      });

      if (realBrokenItems.length < 2) continue; // Need 2+ real issues

      // Extract meaningful phrases using bigrams
      const phraseFreq = new Map<string, number>();
      const stopWords = new Set([
        'this', 'that', 'with', 'from', 'have', 'been', 'were', 'will',
        'would', 'could', 'should', 'their', 'there', 'these', 'those',
        'about', 'which', 'when', 'where', 'what', 'than', 'then',
        'some', 'only', 'also', 'into', 'over', 'after', 'before',
        'does', 'doing', 'done', 'being', 'uses', 'used', 'using',
        'known', 'minor', 'broken', 'nothing', 'none', 'existing',
        'pre-existing', 'limitation', 'limitations', 'optional',
        'currently', 'requires', 'because', 'without', 'instead',
        'expected', 'design', 'installed', 'available', 'works',
        'working', 'accurately', 'correctly',
      ]);

      for (const item of realBrokenItems) {
        const words = item.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !stopWords.has(w));

        // Bigrams
        for (let i = 0; i < words.length - 1; i++) {
          const bigram = `${words[i]} ${words[i + 1]}`;
          phraseFreq.set(bigram, (phraseFreq.get(bigram) || 0) + 1);
        }
        // Significant individual words (5+ chars)
        for (const word of words.filter(w => w.length >= 5)) {
          phraseFreq.set(word, (phraseFreq.get(word) || 0) + 1);
        }
      }

      // Find phrases appearing in 50%+ of REAL broken items
      const threshold = Math.max(2, Math.floor(realBrokenItems.length * 0.5));
      const recurringIssues = Array.from(phraseFreq.entries())
        .filter(([, count]) => count >= threshold)
        .sort(([, a], [, b]) => b - a)
        .map(([phrase]) => phrase);

      if (recurringIssues.length > 0) {
        // Check if we already have a pending/in-progress goal about this
        const allGoals = getAllGoals();
        const recentGoals = allGoals.filter(g =>
          g.project === project &&
          (g.status === 'pending' || g.status === 'in-progress') &&
          recurringIssues.some(issue => g.title.toLowerCase().includes(issue))
        );

        // 24h cooldown: also check completed goals from last 24 hours
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentCompletedGoals = allGoals.filter(g =>
          g.project === project &&
          g.status === 'completed' &&
          g.completedAt && new Date(g.completedAt).getTime() > Date.now() - 24 * 60 * 60 * 1000 &&
          recurringIssues.some(issue => g.title.toLowerCase().includes(issue))
        );

        if (recentGoals.length === 0 && recentCompletedGoals.length === 0) {
          const title = `Investigate recurring issue: ${recurringIssues.slice(0, 3).join(', ')}`;
          const description = `Multiple agent debriefs report the same broken items:\n${realBrokenItems.map(b => `- ${b}`).join('\n')}\n\nInvestigate root cause and fix.`;
          // Store proposal for human approval instead of auto-creating
          storePendingProposal({ source: 'meta-review', project, title, description });
          console.log(`[Meta-review] Proposed goal for ${project} (awaiting approval): ${title}`);
        }
      }
    }

    // Report accumulated review concerns
    if (reviewConcerns.length >= 3) {
      console.log(`[Meta-review] ${reviewConcerns.length} cross-check concerns accumulated`);
    }
  } catch (err) {
    console.error(`[Meta-review] Error: ${err}`);
  }
}
