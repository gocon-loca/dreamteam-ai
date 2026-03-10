/**
 * Pending Proposals — stores goal proposals that need human approval.
 *
 * Auto-creators (meta-review, PM sweep, test-sweep, E2E verification)
 * store proposals here instead of calling addGoal() directly.
 * The supervisor sends them as Telegram messages with approve/reject buttons.
 * The bot handles the callbacks to create or discard the goals.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { addGoal } from './goal-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const PROPOSALS_FILE = join(DATA_DIR, 'pending-proposals.json');

export interface PendingProposal {
  id: string;
  source: string;       // 'meta-review' | 'pm-agent' | 'test-sweep' | 'e2e'
  project: string;
  title: string;
  description: string;
  createdAt: string;
  status: 'unsent' | 'sent' | 'approved' | 'rejected';
  telegramMessageId?: number;
}

interface ProposalFile {
  proposals: PendingProposal[];
}

function load(): ProposalFile {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PROPOSALS_FILE)) return { proposals: [] };
  try {
    return JSON.parse(readFileSync(PROPOSALS_FILE, 'utf-8'));
  } catch {
    return { proposals: [] };
  }
}

function save(data: ProposalFile): void {
  writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Store a new proposal. Called by auto-creators instead of addGoal().
 */
export function storePendingProposal(opts: {
  source: string;
  project: string;
  title: string;
  description: string;
}): PendingProposal {
  const data = load();
  const proposal: PendingProposal = {
    id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: opts.source,
    project: opts.project,
    title: opts.title,
    description: opts.description,
    createdAt: new Date().toISOString(),
    status: 'unsent',
  };
  data.proposals.push(proposal);
  save(data);
  return proposal;
}

/**
 * Get all unsent proposals (for supervisor to send via Telegram).
 */
export function getUnsentProposals(): PendingProposal[] {
  return load().proposals.filter(p => p.status === 'unsent');
}

/**
 * Mark a proposal as sent (with Telegram message ID for editing later).
 */
export function markProposalSent(proposalId: string, telegramMessageId?: number): void {
  const data = load();
  const p = data.proposals.find(x => x.id === proposalId);
  if (p) {
    p.status = 'sent';
    if (telegramMessageId) p.telegramMessageId = telegramMessageId;
    save(data);
  }
}

/**
 * Approve a proposal — creates the goal via addGoal().
 * Returns the created goal ID, or null if not found.
 */
export function approveProposal(proposalId: string): string | null {
  const data = load();
  const p = data.proposals.find(x => x.id === proposalId && (x.status === 'sent' || x.status === 'unsent'));
  if (!p) return null;

  const goal = addGoal(p.project, p.title, p.description, p.source);
  p.status = 'approved';
  save(data);
  console.log(`[Proposals] Approved: ${p.title} → ${goal.id}`);
  return goal.id;
}

/**
 * Reject a proposal — just marks it rejected.
 */
export function rejectProposal(proposalId: string): boolean {
  const data = load();
  const p = data.proposals.find(x => x.id === proposalId && (x.status === 'sent' || x.status === 'unsent'));
  if (!p) return false;

  p.status = 'rejected';
  save(data);
  console.log(`[Proposals] Rejected: ${p.title}`);
  return true;
}

/**
 * Get a proposal by ID.
 */
export function getProposal(proposalId: string): PendingProposal | undefined {
  return load().proposals.find(x => x.id === proposalId);
}
