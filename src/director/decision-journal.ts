/**
 * Decision Journal - Tracks decisions for learning and external habit-tracking integration
 *
 * Every significant decision gets logged with:
 * - Context: What led to the decision
 * - Options: What alternatives were considered
 * - Rationale: Why this choice was made
 * - Outcome: What happened (filled in later)
 *
 * Integrates with:
 * - Knowledge Graph: Decisions become persistent knowledge
 * - External apps: Can export as habits/commitments for tracking
 * - Quality system: Decisions can be calibrated
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { addKnowledge, searchKnowledge, KnowledgeEntry } from './knowledge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const JOURNAL_FILE = join(DATA_DIR, 'decision-journal.json');

export type DecisionCategory =
  | 'architecture'    // System design decisions
  | 'technology'      // Tool/library/framework choices
  | 'process'         // Workflow and process decisions
  | 'scope'           // What to include/exclude
  | 'priority'        // What to work on first
  | 'approach'        // How to solve a problem
  | 'delegation'      // Who/what handles this
  | 'risk'            // Risk acceptance/mitigation
  | 'resource';       // Time/budget/effort allocation

export type DecisionStatus =
  | 'proposed'        // Under consideration
  | 'decided'         // Decision made, not yet implemented
  | 'implementing'    // Being put into action
  | 'completed'       // Fully implemented
  | 'revisiting'      // Being reconsidered
  | 'reversed';       // Changed our mind

export interface DecisionOption {
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  chosen: boolean;
}

export interface DecisionOutcome {
  timestamp: string;
  result: 'success' | 'partial' | 'failure' | 'unknown';
  description: string;
  lessonsLearned?: string[];
  wouldChooseDifferently?: boolean;
  alternativeInHindsight?: string;
}

export interface Decision {
  id: string;
  category: DecisionCategory;
  title: string;
  context: string;
  options: DecisionOption[];
  rationale: string;
  status: DecisionStatus;
  project?: string;
  goalId?: string;
  tags: string[];
  createdAt: string;
  decidedAt?: string;
  outcome?: DecisionOutcome;
  // Link to knowledge graph
  knowledgeId?: string;
  // For external habit-tracking integration
  externalHabitId?: string;
  isCommitment: boolean; // Whether this is an ongoing commitment vs one-time
}

interface JournalStore {
  decisions: Decision[];
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJournal(): JournalStore {
  ensureDataDir();
  if (existsSync(JOURNAL_FILE)) {
    return JSON.parse(readFileSync(JOURNAL_FILE, 'utf-8'));
  }
  return { decisions: [], lastUpdated: new Date().toISOString() };
}

function saveJournal(store: JournalStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(JOURNAL_FILE, JSON.stringify(store, null, 2));
}

/**
 * Create a new decision entry
 */
export function createDecision(
  category: DecisionCategory,
  title: string,
  context: string,
  options: DecisionOption[],
  rationale: string,
  extra: {
    project?: string;
    goalId?: string;
    tags?: string[];
    isCommitment?: boolean;
  } = {}
): Decision {
  const store = loadJournal();

  const decision: Decision = {
    id: `dec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    category,
    title,
    context,
    options,
    rationale,
    status: 'decided',
    project: extra.project,
    goalId: extra.goalId,
    tags: extra.tags || [],
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    isCommitment: extra.isCommitment || false,
  };

  // Also add to knowledge graph
  const knowledgeEntry = addKnowledge('decision', `${title}: ${rationale}`, {
    project: extra.project,
    tags: ['decision-journal', category, ...(extra.tags || [])],
    confidence: 0.9,
    source: 'conversation',
  });
  decision.knowledgeId = knowledgeEntry.id;

  store.decisions.push(decision);
  saveJournal(store);

  return decision;
}

/**
 * Quick decision entry (for simpler cases)
 */
export function logDecision(
  title: string,
  rationale: string,
  category: DecisionCategory = 'approach',
  project?: string
): Decision {
  return createDecision(category, title, 'Quick decision', [], rationale, {
    project,
    isCommitment: false,
  });
}

/**
 * Update decision status
 */
export function updateDecisionStatus(id: string, status: DecisionStatus): Decision | undefined {
  const store = loadJournal();
  const index = store.decisions.findIndex(d => d.id === id);

  if (index === -1) return undefined;

  store.decisions[index].status = status;
  saveJournal(store);

  return store.decisions[index];
}

/**
 * Record the outcome of a decision
 */
export function recordOutcome(
  id: string,
  result: 'success' | 'partial' | 'failure' | 'unknown',
  description: string,
  lessons?: {
    lessonsLearned?: string[];
    wouldChooseDifferently?: boolean;
    alternativeInHindsight?: string;
  }
): Decision | undefined {
  const store = loadJournal();
  const index = store.decisions.findIndex(d => d.id === id);

  if (index === -1) return undefined;

  store.decisions[index].outcome = {
    timestamp: new Date().toISOString(),
    result,
    description,
    lessonsLearned: lessons?.lessonsLearned,
    wouldChooseDifferently: lessons?.wouldChooseDifferently,
    alternativeInHindsight: lessons?.alternativeInHindsight,
  };

  store.decisions[index].status = 'completed';
  saveJournal(store);

  // Update knowledge graph with outcome
  if (store.decisions[index].knowledgeId) {
    const outcomeKnowledge = `Decision outcome for "${store.decisions[index].title}": ${result} - ${description}`;
    addKnowledge('insight', outcomeKnowledge, {
      project: store.decisions[index].project,
      tags: ['decision-outcome', result],
      confidence: 1.0,
      source: 'observation',
      references: [store.decisions[index].knowledgeId],
    });
  }

  return store.decisions[index];
}

/**
 * Get decisions by project
 */
export function getDecisionsByProject(project: string): Decision[] {
  const store = loadJournal();
  return store.decisions.filter(d => d.project === project);
}

/**
 * Get recent decisions
 */
export function getRecentDecisions(limit: number = 10): Decision[] {
  const store = loadJournal();
  return store.decisions
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Get decisions without recorded outcomes (for follow-up)
 */
export function getPendingOutcomes(): Decision[] {
  const store = loadJournal();
  return store.decisions.filter(
    d => !d.outcome && d.status !== 'proposed' && d.status !== 'reversed'
  );
}

/**
 * Get commitment decisions (for habit tracking integrations)
 */
export function getCommitments(activeOnly: boolean = true): Decision[] {
  const store = loadJournal();
  return store.decisions.filter(d => {
    if (!d.isCommitment) return false;
    if (activeOnly && (d.status === 'completed' || d.status === 'reversed')) {
      return false;
    }
    return true;
  });
}

/**
 * Search decisions
 */
export function searchDecisions(query: string, options: {
  category?: DecisionCategory;
  project?: string;
  status?: DecisionStatus;
  limit?: number;
} = {}): Decision[] {
  const store = loadJournal();
  const queryLower = query.toLowerCase();

  let results = store.decisions.filter(d => {
    // Apply filters
    if (options.category && d.category !== options.category) return false;
    if (options.project && d.project !== options.project) return false;
    if (options.status && d.status !== options.status) return false;

    // Search in title, context, rationale
    return (
      d.title.toLowerCase().includes(queryLower) ||
      d.context.toLowerCase().includes(queryLower) ||
      d.rationale.toLowerCase().includes(queryLower) ||
      d.tags.some(t => t.toLowerCase().includes(queryLower))
    );
  });

  // Sort by recency
  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return results.slice(0, options.limit || 20);
}

/**
 * Analyze decision patterns
 */
export function analyzeDecisionPatterns(): {
  totalDecisions: number;
  byCategory: Record<DecisionCategory, number>;
  outcomeStats: {
    success: number;
    partial: number;
    failure: number;
    pending: number;
  };
  reversalRate: number;
  avgTimeToOutcome: number | null;
  topProjects: { project: string; count: number }[];
} {
  const store = loadJournal();
  const decisions = store.decisions;

  const byCategory: Record<DecisionCategory, number> = {
    architecture: 0,
    technology: 0,
    process: 0,
    scope: 0,
    priority: 0,
    approach: 0,
    delegation: 0,
    risk: 0,
    resource: 0,
  };

  const outcomeStats = {
    success: 0,
    partial: 0,
    failure: 0,
    pending: 0,
  };

  let reversals = 0;
  let outcomeTimesSum = 0;
  let outcomeCount = 0;

  const projectCounts: Record<string, number> = {};

  for (const d of decisions) {
    byCategory[d.category]++;

    if (d.status === 'reversed') reversals++;

    if (d.outcome) {
      outcomeStats[d.outcome.result === 'unknown' ? 'pending' : d.outcome.result]++;

      if (d.decidedAt) {
        const decisionTime = new Date(d.decidedAt).getTime();
        const outcomeTime = new Date(d.outcome.timestamp).getTime();
        outcomeTimesSum += outcomeTime - decisionTime;
        outcomeCount++;
      }
    } else {
      outcomeStats.pending++;
    }

    if (d.project) {
      projectCounts[d.project] = (projectCounts[d.project] || 0) + 1;
    }
  }

  const topProjects = Object.entries(projectCounts)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalDecisions: decisions.length,
    byCategory,
    outcomeStats,
    reversalRate: decisions.length > 0 ? reversals / decisions.length : 0,
    avgTimeToOutcome: outcomeCount > 0 ? outcomeTimesSum / outcomeCount : null,
    topProjects,
  };
}

/**
 * Format decision for Telegram display
 */
export function formatDecisionForTelegram(decision: Decision): string {
  const lines = [
    `📋 Decision: ${decision.title}`,
    `   Category: ${decision.category}`,
    `   Status: ${decision.status}`,
  ];

  if (decision.project) {
    lines.push(`   Project: ${decision.project}`);
  }

  lines.push(`   Rationale: ${decision.rationale.slice(0, 100)}${decision.rationale.length > 100 ? '...' : ''}`);

  if (decision.outcome) {
    lines.push('');
    lines.push(`   📊 Outcome: ${decision.outcome.result}`);
    lines.push(`   ${decision.outcome.description.slice(0, 80)}`);
  }

  if (decision.isCommitment) {
    lines.push('');
    lines.push(`   🎯 This is an ongoing commitment`);
  }

  return lines.join('\n');
}

/**
 * Get decisions context for Director
 */
export function getDecisionsContextForDirector(): string {
  const recent = getRecentDecisions(5);
  const pending = getPendingOutcomes().slice(0, 3);
  const patterns = analyzeDecisionPatterns();

  let context = '## Decision Journal\n\n';

  if (recent.length > 0) {
    context += '### Recent Decisions\n';
    for (const d of recent) {
      context += `- [${d.category}] ${d.title}\n`;
    }
    context += '\n';
  }

  if (pending.length > 0) {
    context += '### Awaiting Outcome\n';
    for (const d of pending) {
      context += `- ${d.title} (${d.status})\n`;
    }
    context += '\n';
  }

  if (patterns.outcomeStats.failure > 0) {
    context += `⚠️ ${patterns.outcomeStats.failure} decisions have failed outcomes - review for learning.\n\n`;
  }

  return context;
}

/**
 * Export decisions for external habit-tracking integration
 * Returns data formatted for habit/commitment tracking
 */
export function exportForHabitTracking(): {
  commitments: {
    id: string;
    title: string;
    description: string;
    category: string;
    createdAt: string;
    isActive: boolean;
  }[];
  decisions: {
    id: string;
    title: string;
    outcome: string | null;
    lessonsLearned: string[];
  }[];
} {
  const store = loadJournal();

  const commitments = store.decisions
    .filter(d => d.isCommitment)
    .map(d => ({
      id: d.id,
      title: d.title,
      description: d.rationale,
      category: d.category,
      createdAt: d.createdAt,
      isActive: d.status !== 'completed' && d.status !== 'reversed',
    }));

  const decisions = store.decisions
    .filter(d => d.outcome)
    .map(d => ({
      id: d.id,
      title: d.title,
      outcome: d.outcome?.result || null,
      lessonsLearned: d.outcome?.lessonsLearned || [],
    }));

  return { commitments, decisions };
}

/**
 * Parse DECISION commands from text (for Director to use)
 * Format: DECISION category="..." title="..." rationale="..."
 */
export function parseDecisionCommands(text: string, project?: string): Decision[] {
  const pattern = /DECISION\s+category="([^"]+)"\s+title="([^"]+)"\s+rationale="([^"]+)"/g;
  const decisions: Decision[] = [];

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, category, title, rationale] = match;

    // Validate category
    const validCategories: DecisionCategory[] = [
      'architecture', 'technology', 'process', 'scope',
      'priority', 'approach', 'delegation', 'risk', 'resource'
    ];

    const cat = category.toLowerCase() as DecisionCategory;
    if (validCategories.includes(cat)) {
      const decision = logDecision(title, rationale, cat, project);
      decisions.push(decision);
    }
  }

  return decisions;
}
