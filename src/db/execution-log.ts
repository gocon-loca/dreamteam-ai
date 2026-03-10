/**
 * Agent Execution Log — CRUD for agent_runs table
 *
 * Records every Claude CLI invocation with full context,
 * cost data, and outcome information.
 */

import { getDb, generateId } from './index.js';

// ── Types ──────────────────────────────────────────────────

export interface AgentRunInsert {
  goalId: string;
  parentRunId?: string;
  project: string;
  modelAssigned: string;
  modelPromotedFrom?: string;
  promotionReason?: string;
  archetype?: string;
  /** CLI backend used: 'claude', 'codex', etc. */
  backend?: string;

  // Context
  promptText?: string;
  projectDocs?: string[];
  specializedContext?: Record<string, unknown>;
  mcpServers?: string[];
  toolsEnabled?: string[];
  hooksActive?: string[];
  knowledgeExcerpts?: string;
}

export interface AgentRunUpdate {
  endedAt?: string;
  durationMs?: number;
  exitCode?: number;
  iterationCount?: number;
  commandsRun?: Array<{ cmd: string; exitCode: number; durationMs?: number }>;
  filesTouched?: Array<{ path: string; action: string; linesChanged?: number }>;

  // Cost
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;

  // Sub-tasks
  subtaskDescriptions?: Array<{ step: string; description: string; criteria?: string }>;

  // Outcome
  exitSignal?: string;
  crossCheckResult?: string;
  crossCheckIssues?: string[];
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  screenshots?: string[];

  // Analysis
  tags?: string[];
  qualityScore?: number;

  // Raw output
  outputText?: string;
  debriefJson?: Record<string, unknown>;

  // JSON parse status
  jsonParseFailed?: boolean;
}

export interface AgentRunRow {
  id: string;
  goal_id: string;
  parent_run_id: string | null;
  project: string;
  model_assigned: string;
  model_promoted_from: string | null;
  promotion_reason: string | null;
  archetype: string | null;
  prompt_text: string | null;
  project_docs: string | null;
  specialized_context: string | null;
  mcp_servers: string | null;
  tools_enabled: string | null;
  hooks_active: string | null;
  knowledge_excerpts: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  iteration_count: number | null;
  commands_run: string | null;
  files_touched: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  subtask_descriptions: string | null;
  exit_signal: string | null;
  cross_check_result: string | null;
  cross_check_issues: string | null;
  tests_run: number | null;
  tests_passed: number | null;
  tests_failed: number | null;
  screenshots: string | null;
  tags: string | null;
  quality_score: number | null;
  output_text: string | null;
  debrief_json: string | null;
  json_parse_failed: number;
  backend: string | null;
}

// ── CRUD Operations ────────────────────────────────────────

/**
 * Insert a new agent run record. Returns the generated run ID.
 * Call this when an agent starts working on a goal.
 */
export function insertAgentRun(data: AgentRunInsert): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO agent_runs (
      id, goal_id, parent_run_id, project, model_assigned,
      model_promoted_from, promotion_reason, archetype, backend,
      prompt_text, project_docs, specialized_context,
      mcp_servers, tools_enabled, hooks_active, knowledge_excerpts,
      started_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?
    )
  `).run(
    id,
    data.goalId,
    data.parentRunId ?? null,
    data.project,
    data.modelAssigned,
    data.modelPromotedFrom ?? null,
    data.promotionReason ?? null,
    data.archetype ?? null,
    data.backend ?? 'claude',
    data.promptText ?? null,
    data.projectDocs ? JSON.stringify(data.projectDocs) : null,
    data.specializedContext ? JSON.stringify(data.specializedContext) : null,
    data.mcpServers ? JSON.stringify(data.mcpServers) : null,
    data.toolsEnabled ? JSON.stringify(data.toolsEnabled) : null,
    data.hooksActive ? JSON.stringify(data.hooksActive) : null,
    data.knowledgeExcerpts ?? null,
    new Date().toISOString(),
  );

  return id;
}

/**
 * Update an agent run with execution results.
 * Call this when the agent finishes (success, failure, or timeout).
 */
export function updateAgentRun(runId: string, data: AgentRunUpdate): void {
  const db = getDb();

  const sets: string[] = [];
  const values: unknown[] = [];

  function addField(column: string, value: unknown, serialize = false) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(serialize ? JSON.stringify(value) : value);
    }
  }

  addField('ended_at', data.endedAt);
  addField('duration_ms', data.durationMs);
  addField('exit_code', data.exitCode);
  addField('iteration_count', data.iterationCount);
  addField('commands_run', data.commandsRun, true);
  addField('files_touched', data.filesTouched, true);
  addField('input_tokens', data.inputTokens);
  addField('output_tokens', data.outputTokens);
  addField('cache_read_tokens', data.cacheReadTokens);
  addField('cache_creation_tokens', data.cacheCreationTokens);
  addField('cost_usd', data.costUsd);
  addField('subtask_descriptions', data.subtaskDescriptions, true);
  addField('exit_signal', data.exitSignal);
  addField('cross_check_result', data.crossCheckResult);
  addField('cross_check_issues', data.crossCheckIssues, true);
  addField('tests_run', data.testsRun);
  addField('tests_passed', data.testsPassed);
  addField('tests_failed', data.testsFailed);
  addField('screenshots', data.screenshots, true);
  addField('tags', data.tags, true);
  addField('quality_score', data.qualityScore);
  addField('output_text', data.outputText);
  addField('debrief_json', data.debriefJson, true);
  addField('json_parse_failed', data.jsonParseFailed ? 1 : 0);

  if (sets.length === 0) return;

  values.push(runId);
  db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Get a single agent run by ID.
 */
export function getAgentRun(runId: string): AgentRunRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as AgentRunRow | undefined;
}

/**
 * Get all agent runs for a goal.
 */
export function getRunsByGoal(goalId: string): AgentRunRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM agent_runs WHERE goal_id = ? ORDER BY started_at ASC'
  ).all(goalId) as AgentRunRow[];
}

/**
 * Get recent agent runs, optionally filtered by project.
 */
export function getRecentRuns(options: {
  project?: string;
  limit?: number;
  since?: string;
} = {}): AgentRunRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.project) {
    conditions.push('project = ?');
    params.push(options.project);
  }
  if (options.since) {
    conditions.push('started_at >= ?');
    params.push(options.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 50;

  return db.prepare(
    `SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ?`
  ).all(...params, limit) as AgentRunRow[];
}

/**
 * Get the latest run for a goal (most recent by started_at).
 */
export function getLatestRunForGoal(goalId: string): AgentRunRow | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM agent_runs WHERE goal_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(goalId) as AgentRunRow | undefined;
}

/**
 * Get cost summary for a time period.
 */
export function getCostSummary(since: string): {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  runCount: number;
  byProject: Record<string, number>;
  byModel: Record<string, number>;
} {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as run_count
    FROM agent_runs
    WHERE started_at >= ?
  `).get(since) as { total_cost: number; total_input: number; total_output: number; run_count: number };

  const byProject = db.prepare(`
    SELECT project, COALESCE(SUM(cost_usd), 0) as cost
    FROM agent_runs
    WHERE started_at >= ?
    GROUP BY project
  `).all(since) as Array<{ project: string; cost: number }>;

  const byModel = db.prepare(`
    SELECT model_assigned, COALESCE(SUM(cost_usd), 0) as cost
    FROM agent_runs
    WHERE started_at >= ?
    GROUP BY model_assigned
  `).all(since) as Array<{ model_assigned: string; cost: number }>;

  return {
    totalCostUsd: totals.total_cost,
    totalInputTokens: totals.total_input,
    totalOutputTokens: totals.total_output,
    runCount: totals.run_count,
    byProject: Object.fromEntries(byProject.map(r => [r.project, r.cost])),
    byModel: Object.fromEntries(byModel.map(r => [r.model_assigned, r.cost])),
  };
}

// ── Auto-tagging ───────────────────────────────────────────

/**
 * Generate tags for a goal based on title, description, and files touched.
 */
export function generateAutoTags(
  title: string,
  description?: string,
  filesTouched?: Array<{ path: string; action: string }>,
): string[] {
  const tags: string[] = [];
  const text = `${title} ${description || ''}`.toLowerCase();

  // Goal type tags
  if (/\b(ui|frontend|layout|css|style|design|button|page|component|responsive)\b/.test(text)) {
    tags.push('ui-goal');
  }
  if (/\b(api|backend|endpoint|route|server|database|query|migration)\b/.test(text)) {
    tags.push('backend-goal');
  }
  if (/\b(test|spec|e2e|unit test|integration test)\b/.test(text)) {
    tags.push('test-goal');
  }
  if (/\b(fix|bug|broken|regression|crash|error)\b/.test(text)) {
    tags.push('bug-fix');
  }
  if (/\b(refactor|cleanup|reorganize|simplify|extract)\b/.test(text)) {
    tags.push('refactor');
  }
  if (/\b(doc|readme|comment|jsdoc|guide)\b/.test(text)) {
    tags.push('docs');
  }
  if (/\b(config|deploy|ci|cd|docker|infra)\b/.test(text)) {
    tags.push('devops');
  }

  // Scope tags from files touched
  if (filesTouched) {
    const fileCount = filesTouched.length;
    if (fileCount > 5) tags.push('multi-file');
    if (fileCount === 1) tags.push('single-file');

    const extensions = new Set(filesTouched.map(f => f.path.split('.').pop()));
    if (extensions.has('css') || extensions.has('scss')) tags.push('style-change');
    if (extensions.has('sql')) tags.push('schema-change');
    if (extensions.has('test') || extensions.has('spec')) tags.push('test-change');
  }

  return [...new Set(tags)];
}
