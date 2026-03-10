/**
 * Linear Integration - Syncs DreamTeam goals with Linear issues
 *
 * Uses Linear GraphQL API directly for reliable programmatic access.
 */

import { Goal, GoalStatus } from '../orchestration/goal-manager.js';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

// Map DreamTeam statuses to Linear workflow states
// These will be configured per-team since Linear has custom workflows
const STATUS_MAP: Record<GoalStatus, string> = {
  'pending': 'Todo',
  'in-progress': 'In Progress',
  'completed': 'Done',
  'blocked': 'Blocked',
  'failed': 'Canceled',
};

interface LinearConfig {
  apiKey: string;
  teamId: string;
  projectId?: string;
  enabled: boolean;
}

interface LinearIssue {
  id: string;
  identifier: string; // e.g., "DREAM-123"
  title: string;
  description?: string;
  state: {
    name: string;
    type: string; // 'started', 'unstarted', 'completed', 'canceled', 'backlog', 'triage'
  };
  labels?: { nodes: Array<{ name: string }> };
  createdAt: string;
  updatedAt: string;
}

interface LinearTeam {
  id: string;
  name: string;
  key: string;
  states: { nodes: Array<{ id: string; name: string; type: string }> };
}

interface LinearProject {
  id: string;
  name: string;
  state: string;
}

let config: LinearConfig | null = null;
let stateIdCache: Map<string, string> = new Map();

/**
 * Initialize Linear integration with API key and team
 */
export function initLinear(apiKey: string, teamId: string, projectId?: string): void {
  config = {
    apiKey,
    teamId,
    projectId,
    enabled: true,
  };
  stateIdCache.clear();
}

/**
 * Check if Linear integration is enabled
 */
export function isLinearEnabled(): boolean {
  return config?.enabled ?? false;
}

/**
 * Disable Linear integration (for fallback to local JSON)
 */
export function disableLinear(): void {
  if (config) {
    config.enabled = false;
  }
}

/**
 * Execute a GraphQL query against Linear API
 */
async function linearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!config?.apiKey) {
    throw new Error('Linear API key not configured');
  }

  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }

  return json.data as T;
}

/**
 * Get workflow state ID for a given state name
 */
async function getStateId(stateName: string): Promise<string> {
  if (stateIdCache.has(stateName)) {
    return stateIdCache.get(stateName)!;
  }

  const query = `
    query GetTeamStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;

  const data = await linearQuery<{ team: LinearTeam }>(query, { teamId: config!.teamId });

  // Cache all states
  for (const state of data.team.states.nodes) {
    stateIdCache.set(state.name, state.id);
  }

  const stateId = stateIdCache.get(stateName);
  if (!stateId) {
    // Fallback: find by type
    const typeMap: Record<string, string> = {
      'Todo': 'unstarted',
      'In Progress': 'started',
      'Done': 'completed',
      'Blocked': 'started',
      'Canceled': 'canceled',
    };
    const targetType = typeMap[stateName] || 'unstarted';
    const fallbackState = data.team.states.nodes.find(s => s.type === targetType);
    if (fallbackState) {
      stateIdCache.set(stateName, fallbackState.id);
      return fallbackState.id;
    }
    throw new Error(`Could not find Linear state: ${stateName}`);
  }

  return stateId;
}

/**
 * Create a Linear issue from a DreamTeam goal
 */
export async function createLinearIssue(goal: Goal): Promise<string> {
  if (!config?.enabled) {
    throw new Error('Linear integration not enabled');
  }

  const stateId = await getStateId(STATUS_MAP[goal.status]);

  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
        }
      }
    }
  `;

  const input: Record<string, unknown> = {
    teamId: config.teamId,
    title: `[${goal.project}] ${goal.title}`,
    description: formatGoalDescription(goal),
    stateId,
  };

  if (config.projectId) {
    input.projectId = config.projectId;
  }

  const data = await linearQuery<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string } }
  }>(mutation, { input });

  if (!data.issueCreate.success) {
    throw new Error('Failed to create Linear issue');
  }

  return data.issueCreate.issue.id;
}

/**
 * Update a Linear issue to match goal state
 */
export async function updateLinearIssue(linearId: string, goal: Goal): Promise<void> {
  if (!config?.enabled) {
    return;
  }

  const stateId = await getStateId(STATUS_MAP[goal.status]);

  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `;

  const input: Record<string, unknown> = {
    title: `[${goal.project}] ${goal.title}`,
    description: formatGoalDescription(goal),
    stateId,
  };

  await linearQuery<{ issueUpdate: { success: boolean } }>(mutation, { id: linearId, input });
}

/**
 * Add a comment to a Linear issue (for progress updates)
 */
export async function addLinearComment(linearId: string, body: string): Promise<void> {
  if (!config?.enabled) {
    return;
  }

  const mutation = `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;

  await linearQuery<{ commentCreate: { success: boolean } }>(mutation, {
    input: { issueId: linearId, body },
  });
}

/**
 * Get all issues for the configured team/project
 */
export async function getLinearIssues(): Promise<LinearIssue[]> {
  if (!config?.enabled) {
    return [];
  }

  const query = `
    query GetIssues($teamId: String!, $projectId: String) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          ${config.projectId ? 'project: { id: { eq: $projectId } }' : ''}
        }
        first: 100
      ) {
        nodes {
          id
          identifier
          title
          description
          state {
            name
            type
          }
          labels {
            nodes {
              name
            }
          }
          createdAt
          updatedAt
        }
      }
    }
  `;

  const data = await linearQuery<{ issues: { nodes: LinearIssue[] } }>(query, {
    teamId: config.teamId,
    projectId: config.projectId,
  });

  return data.issues.nodes;
}

/**
 * Sync a goal to Linear (create if new, update if exists)
 */
export async function syncGoalToLinear(goal: Goal & { linearId?: string }): Promise<string | undefined> {
  if (!config?.enabled) {
    return undefined;
  }

  try {
    if (goal.linearId) {
      await updateLinearIssue(goal.linearId, goal);
      return goal.linearId;
    } else {
      return await createLinearIssue(goal);
    }
  } catch (error) {
    console.error(`Failed to sync goal ${goal.id} to Linear:`, error);
    // Don't throw - graceful degradation to local JSON
    return undefined;
  }
}

/**
 * Log progress to Linear as a comment
 */
export async function logProgressToLinear(
  linearId: string,
  message: string,
  type: 'progress' | 'assumption' | 'blocker' | 'complete' = 'progress'
): Promise<void> {
  if (!config?.enabled || !linearId) {
    return;
  }

  const emoji: Record<string, string> = {
    progress: '📝',
    assumption: '🤔',
    blocker: '🚧',
    complete: '✅',
  };

  const body = `${emoji[type]} **${type.toUpperCase()}**\n\n${message}`;

  try {
    await addLinearComment(linearId, body);
  } catch (error) {
    console.error(`Failed to log progress to Linear:`, error);
  }
}

/**
 * Format goal details for Linear description
 */
function formatGoalDescription(goal: Goal): string {
  let desc = goal.description || '';

  if (goal.assumptions.length > 0) {
    desc += '\n\n## Assumptions Made\n';
    desc += goal.assumptions.map(a => `- ${a}`).join('\n');
  }

  if (goal.blockedReason) {
    desc += `\n\n## Current Blocker\n${goal.blockedReason}`;
  }

  if (goal.output) {
    desc += `\n\n## Latest Output\n\`\`\`\n${goal.output.slice(-2000)}\n\`\`\``;
  }

  desc += `\n\n---\n*Managed by DreamTeam Orchestrator*\n*Goal ID: ${goal.id}*`;

  return desc;
}

interface SecretsWithLinear {
  linear?: {
    apiKey: string;
    teamId: string;
    projectId?: string;
  };
}

/**
 * Initialize Linear from secrets (helper for bot startup)
 */
export async function initLinearFromSecrets(secrets: SecretsWithLinear): Promise<boolean> {
  const linearConfig = secrets.linear;

  if (!linearConfig?.apiKey || !linearConfig?.teamId) {
    console.log('Linear integration: Not configured (missing apiKey or teamId in secrets)');
    return false;
  }

  try {
    initLinear(linearConfig.apiKey, linearConfig.teamId, linearConfig.projectId);

    // Test connection by fetching team info
    const query = `
      query TestConnection($teamId: String!) {
        team(id: $teamId) {
          name
          key
        }
      }
    `;

    const data = await linearQuery<{ team: { name: string; key: string } }>(query, {
      teamId: linearConfig.teamId,
    });

    console.log(`Linear integration: Connected to team "${data.team.name}" (${data.team.key})`);
    return true;
  } catch (error) {
    console.error('Linear integration: Failed to connect:', error);
    disableLinear();
    return false;
  }
}

// ── Structured Comments & Labels ────────────────────────────

/**
 * Format structured run data as a rich Linear comment.
 * Shows cost, model, duration, test results, cross-check, etc.
 */
export function formatStructuredComment(data: {
  exitSignal?: string;
  model?: string;
  archetype?: string;
  costUsd?: number;
  durationMs?: number;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  crossCheckResult?: string;
  crossCheckIssues?: string[];
  qualityScore?: number;
  subtaskDescriptions?: Array<{ step: string; description: string }>;
  screenshotCount?: number;
  debriefWorking?: string;
  debriefBroken?: string;
  debriefNext?: string;
}): string {
  const lines: string[] = [];

  // Header line
  const emoji = data.exitSignal === 'GOAL_COMPLETE' ? '✅' :
    data.exitSignal === 'BLOCKED' ? '⛔' :
    data.exitSignal === 'ESCALATE' ? '🚨' : '⏹️';
  const durationMin = data.durationMs ? (data.durationMs / 60000).toFixed(1) : '?';
  const cost = data.costUsd?.toFixed(2) ?? '?';
  lines.push(`${emoji} **${data.exitSignal || 'Unknown'}** | ${data.model || '?'} | $${cost} | ${durationMin} min`);

  // Archetype
  if (data.archetype) {
    lines.push(`**Role:** ${data.archetype}`);
  }

  // Sub-tasks
  if (data.subtaskDescriptions && data.subtaskDescriptions.length > 0) {
    lines.push(`**Sub-tasks:** ${data.subtaskDescriptions.length} defined`);
  }

  // Tests
  if (data.testsRun !== undefined) {
    const testLine = `**Tests:** ${data.testsPassed ?? 0} passed, ${data.testsFailed ?? 0} failed (${data.testsRun} total)`;
    lines.push(testLine);
  }

  // Screenshots
  if (data.screenshotCount && data.screenshotCount > 0) {
    lines.push(`**Visual Verification:** ${data.screenshotCount} screenshot(s) captured`);
  }

  // Cross-check
  if (data.crossCheckResult) {
    const ccEmoji = data.crossCheckResult === 'pass' ? '✅' : '⚠️';
    let ccLine = `**Cross-check:** ${ccEmoji} ${data.crossCheckResult}`;
    if (data.qualityScore) ccLine += ` (${data.qualityScore}/5)`;
    lines.push(ccLine);
  }

  if (data.crossCheckIssues && data.crossCheckIssues.length > 0) {
    lines.push(`**Concerns:** ${data.crossCheckIssues.join('; ')}`);
  }

  // Debrief summary
  if (data.debriefWorking) lines.push(`**Working:** ${data.debriefWorking}`);
  if (data.debriefBroken && data.debriefBroken !== 'nothing') lines.push(`**Broken:** ${data.debriefBroken}`);
  if (data.debriefNext && data.debriefNext !== 'nothing') lines.push(`**Next:** ${data.debriefNext}`);

  return lines.join('\n');
}

/**
 * Post a structured comment to a Linear issue from agent run data.
 */
export async function postStructuredComment(linearId: string, data: Parameters<typeof formatStructuredComment>[0]): Promise<void> {
  const body = formatStructuredComment(data);
  await addLinearComment(linearId, body);
}

/**
 * Set labels on a Linear issue.
 * Creates labels if they don't exist.
 */
export async function setIssueLabels(linearId: string, labelNames: string[]): Promise<void> {
  if (!config?.enabled || labelNames.length === 0) return;

  try {
    // Get or create labels
    const labelIds: string[] = [];
    for (const name of labelNames) {
      const labelId = await getOrCreateLabel(name);
      if (labelId) labelIds.push(labelId);
    }

    if (labelIds.length === 0) return;

    const mutation = `
      mutation UpdateIssueLabels($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
    `;

    await linearQuery<{ issueUpdate: { success: boolean } }>(mutation, {
      id: linearId,
      input: { labelIds },
    });
  } catch (error) {
    console.error(`Failed to set labels on ${linearId}:`, error);
  }
}

const labelIdCache = new Map<string, string>();

async function getOrCreateLabel(name: string): Promise<string | null> {
  if (labelIdCache.has(name)) return labelIdCache.get(name)!;

  try {
    // Search for existing label
    const query = `
      query GetLabels($teamId: String!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 100) {
          nodes { id name }
        }
      }
    `;
    const data = await linearQuery<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      query, { teamId: config!.teamId }
    );

    const existing = data.issueLabels.nodes.find(l => l.name === name);
    if (existing) {
      labelIdCache.set(name, existing.id);
      return existing.id;
    }

    // Create new label
    const mutation = `
      mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id }
        }
      }
    `;
    const createData = await linearQuery<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string } }
    }>(mutation, { input: { teamId: config!.teamId, name } });

    if (createData.issueLabelCreate.success) {
      labelIdCache.set(name, createData.issueLabelCreate.issueLabel.id);
      return createData.issueLabelCreate.issueLabel.id;
    }
  } catch (error) {
    console.error(`Failed to get/create label "${name}":`, error);
  }

  return null;
}

/**
 * Create a child issue under a parent (for sub-tasks).
 */
export async function createChildIssue(
  parentLinearId: string,
  title: string,
  description?: string,
): Promise<string | null> {
  if (!config?.enabled) return null;

  try {
    const mutation = `
      mutation CreateChildIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }
    `;

    const data = await linearQuery<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string } }
    }>(mutation, {
      input: {
        teamId: config.teamId,
        title,
        description: description || '',
        parentId: parentLinearId,
      },
    });

    return data.issueCreate.success ? data.issueCreate.issue.id : null;
  } catch (error) {
    console.error(`Failed to create child issue under ${parentLinearId}:`, error);
    return null;
  }
}

/**
 * Post a rollup status comment on a parent issue.
 */
export async function updateParentRollup(
  parentLinearId: string,
  rollupText: string,
): Promise<void> {
  await addLinearComment(parentLinearId, `📊 **Sub-task Rollup:** ${rollupText}`);
}

/**
 * Generate label names for a completed goal run.
 */
export function generateRunLabels(data: {
  model?: string;
  archetype?: string;
  exitSignal?: string;
  project?: string;
}): string[] {
  const labels: string[] = [];
  if (data.model) labels.push(`model:${data.model}`);
  if (data.archetype) labels.push(`role:${data.archetype}`);
  if (data.exitSignal === 'GOAL_COMPLETE') labels.push('completed');
  else if (data.exitSignal === 'BLOCKED') labels.push('blocked');
  else if (data.exitSignal === 'ESCALATE') labels.push('escalated');
  return labels;
}

// ── Daily Director Log ───────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const DIRECTOR_LOG_FILE = join(DATA_DIR, 'director-log-linear.json');

interface DailyLogState {
  date: string;       // YYYY-MM-DD
  linearId: string;
}

/**
 * Ensure a daily "Director Log" issue exists in Linear.
 * Creates one if today's doesn't exist, returns the cached ID otherwise.
 */
export async function ensureDailyDirectorLog(): Promise<string | null> {
  if (!config?.enabled) return null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Check cache
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(DIRECTOR_LOG_FILE)) {
      const state: DailyLogState = JSON.parse(readFileSync(DIRECTOR_LOG_FILE, 'utf-8'));
      if (state.date === today && state.linearId) {
        return state.linearId;
      }
    }
  } catch { /* corrupted file — recreate */ }

  // Create new daily issue
  try {
    const stateId = await getStateId('In Progress');

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }
    `;

    const input: Record<string, unknown> = {
      teamId: config.teamId,
      title: `[Director Log] ${today}`,
      description: `Daily log of Director interactions. Each comment is one exchange.\n\n*Auto-created by DreamTeam*`,
      stateId,
    };

    if (config.projectId) {
      input.projectId = config.projectId;
    }

    const data = await linearQuery<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string } }
    }>(mutation, { input });

    if (!data.issueCreate.success) {
      console.error('[Linear] Failed to create daily director log issue');
      return null;
    }

    const linearId = data.issueCreate.issue.id;

    // Cache for today
    writeFileSync(DIRECTOR_LOG_FILE, JSON.stringify({ date: today, linearId }, null, 2));
    console.log(`[Linear] Created daily Director Log: ${data.issueCreate.issue.identifier}`);

    return linearId;
  } catch (error) {
    console.error('[Linear] Failed to create daily director log:', error);
    return null;
  }
}

export interface DirectorLogEntry {
  userInput: string;
  inputType: 'text' | 'voice';
  directorResponse: string;
  proposalsCount: number;
  proposals: Array<{
    confidence: string;
    project: string;
    title: string;
    estimatedCostUsd: number;
  }>;
  goalsCreatedCount: number;
  goalsHeldCount: number;
  costUsd: number;
}

/**
 * Post a Director interaction as a comment on the daily log issue.
 * Truncates aggressively — Linear comments have practical limits.
 */
export async function postDirectorInteractionToLinear(
  dailyLogId: string,
  entry: DirectorLogEntry,
): Promise<void> {
  const lines: string[] = [];

  // User input (truncated to 500 chars)
  const userTrunc = entry.userInput.length > 500
    ? entry.userInput.slice(0, 500) + '...'
    : entry.userInput;
  lines.push(`**User** (${entry.inputType}):`);
  lines.push(`> ${userTrunc.replace(/\n/g, '\n> ')}`);
  lines.push('');

  // Director response (truncated to 800 chars, strip goal commands)
  let respTrunc = entry.directorResponse
    .replace(/GOAL_(?:PROPOSE|CREATE)\s+project="[^"]*"\s+title="[^"]*"(?:\s+description="[^"]*")?(?:\s+complexity="[^"]*")?(?:\s+confidence="[^"]*")?(?:\s+reason="[^"]*")?/g, '[GOAL]')
    .replace(/LEARN\s+type="[^"]*"\s+content="[^"]*"/g, '[LEARN]')
    .replace(/DECISION\s+category="[^"]*"\s+title="[^"]*"\s+rationale="[^"]*"/g, '[DECISION]');
  if (respTrunc.length > 800) {
    respTrunc = respTrunc.slice(0, 800) + '...';
  }
  lines.push(`**Director:**`);
  lines.push(respTrunc);
  lines.push('');

  // Proposals
  if (entry.proposalsCount > 0) {
    lines.push(`**Goals proposed:** ${entry.proposalsCount}`);
    for (const p of entry.proposals.slice(0, 5)) {
      lines.push(`- [${p.confidence}] ${p.project}: "${p.title}" (~$${p.estimatedCostUsd.toFixed(2)})`);
    }
    if (entry.proposals.length > 5) {
      lines.push(`  ... and ${entry.proposals.length - 5} more`);
    }
    lines.push('');
  }

  // Goals created / held
  if (entry.goalsCreatedCount > 0) {
    lines.push(`**Goals confirmed:** ${entry.goalsCreatedCount}`);
  }
  if (entry.goalsHeldCount > 0) {
    lines.push(`**Goals held:** ${entry.goalsHeldCount}`);
  }

  // Cost + timestamp
  const time = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`\n*Cost: $${entry.costUsd.toFixed(2)} | ${time}*`);

  await addLinearComment(dailyLogId, lines.join('\n'));
}

export type { LinearIssue, LinearConfig };
