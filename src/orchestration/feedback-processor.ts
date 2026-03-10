/**
 * Feedback Processor — Closes the feedback loop by turning user complaints into goals.
 *
 * Reads negative/redo feedback from human_feedback, synthesizes it,
 * sends it to the Director for evaluation, and creates goals when warranted.
 * Tracks which feedback has been processed via the feedback_processed table.
 *
 * Wired into:
 * - supervisor.ts as a periodic task (like meta-review / test-sweep)
 * - director.ts via formatFeedbackContext() for system prompt injection
 */

import { getDb } from '../db/index.js';
import { type FeedbackRow } from '../db/feedback.js';
import { addGoal, getGoal, updateGoal, type Goal } from './goal-manager.js';
import { chat, type ChatResult } from '../director/index.js';

const LOG_PREFIX = '[FeedbackProcessor]';

// ── Schema ─────────────────────────────────────────────────

/**
 * Ensure the feedback_processed tracking table exists.
 * Called lazily on first use — idempotent.
 */
let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_processed (
      feedback_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      goal_id_created TEXT
    );
  `);
  schemaReady = true;
}

// ── Core Queries ───────────────────────────────────────────

interface FeedbackWithProject extends FeedbackRow {
  project: string | null;
  goal_title: string | null;
}

/**
 * Get negative/redo feedback that hasn't been processed yet.
 * Joins against goals.json via goal_id to get project info.
 */
export function getUnprocessedFeedback(): FeedbackWithProject[] {
  ensureSchema();
  const db = getDb();

  // Get all negative/redo feedback not yet in feedback_processed
  const rows = db.prepare(`
    SELECT hf.*
    FROM human_feedback hf
    LEFT JOIN feedback_processed fp ON fp.feedback_id = hf.id
    WHERE fp.feedback_id IS NULL
      AND hf.type IN ('negative', 'redo')
    ORDER BY hf.timestamp ASC
  `).all() as FeedbackRow[];

  // Enrich with project info from goals.json
  return rows.map(row => {
    const goal = getGoal(row.goal_id);
    return {
      ...row,
      project: goal?.project ?? null,
      goal_title: goal?.title ?? null,
    };
  });
}

/**
 * Mark a feedback item as processed.
 */
function markProcessed(feedbackId: string, goalIdCreated?: string): void {
  ensureSchema();
  const db = getDb();

  db.prepare(`
    INSERT OR IGNORE INTO feedback_processed (feedback_id, processed_at, goal_id_created)
    VALUES (?, ?, ?)
  `).run(feedbackId, new Date().toISOString(), goalIdCreated ?? null);
}

// ── Synthesis ──────────────────────────────────────────────

/**
 * Build a formatted summary of recent feedback for a single project.
 * Suitable for injection into the Director's system prompt.
 */
export function synthesizeFeedbackForDirector(project: string): string {
  ensureSchema();
  const db = getDb();

  // Get recent negative/redo feedback (processed or not — Director should see the full picture)
  const rows = db.prepare(`
    SELECT hf.*
    FROM human_feedback hf
    WHERE hf.type IN ('negative', 'redo')
    ORDER BY hf.timestamp DESC
    LIMIT 50
  `).all() as FeedbackRow[];

  // Filter to this project via goal lookup
  const projectRows: Array<FeedbackRow & { goalTitle: string }> = [];
  for (const row of rows) {
    const goal = getGoal(row.goal_id);
    if (goal?.project === project) {
      projectRows.push({ ...row, goalTitle: goal.title });
    }
  }

  if (projectRows.length === 0) return '';

  // Group by type
  const negative = projectRows.filter(r => r.type === 'negative');
  const redos = projectRows.filter(r => r.type === 'redo');

  const lines: string[] = [`**${project} — User Feedback (${projectRows.length} items):**`];

  if (negative.length > 0) {
    lines.push(`  Negative (${negative.length}):`);
    for (const f of negative.slice(0, 5)) {
      const comment = f.comment ? `: ${f.comment.slice(0, 120)}` : '';
      lines.push(`  - 👎 "${f.goalTitle}"${comment}`);
    }
  }

  if (redos.length > 0) {
    lines.push(`  Redo requests (${redos.length}):`);
    for (const f of redos.slice(0, 5)) {
      const ctx = f.redo_context ? `: ${f.redo_context.slice(0, 120)}` : '';
      lines.push(`  - 🔄 "${f.goalTitle}"${ctx}`);
    }
  }

  // Detect themes by looking for repeated words in comments/redo_context
  const allText = projectRows
    .map(r => [r.comment, r.redo_context].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  if (allText.length > 20) {
    const wordFreq = new Map<string, number>();
    const stopWords = new Set([
      'the', 'and', 'this', 'that', 'with', 'from', 'have', 'been',
      'not', 'but', 'for', 'are', 'was', 'were', 'will', 'would',
      'could', 'should', 'does', 'doesn', 'didn', 'isn', 'it',
      'its', 'too', 'very', 'just', 'also', 'more', 'some', 'can',
    ]);

    for (const word of allText.split(/\s+/)) {
      const clean = word.replace(/[^a-z0-9]/g, '');
      if (clean.length > 3 && !stopWords.has(clean)) {
        wordFreq.set(clean, (wordFreq.get(clean) || 0) + 1);
      }
    }

    const themes = [...wordFreq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => `${word} (${count}x)`);

    if (themes.length > 0) {
      lines.push(`  Recurring themes: ${themes.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ── Director Prompt Injection ──────────────────────────────

/**
 * Format recent feedback history for Director prompt injection.
 * Called by director.ts when building the system prompt.
 *
 * Returns empty string if no feedback exists (saves tokens).
 */
export function formatFeedbackContext(limit: number = 30): string {
  ensureSchema();
  const db = getDb();

  const rows = db.prepare(`
    SELECT hf.*
    FROM human_feedback hf
    WHERE hf.type IN ('negative', 'redo')
    ORDER BY hf.timestamp DESC
    LIMIT ?
  `).all(limit) as FeedbackRow[];

  if (rows.length === 0) return '';

  // Group by project
  const byProject = new Map<string, Array<FeedbackRow & { goalTitle: string }>>();

  for (const row of rows) {
    const goal = getGoal(row.goal_id);
    const project = goal?.project ?? 'unknown';
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push({ ...row, goalTitle: goal?.title ?? row.goal_id });
  }

  const sections: string[] = ['\n## User Feedback (negative/redo signals)'];
  sections.push('The user has flagged these completed goals as unsatisfactory. Use this to avoid repeating mistakes and to prioritize fixes.\n');

  for (const [project, items] of byProject) {
    sections.push(`**${project}** (${items.length}):`);
    for (const item of items.slice(0, 8)) {
      const detail = item.comment || item.redo_context || '';
      const truncated = detail.length > 100 ? detail.slice(0, 100) + '...' : detail;
      const typeIcon = item.type === 'redo' ? 'redo' : 'negative';
      sections.push(`  - [${typeIcon}] "${item.goalTitle}"${truncated ? ': ' + truncated : ''}`);
    }
  }

  return sections.join('\n') + '\n';
}

// ── Main Periodic Task ─────────────────────────────────────

export interface FeedbackProcessingResult {
  feedbackCount: number;
  projectsProcessed: string[];
  goalsCreated: Goal[];
  skipped: number;
}

/**
 * Process pending negative/redo feedback.
 *
 * For each project with unprocessed feedback:
 * 1. Build a summary of what the user complained about
 * 2. Ask the Director if new goals are needed
 * 3. Create goals with source='feedback' if Director proposes them
 * 4. Mark feedback as processed
 *
 * Designed to run as a periodic task in supervisor.ts (every 2-4 hours).
 */
export async function processPendingFeedback(): Promise<FeedbackProcessingResult> {
  const result: FeedbackProcessingResult = {
    feedbackCount: 0,
    projectsProcessed: [],
    goalsCreated: [],
    skipped: 0,
  };

  const unprocessed = getUnprocessedFeedback();
  if (unprocessed.length === 0) {
    console.log(`${LOG_PREFIX} No unprocessed feedback.`);
    return result;
  }

  result.feedbackCount = unprocessed.length;
  console.log(`${LOG_PREFIX} Found ${unprocessed.length} unprocessed feedback items.`);

  // Group by project
  const byProject = new Map<string, FeedbackWithProject[]>();
  for (const fb of unprocessed) {
    const project = fb.project ?? 'unknown';
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(fb);
  }

  for (const [project, items] of byProject) {
    if (project === 'unknown') {
      // Can't create goals without a project — mark as processed and skip
      for (const item of items) {
        markProcessed(item.id);
      }
      result.skipped += items.length;
      console.log(`${LOG_PREFIX} Skipped ${items.length} feedback items with unknown project.`);
      continue;
    }

    console.log(`${LOG_PREFIX} Processing ${items.length} feedback items for ${project}...`);

    // Build context for the Director
    const feedbackSummary = items.map(fb => {
      const parts: string[] = [];
      parts.push(`- [${fb.type}] Goal: "${fb.goal_title ?? fb.goal_id}"`);
      if (fb.comment) parts.push(`  Comment: ${fb.comment}`);
      if (fb.redo_context) parts.push(`  Redo context: ${fb.redo_context}`);
      parts.push(`  Date: ${fb.timestamp}`);
      return parts.join('\n');
    }).join('\n');

    const directorPrompt = [
      `[SYSTEM: Feedback Processing Task]`,
      ``,
      `The user has left negative feedback or redo requests on completed goals for project "${project}".`,
      `Review this feedback and decide if new goals are needed to address the issues.`,
      ``,
      `## Feedback`,
      feedbackSummary,
      ``,
      `## Instructions`,
      `- If the feedback points to real issues that need fixing, create goals with GOAL_CREATE.`,
      `- If the feedback is already addressed by existing pending/in-progress goals, say so and skip.`,
      `- If the feedback is too vague to act on, skip it.`,
      `- Set source to "feedback" when creating goals.`,
      `- Keep goals specific and actionable. Reference the original goal title so the agent knows what to fix.`,
      `- Use confidence="green" only if the fix is clear. Use "yellow" if you need user input.`,
    ].join('\n');

    try {
      const chatResult: ChatResult = await chat(directorPrompt, 'text');

      // Collect created goals
      const created = [...chatResult.goalsCreated, ...chatResult.goalsHeld];
      for (const goal of created) {
        // Tag with feedback source
        updateGoal(goal.id, { source: 'feedback' });
        result.goalsCreated.push(goal);
        console.log(`${LOG_PREFIX} Created goal: [${project}] ${goal.title} (${goal.confidence ?? 'unset'})`);
      }

      result.projectsProcessed.push(project);

      // Mark all feedback in this batch as processed
      for (const fb of items) {
        const createdGoalId = created.length > 0 ? created[0].id : undefined;
        markProcessed(fb.id, createdGoalId);
      }

      console.log(`${LOG_PREFIX} ${project}: ${created.length} goals created from ${items.length} feedback items.`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error processing feedback for ${project}:`, error);
      // Don't mark as processed on error — will retry next cycle
    }
  }

  console.log(`${LOG_PREFIX} Done. ${result.goalsCreated.length} goals created across ${result.projectsProcessed.length} projects.`);
  return result;
}
