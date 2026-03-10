/**
 * Knowledge Graph for Director
 *
 * Persistent memory that builds up over time.
 * Uses MCP memory server for storage.
 *
 * Knowledge types:
 * - Decisions: What was decided and why
 * - Patterns: Recurring themes/issues across projects
 * - Preferences: User preferences learned over time
 * - Context: Important project context
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const KNOWLEDGE_FILE = join(DATA_DIR, 'director-knowledge.json');

export type KnowledgeType = 'decision' | 'pattern' | 'preference' | 'context' | 'insight';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  content: string;
  project?: string; // Optional: which project this relates to
  tags: string[];
  confidence: number; // 0-1, how confident we are this is accurate
  source: 'conversation' | 'observation' | 'calibration';
  createdAt: string;
  updatedAt: string;
  references?: string[]; // IDs of related entries
}

interface KnowledgeStore {
  entries: KnowledgeEntry[];
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadKnowledge(): KnowledgeStore {
  ensureDataDir();
  if (existsSync(KNOWLEDGE_FILE)) {
    return JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf-8'));
  }
  return { entries: [], lastUpdated: new Date().toISOString() };
}

function saveKnowledge(store: KnowledgeStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(KNOWLEDGE_FILE, JSON.stringify(store, null, 2));
}

/**
 * Add a new knowledge entry
 */
export function addKnowledge(
  type: KnowledgeType,
  content: string,
  options: {
    project?: string;
    tags?: string[];
    confidence?: number;
    source?: 'conversation' | 'observation' | 'calibration';
    references?: string[];
  } = {}
): KnowledgeEntry {
  const store = loadKnowledge();

  const entry: KnowledgeEntry = {
    id: `know-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    type,
    content,
    project: options.project,
    tags: options.tags || [],
    confidence: options.confidence ?? 0.8,
    source: options.source || 'conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    references: options.references,
  };

  store.entries.push(entry);
  saveKnowledge(store);

  return entry;
}

/**
 * Search knowledge by query (simple keyword match for now)
 */
export function searchKnowledge(query: string, options: {
  type?: KnowledgeType;
  project?: string;
  limit?: number;
} = {}): KnowledgeEntry[] {
  const store = loadKnowledge();
  const queryLower = query.toLowerCase();

  let results = store.entries.filter(e => {
    // Type filter
    if (options.type && e.type !== options.type) return false;

    // Project filter
    if (options.project && e.project !== options.project) return false;

    // Content match
    return e.content.toLowerCase().includes(queryLower) ||
           e.tags.some(t => t.toLowerCase().includes(queryLower));
  });

  // Sort by confidence and recency
  results.sort((a, b) => {
    const scoreA = a.confidence + (new Date(a.updatedAt).getTime() / 1e15);
    const scoreB = b.confidence + (new Date(b.updatedAt).getTime() / 1e15);
    return scoreB - scoreA;
  });

  return results.slice(0, options.limit || 10);
}

/**
 * Get all knowledge for a project
 */
export function getProjectKnowledge(project: string): KnowledgeEntry[] {
  const store = loadKnowledge();
  return store.entries.filter(e => e.project === project);
}

/**
 * Get recent knowledge entries
 */
export function getRecentKnowledge(limit: number = 10): KnowledgeEntry[] {
  const store = loadKnowledge();
  return store.entries
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Update confidence on an entry (e.g., after calibration)
 */
export function updateKnowledgeConfidence(id: string, newConfidence: number): KnowledgeEntry | undefined {
  const store = loadKnowledge();
  const index = store.entries.findIndex(e => e.id === id);

  if (index === -1) return undefined;

  store.entries[index].confidence = newConfidence;
  store.entries[index].updatedAt = new Date().toISOString();
  saveKnowledge(store);

  return store.entries[index];
}

/**
 * Add a tag to an entry
 */
export function addKnowledgeTag(id: string, tag: string): KnowledgeEntry | undefined {
  const store = loadKnowledge();
  const index = store.entries.findIndex(e => e.id === id);

  if (index === -1) return undefined;

  if (!store.entries[index].tags.includes(tag)) {
    store.entries[index].tags.push(tag);
    store.entries[index].updatedAt = new Date().toISOString();
    saveKnowledge(store);
  }

  return store.entries[index];
}

/**
 * Get knowledge by type
 */
export function getKnowledgeByType(type: KnowledgeType): KnowledgeEntry[] {
  const store = loadKnowledge();
  return store.entries.filter(e => e.type === type);
}

/**
 * Extract patterns from conversation
 * Called after Director processes messages to identify learnings
 */
export function extractAndStorePatterns(
  userMessage: string,
  directorResponse: string,
  project?: string
): void {
  // Look for decision signals
  const decisionPatterns = [
    /I('ve| have) decided/i,
    /let's go with/i,
    /we('ll| will) use/i,
    /the approach (is|will be)/i,
  ];

  for (const pattern of decisionPatterns) {
    if (userMessage.match(pattern) || directorResponse.match(pattern)) {
      // Extract the decision context
      const context = userMessage.length > 100 ? userMessage.slice(0, 100) + '...' : userMessage;
      addKnowledge('decision', `Decision made: ${context}`, {
        project,
        tags: ['auto-extracted'],
        confidence: 0.6, // Lower confidence for auto-extracted
        source: 'observation',
      });
    }
  }

  // Look for preference signals
  const preferencePatterns = [
    /I (prefer|like|want)/i,
    /please (always|never)/i,
    /I don't (like|want)/i,
  ];

  for (const pattern of preferencePatterns) {
    if (userMessage.match(pattern)) {
      addKnowledge('preference', userMessage, {
        tags: ['auto-extracted', 'user-preference'],
        confidence: 0.7,
        source: 'observation',
      });
      break; // Only extract one preference per message
    }
  }
}

/**
 * Format knowledge for Director context
 */
export function formatKnowledgeForDirector(): string {
  const decisions = getKnowledgeByType('decision').slice(-5);
  const patterns = getKnowledgeByType('pattern').slice(-5);
  const preferences = getKnowledgeByType('preference').slice(-5);

  let context = '## Knowledge Graph (Persistent Memory)\n\n';

  if (decisions.length > 0) {
    context += '### Recent Decisions\n';
    context += decisions.map(d => `- ${d.content}`).join('\n');
    context += '\n\n';
  }

  if (patterns.length > 0) {
    context += '### Observed Patterns\n';
    context += patterns.map(p => `- ${p.content}`).join('\n');
    context += '\n\n';
  }

  if (preferences.length > 0) {
    context += '### User Preferences\n';
    context += preferences.map(p => `- ${p.content}`).join('\n');
    context += '\n\n';
  }

  if (decisions.length === 0 && patterns.length === 0 && preferences.length === 0) {
    context += '*No persistent knowledge yet. I will learn as we talk.*\n\n';
  }

  return context;
}

/**
 * Analyze patterns across projects
 */
export function analyzePatterns(): {
  crossProjectThemes: string[];
  blockerPatterns: string[];
  successPatterns: string[];
} {
  const store = loadKnowledge();
  const entries = store.entries;

  // This is a simple implementation - could use NLP for better analysis
  const allContent = entries.map(e => e.content.toLowerCase()).join(' ');

  const crossProjectThemes: string[] = [];
  const blockerPatterns: string[] = [];
  const successPatterns: string[] = [];

  // Simple keyword frequency for themes
  const keywords = ['testing', 'ui', 'api', 'database', 'auth', 'performance'];
  for (const keyword of keywords) {
    const count = (allContent.match(new RegExp(keyword, 'g')) || []).length;
    if (count > 2) {
      crossProjectThemes.push(`${keyword} (mentioned ${count} times)`);
    }
  }

  // Look for blocker patterns
  const blockerKeywords = ['blocked', 'stuck', 'error', 'failed', 'problem'];
  for (const keyword of blockerKeywords) {
    const count = (allContent.match(new RegExp(keyword, 'g')) || []).length;
    if (count > 1) {
      blockerPatterns.push(`${keyword} issues (${count} occurrences)`);
    }
  }

  // Look for success patterns
  const successKeywords = ['complete', 'done', 'working', 'shipped', 'success'];
  for (const keyword of successKeywords) {
    const count = (allContent.match(new RegExp(keyword, 'g')) || []).length;
    if (count > 1) {
      successPatterns.push(`${keyword} outcomes (${count} occurrences)`);
    }
  }

  return { crossProjectThemes, blockerPatterns, successPatterns };
}
