/**
 * Digest Generator - Creates morning summaries of overnight work
 */

import { getAllGoals, getPendingGoals, Goal, getGoalsSummary } from './goal-manager.js';

export interface DigestSection {
  title: string;
  items: string[];
}

export interface Digest {
  generatedAt: Date;
  summary: string;
  sections: DigestSection[];
  assumptions: string[];
  needsAttention: string[];
  costSummary?: { totalCostUsd: number; runCount: number; byModel: Array<{ model: string; costUsd: number; runs: number }> };
  heldGoalCount?: number;
  pendingProposalCount?: number;
}

export async function generateDigest(since?: Date): Promise<Digest> {
  const goals = getAllGoals();
  const summary = getGoalsSummary();

  // Default to last 24 hours
  const cutoff = since || new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Filter goals by activity time
  const recentGoals = goals.filter(g => {
    const activityTime = g.completedAt || g.startedAt || g.createdAt;
    return activityTime >= cutoff;
  });

  const sections: DigestSection[] = [];
  const allAssumptions: string[] = [];
  const needsAttention: string[] = [];

  // Completed goals
  const completed = recentGoals.filter(g => g.status === 'completed');
  if (completed.length > 0) {
    sections.push({
      title: 'Completed',
      items: completed.map(g => `${g.project}: ${g.title}`),
    });
  }

  // In progress
  const inProgress = recentGoals.filter(g => g.status === 'in-progress');
  if (inProgress.length > 0) {
    sections.push({
      title: 'In Progress',
      items: inProgress.map(g => `${g.project}: ${g.title} (${g.iterations} iterations)`),
    });
  }

  // Blocked goals - need attention
  const blocked = recentGoals.filter(g => g.status === 'blocked');
  if (blocked.length > 0) {
    sections.push({
      title: 'Blocked',
      items: blocked.map(g => `${g.project}: ${g.title} - ${g.blockedReason || 'Unknown'}`),
    });
    needsAttention.push(...blocked.map(g =>
      `[${g.project}] ${g.title}: ${g.blockedReason}`
    ));
  }

  // Failed goals - need attention
  const failed = recentGoals.filter(g => g.status === 'failed');
  if (failed.length > 0) {
    sections.push({
      title: 'Failed',
      items: failed.map(g => `${g.project}: ${g.title}`),
    });
    needsAttention.push(...failed.map(g => `[${g.project}] ${g.title} failed`));
  }

  // Pending goals
  const pending = recentGoals.filter(g => g.status === 'pending');
  if (pending.length > 0) {
    sections.push({
      title: 'Queued',
      items: pending.map(g => `${g.project}: ${g.title}`),
    });
  }

  // Collect all assumptions
  for (const goal of recentGoals) {
    if (goal.assumptions.length > 0) {
      allAssumptions.push(
        ...goal.assumptions.map(a => `[${goal.project}] ${a}`)
      );
    }
  }

  // Cost summary from SQLite (if available)
  let costSummary: Digest['costSummary'];
  try {
    const { getCostBreakdown } = await import('../analytics/patterns.js');
    const costs = getCostBreakdown('day');
    if (costs.runCount > 0) {
      costSummary = {
        totalCostUsd: costs.totalCostUsd,
        runCount: costs.runCount,
        byModel: costs.byModel,
      };
    }
  } catch { /* SQLite not available yet — skip */ }

  // Held goals count
  let heldGoalCount = 0;
  try {
    const { getYellowGoals } = await import('./goal-triage.js');
    const allPending = getPendingGoals();
    heldGoalCount = getYellowGoals(allPending).length;
  } catch { /* triage not available yet — skip */ }

  // Pending proposals count
  let pendingProposalCount = 0;
  try {
    const { getActiveBatch } = await import('./proposal-store.js');
    const batch = getActiveBatch();
    if (batch) {
      pendingProposalCount = batch.proposals.length - batch.confirmedIds.length - batch.droppedIds.length;
    }
  } catch { /* proposal store not available yet — skip */ }

  // Build summary text
  const summaryParts: string[] = [];

  if (completed.length > 0) {
    summaryParts.push(`${completed.length} done`);
  }
  if (inProgress.length > 0) {
    summaryParts.push(`${inProgress.length} active`);
  }
  if (blocked.length > 0) {
    summaryParts.push(`${blocked.length} blocked`);
  }
  if (failed.length > 0) {
    summaryParts.push(`${failed.length} failed`);
  }
  if (pending.length > 0) {
    summaryParts.push(`${pending.length} queued`);
  }

  const summaryText = summaryParts.length > 0
    ? summaryParts.join(' | ')
    : 'No activity in the last 24 hours';

  return {
    generatedAt: new Date(),
    summary: summaryText,
    sections,
    assumptions: allAssumptions,
    needsAttention,
    costSummary,
    heldGoalCount,
    pendingProposalCount,
  };
}

export function formatDigestForTelegram(digest: Digest): string {
  const lines: string[] = [];

  // One-line summary
  lines.push(digest.summary);

  // Cost
  if (digest.costSummary && digest.costSummary.runCount > 0) {
    lines.push(`Cost: $${digest.costSummary.totalCostUsd.toFixed(2)} (${digest.costSummary.runCount} runs)`);
  }
  lines.push('');

  // Completed — group by project, just count + titles
  for (const section of digest.sections) {
    if (section.items.length === 0) continue;
    const icon = section.title === 'Completed' ? '✅' :
                 section.title === 'In Progress' ? '🔄' :
                 section.title === 'Blocked' ? '⛔' :
                 section.title === 'Failed' ? '❌' :
                 section.title === 'Queued' ? '⏳' : '•';
    lines.push(`${icon} ${section.title} (${section.items.length}):`);
    // Group by project
    const byProject = new Map<string, string[]>();
    for (const item of section.items) {
      const colonIdx = item.indexOf(':');
      const proj = colonIdx > -1 ? item.slice(0, colonIdx).trim() : 'unknown';
      const title = colonIdx > -1 ? item.slice(colonIdx + 1).trim() : item;
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj)!.push(title);
    }
    for (const [proj, titles] of byProject) {
      if (titles.length <= 2) {
        for (const t of titles) lines.push(`  ${proj}: ${t}`);
      } else {
        lines.push(`  ${proj}: ${titles.length} goals`);
      }
    }
    lines.push('');
  }

  // Needs attention (compact)
  if (digest.needsAttention.length > 0) {
    lines.push('🚨 Needs attention:');
    for (const item of digest.needsAttention.slice(0, 5)) {
      lines.push(`  ${item}`);
    }
    lines.push('');
  }

  // Held/proposals (one-liners)
  if (digest.heldGoalCount && digest.heldGoalCount > 0) {
    lines.push(`📋 ${digest.heldGoalCount} held for review (/held)`);
  }
  if (digest.pendingProposalCount && digest.pendingProposalCount > 0) {
    lines.push(`💬 ${digest.pendingProposalCount} proposals waiting`);
  }

  return lines.join('\n').trim();
}

export function formatDigestPlain(digest: Digest): string {
  const lines: string[] = [];

  lines.push('=== Morning Digest ===');
  lines.push(digest.generatedAt.toLocaleString());
  lines.push('');
  lines.push(digest.summary);
  lines.push('');

  for (const section of digest.sections) {
    lines.push(`--- ${section.title} ---`);
    for (const item of section.items) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  if (digest.assumptions.length > 0) {
    lines.push('--- Assumptions (review these) ---');
    for (const assumption of digest.assumptions) {
      lines.push(`  - ${assumption}`);
    }
    lines.push('');
  }

  if (digest.needsAttention.length > 0) {
    lines.push('--- Needs Attention ---');
    for (const item of digest.needsAttention) {
      lines.push(`  ! ${item}`);
    }
  }

  return lines.join('\n');
}
