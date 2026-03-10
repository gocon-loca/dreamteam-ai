/**
 * Proposal Store — Intermediate confirmation state for Director goals
 *
 * Goals proposed by the Director in interactive mode are stored here
 * until the user confirms or drops them via Telegram inline buttons.
 * Only one active batch at a time; new proposals expire the old batch.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { addGoal, updateGoal, type Goal } from './goal-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ──────────────────────────────────────────────────

export interface GoalProposal {
  id: string;                          // "prop-{rand6}"
  project: string;
  title: string;
  description: string;
  complexity: 'routine' | 'complex';
  confidence: 'green' | 'yellow';
  confidenceReason: string;
  estimatedCostUsd: number;
  model: string;                       // haiku/sonnet/opus
}

export interface ProposalBatch {
  id: string;                          // "b-{rand4}" (short for Telegram callback limit)
  proposals: GoalProposal[];
  createdAt: string;
  expiresAt: string;                   // +24h
  status: 'pending' | 'confirmed' | 'expired';
  totalEstimatedCostUsd: number;
  greenCount: number;
  yellowCount: number;
  confirmedIds: string[];
  droppedIds: string[];
  createdGoalIds: string[];            // Goal.id values after addGoal()
}

interface ProposalStore {
  batches: ProposalBatch[];
  lastUpdated: string;
}

// ── Persistence ────────────────────────────────────────────

const DATA_DIR = join(__dirname, '../../data');
const PROPOSALS_FILE = join(DATA_DIR, 'proposals.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): ProposalStore {
  ensureDataDir();
  if (!existsSync(PROPOSALS_FILE)) {
    return { batches: [], lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(PROPOSALS_FILE, 'utf-8')) as ProposalStore;
}

function saveStore(store: ProposalStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(PROPOSALS_FILE, JSON.stringify(store, null, 2));
}

// ── ID generators ──────────────────────────────────────────

function genBatchId(): string {
  return `b-${randomBytes(2).toString('hex')}`;
}

function genProposalId(): string {
  return `prop-${randomBytes(3).toString('hex')}`;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Create a new proposal batch. Expires any existing active batch.
 */
export function createBatch(proposals: Omit<GoalProposal, 'id'>[]): ProposalBatch {
  const store = loadStore();

  // Expire any active batch
  for (const b of store.batches) {
    if (b.status === 'pending') {
      b.status = 'expired';
    }
  }

  const now = new Date();
  const batch: ProposalBatch = {
    id: genBatchId(),
    proposals: proposals.map(p => ({ ...p, id: genProposalId() })),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString(),
    status: 'pending',
    totalEstimatedCostUsd: proposals.reduce((sum, p) => sum + p.estimatedCostUsd, 0),
    greenCount: proposals.filter(p => p.confidence === 'green').length,
    yellowCount: proposals.filter(p => p.confidence === 'yellow').length,
    confirmedIds: [],
    droppedIds: [],
    createdGoalIds: [],
  };

  store.batches.push(batch);
  saveStore(store);
  return batch;
}

/**
 * Get the currently active (pending) batch, if any.
 * Auto-expires stale batches.
 */
export function getActiveBatch(): ProposalBatch | null {
  const store = loadStore();
  const now = Date.now();
  let changed = false;

  for (const b of store.batches) {
    if (b.status === 'pending' && new Date(b.expiresAt).getTime() < now) {
      b.status = 'expired';
      changed = true;
    }
  }

  if (changed) saveStore(store);

  return store.batches.find(b => b.status === 'pending') ?? null;
}

/**
 * Confirm a single proposal — creates the goal via addGoal().
 */
export function confirmProposal(batchId: string, proposalId: string): Goal | null {
  const store = loadStore();
  const batch = store.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'pending') return null;

  const proposal = batch.proposals.find(p => p.id === proposalId);
  if (!proposal) return null;
  if (batch.confirmedIds.includes(proposalId) || batch.droppedIds.includes(proposalId)) return null;

  // Create the goal — human approval upgrades confidence to green
  const goal = addGoal(proposal.project, proposal.title, proposal.description);
  updateGoal(goal.id, {
    complexity: proposal.complexity,
    confidence: 'green',
    approvedAt: new Date().toISOString(),
  });

  batch.confirmedIds.push(proposalId);
  batch.createdGoalIds.push(goal.id);

  // If all proposals are resolved, mark batch as confirmed
  if (batch.confirmedIds.length + batch.droppedIds.length >= batch.proposals.length) {
    batch.status = 'confirmed';
  }

  saveStore(store);
  return goal;
}

/**
 * Confirm multiple proposals at once.
 * filter: 'all' = all unresolved, 'green' = only green-confidence ones.
 */
export function confirmBatch(batchId: string, filter: 'all' | 'green'): Goal[] {
  const store = loadStore();
  const batch = store.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'pending') return [];

  const goals: Goal[] = [];
  for (const proposal of batch.proposals) {
    if (batch.confirmedIds.includes(proposal.id) || batch.droppedIds.includes(proposal.id)) continue;
    if (filter === 'green' && proposal.confidence !== 'green') continue;

    const goal = addGoal(proposal.project, proposal.title, proposal.description);
    // Human approval via batch confirm upgrades confidence to green
    updateGoal(goal.id, {
      complexity: proposal.complexity,
      confidence: 'green',
      approvedAt: new Date().toISOString(),
    });

    batch.confirmedIds.push(proposal.id);
    batch.createdGoalIds.push(goal.id);
    goals.push(goal);
  }

  // If all resolved, mark batch confirmed
  if (batch.confirmedIds.length + batch.droppedIds.length >= batch.proposals.length) {
    batch.status = 'confirmed';
  }

  saveStore(store);
  return goals;
}

/**
 * Drop a single proposal.
 */
export function dropProposal(batchId: string, proposalId: string): boolean {
  const store = loadStore();
  const batch = store.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'pending') return false;

  const proposal = batch.proposals.find(p => p.id === proposalId);
  if (!proposal) return false;
  if (batch.confirmedIds.includes(proposalId) || batch.droppedIds.includes(proposalId)) return false;

  batch.droppedIds.push(proposalId);

  // If all resolved, mark batch confirmed
  if (batch.confirmedIds.length + batch.droppedIds.length >= batch.proposals.length) {
    batch.status = 'confirmed';
  }

  saveStore(store);
  return true;
}

/**
 * Drop all unresolved proposals in a batch.
 */
export function dropBatch(batchId: string): boolean {
  const store = loadStore();
  const batch = store.batches.find(b => b.id === batchId);
  if (!batch || batch.status !== 'pending') return false;

  for (const p of batch.proposals) {
    if (!batch.confirmedIds.includes(p.id) && !batch.droppedIds.includes(p.id)) {
      batch.droppedIds.push(p.id);
    }
  }
  batch.status = 'confirmed';

  saveStore(store);
  return true;
}

/**
 * Clean up expired batches. Called periodically.
 */
export function expireStaleBatches(): number {
  const store = loadStore();
  const now = Date.now();
  let expired = 0;

  for (const b of store.batches) {
    if (b.status === 'pending' && new Date(b.expiresAt).getTime() < now) {
      b.status = 'expired';
      expired++;
    }
  }

  if (expired > 0) saveStore(store);
  return expired;
}
