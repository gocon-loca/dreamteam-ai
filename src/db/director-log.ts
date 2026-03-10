/**
 * Director Interaction Log — CRUD for director_interactions table
 *
 * Records every Director conversation exchange with full context,
 * goal proposals, and cost data.
 */

import { getDb, generateId } from './index.js';

// ── Types ──────────────────────────────────────────────────

export interface DirectorInteractionInsert {
  userInputRaw?: string;
  whisperTranscript?: string;
  inputType?: 'text' | 'voice';
  directorResponse?: string;
  goalsProposed?: Array<{
    project: string;
    title: string;
    description: string;
    confidence?: string;
    complexity?: string;
  }>;
  clarificationsRequested?: string[];
  userRefinements?: string[];
  goalsConfirmed?: Array<{
    project: string;
    title: string;
    goalId?: string;
  }>;
  goalsHeld?: Array<{
    project: string;
    title: string;
    reason?: string;
  }>;
  exchangeMessageCount?: number;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface DirectorInteractionRow {
  id: string;
  timestamp: string;
  user_input_raw: string | null;
  whisper_transcript: string | null;
  input_type: string | null;
  director_response: string | null;
  goals_proposed: string | null;
  clarifications_requested: string | null;
  user_refinements: string | null;
  goals_confirmed: string | null;
  goals_held: string | null;
  exchange_message_count: number | null;
  session_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

// ── CRUD Operations ────────────────────────────────────────

/**
 * Insert a new Director interaction record. Returns the generated ID.
 */
export function insertDirectorInteraction(data: DirectorInteractionInsert): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO director_interactions (
      id, timestamp, user_input_raw, whisper_transcript, input_type,
      director_response, goals_proposed, clarifications_requested,
      user_refinements, goals_confirmed, goals_held,
      exchange_message_count, session_id,
      input_tokens, output_tokens, cost_usd
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?
    )
  `).run(
    id,
    new Date().toISOString(),
    data.userInputRaw ?? null,
    data.whisperTranscript ?? null,
    data.inputType ?? null,
    data.directorResponse ?? null,
    data.goalsProposed ? JSON.stringify(data.goalsProposed) : null,
    data.clarificationsRequested ? JSON.stringify(data.clarificationsRequested) : null,
    data.userRefinements ? JSON.stringify(data.userRefinements) : null,
    data.goalsConfirmed ? JSON.stringify(data.goalsConfirmed) : null,
    data.goalsHeld ? JSON.stringify(data.goalsHeld) : null,
    data.exchangeMessageCount ?? null,
    data.sessionId ?? null,
    data.inputTokens ?? null,
    data.outputTokens ?? null,
    data.costUsd ?? null,
  );

  return id;
}

/**
 * Get a single Director interaction by ID.
 */
export function getDirectorInteraction(id: string): DirectorInteractionRow | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM director_interactions WHERE id = ?'
  ).get(id) as DirectorInteractionRow | undefined;
}

/**
 * Get interactions for a session.
 */
export function getInteractionsBySession(sessionId: string): DirectorInteractionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM director_interactions WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId) as DirectorInteractionRow[];
}

/**
 * Get recent Director interactions.
 */
export function getRecentInteractions(options: {
  limit?: number;
  since?: string;
} = {}): DirectorInteractionRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.since) {
    conditions.push('timestamp >= ?');
    params.push(options.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 50;

  return db.prepare(
    `SELECT * FROM director_interactions ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...params, limit) as DirectorInteractionRow[];
}

/**
 * Get Director cost summary for a time period.
 */
export function getDirectorCostSummary(since: string): {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  interactionCount: number;
  goalsProposedCount: number;
} {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as interaction_count
    FROM director_interactions
    WHERE timestamp >= ?
  `).get(since) as {
    total_cost: number;
    total_input: number;
    total_output: number;
    interaction_count: number;
  };

  // Count goals proposed by parsing JSON arrays
  const rows = db.prepare(`
    SELECT goals_proposed FROM director_interactions
    WHERE timestamp >= ? AND goals_proposed IS NOT NULL
  `).all(since) as Array<{ goals_proposed: string }>;

  let goalsProposedCount = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.goals_proposed);
      if (Array.isArray(parsed)) goalsProposedCount += parsed.length;
    } catch {
      // skip malformed JSON
    }
  }

  return {
    totalCostUsd: totals.total_cost,
    totalInputTokens: totals.total_input,
    totalOutputTokens: totals.total_output,
    interactionCount: totals.interaction_count,
    goalsProposedCount,
  };
}
