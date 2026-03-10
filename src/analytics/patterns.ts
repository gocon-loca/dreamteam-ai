/**
 * Success Pattern Extraction — READ-ONLY query functions against SQLite
 *
 * Provides insights into model efficiency, cost breakdown, archetype
 * performance, and success patterns. Used by /patterns, /costs,
 * /efficiency Telegram commands and the morning digest.
 */

import { getDb } from '../db/index.js';
import { resolveModel, type ModelTier } from '../orchestration/model-config.js';

// ── Types ──────────────────────────────────────────────────

export interface PatternReport {
  topSuccessPatterns: Array<{
    goalType: string;
    model: string;
    successRate: number;
    avgCostUsd: number;
    runs: number;
  }>;
  failurePatterns: Array<{
    goalType: string;
    model: string;
    failureRate: number;
    runs: number;
    commonExitSignals: string[];
  }>;
}

export interface CostReport {
  period: string;
  totalCostUsd: number;
  runCount: number;
  byProject: Array<{ project: string; costUsd: number; runs: number }>;
  byModel: Array<{ model: string; costUsd: number; runs: number }>;
  byTier: Array<{ tier: ModelTier; costUsd: number; runs: number }>;
  byArchetype: Array<{ archetype: string; costUsd: number; runs: number }>;
  avgCostPerGoal: number;
}

export interface ModelEfficiencyReport {
  models: Array<{
    model: string;
    totalRuns: number;
    successRate: number;
    avgCostUsd: number;
    avgDurationMs: number;
    promotionRate: number;
    costPerSuccess: number;
  }>;
}

export interface ArchetypeReport {
  archetypes: Array<{
    archetype: string;
    totalRuns: number;
    successRate: number;
    avgCostUsd: number;
    topModel: string;
    avgDurationMs: number;
  }>;
}

// ── Helper Functions ──────────────────────────────────────

/**
 * Map a stored model_assigned value to its tier.
 * New rows store tier names ('primary', 'secondary', 'ancillary') directly.
 * Old rows stored concrete model names ('opus', 'sonnet', 'haiku') — handle both.
 */
function mapModelToTier(model: string): ModelTier | 'unknown' {
  const validTiers: ModelTier[] = ['primary', 'secondary', 'ancillary'];
  // New format: already a tier name
  if (validTiers.includes(model as ModelTier)) {
    return model as ModelTier;
  }
  // Old format: concrete model name — resolve each tier and compare
  for (const tier of validTiers) {
    if (resolveModel(tier) === model) {
      return tier;
    }
  }
  return 'unknown';
}

// ── Query Functions ────────────────────────────────────────

/**
 * Get success and failure patterns from model_task_memory.
 */
export function getSuccessPatterns(filters?: {
  project?: string;
  archetype?: string;
  model?: string;
  minRuns?: number;
}): PatternReport {
  const db = getDb();
  const minRuns = filters?.minRuns ?? 2;

  // Success patterns from model_task_memory
  const successRows = db.prepare(`
    SELECT goal_type, model, total_runs, successes, failures, avg_cost_usd
    FROM model_task_memory
    WHERE total_runs >= ?
    ORDER BY (CAST(successes AS REAL) / total_runs) DESC
    LIMIT 20
  `).all(minRuns) as Array<{
    goal_type: string; model: string; total_runs: number;
    successes: number; failures: number; avg_cost_usd: number | null;
  }>;

  const topSuccessPatterns = successRows
    .filter(r => r.successes > 0)
    .map(r => ({
      goalType: r.goal_type,
      model: r.model,
      successRate: r.successes / r.total_runs,
      avgCostUsd: r.avg_cost_usd ?? 0,
      runs: r.total_runs,
    }));

  const failurePatterns = successRows
    .filter(r => r.failures > 0)
    .map(r => ({
      goalType: r.goal_type,
      model: r.model,
      failureRate: r.failures / r.total_runs,
      runs: r.total_runs,
      commonExitSignals: [] as string[],
    }))
    .sort((a, b) => b.failureRate - a.failureRate);

  return { topSuccessPatterns, failurePatterns };
}

/**
 * Get cost breakdown for a time period.
 */
export function getCostBreakdown(period: 'day' | 'week' | 'month' = 'day'): CostReport {
  const db = getDb();

  const since = new Date();
  switch (period) {
    case 'day': since.setHours(0, 0, 0, 0); break;
    case 'week': since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0); break;
    case 'month': since.setDate(since.getDate() - 30); since.setHours(0, 0, 0, 0); break;
  }
  const sinceStr = since.toISOString();

  // Total cost
  const totals = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COUNT(*) as run_count
    FROM agent_runs WHERE started_at >= ?
  `).get(sinceStr) as { total_cost: number; run_count: number };

  // By project
  const byProject = db.prepare(`
    SELECT project, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
    FROM agent_runs WHERE started_at >= ?
    GROUP BY project ORDER BY cost_usd DESC
  `).all(sinceStr) as Array<{ project: string; cost_usd: number; runs: number }>;

  // By model
  const byModel = db.prepare(`
    SELECT model_assigned as model, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
    FROM agent_runs WHERE started_at >= ?
    GROUP BY model_assigned ORDER BY cost_usd DESC
  `).all(sinceStr) as Array<{ model: string; cost_usd: number; runs: number }>;

  // By tier: aggregate models by their tier
  const tierMap = new Map<string, { costUsd: number; runs: number }>();
  for (const m of byModel) {
    const tier = mapModelToTier(m.model);
    if (tier !== 'unknown') {
      const existing = tierMap.get(tier) || { costUsd: 0, runs: 0 };
      tierMap.set(tier, {
        costUsd: existing.costUsd + m.cost_usd,
        runs: existing.runs + m.runs,
      });
    }
  }
  const byTier = Array.from(tierMap.entries())
    .map(([tier, data]) => ({ tier: tier as ModelTier, costUsd: data.costUsd, runs: data.runs }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // By archetype
  const byArchetype = db.prepare(`
    SELECT COALESCE(archetype, 'unknown') as archetype, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
    FROM agent_runs WHERE started_at >= ?
    GROUP BY archetype ORDER BY cost_usd DESC
  `).all(sinceStr) as Array<{ archetype: string; cost_usd: number; runs: number }>;

  return {
    period,
    totalCostUsd: totals.total_cost,
    runCount: totals.run_count,
    byProject: byProject.map(r => ({ project: r.project, costUsd: r.cost_usd, runs: r.runs })),
    byModel: byModel.map(r => ({ model: r.model, costUsd: r.cost_usd, runs: r.runs })),
    byTier,
    byArchetype: byArchetype.map(r => ({ archetype: r.archetype, costUsd: r.cost_usd, runs: r.runs })),
    avgCostPerGoal: totals.run_count > 0 ? totals.total_cost / totals.run_count : 0,
  };
}

/**
 * Get model efficiency report — success rate vs cost per model.
 */
export function getModelEfficiency(): ModelEfficiencyReport {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      model_assigned as model,
      COUNT(*) as total_runs,
      SUM(CASE WHEN exit_signal = 'GOAL_COMPLETE' THEN 1 ELSE 0 END) as successes,
      COALESCE(AVG(cost_usd), 0) as avg_cost,
      COALESCE(AVG(duration_ms), 0) as avg_duration,
      SUM(CASE WHEN model_promoted_from IS NOT NULL THEN 1 ELSE 0 END) as promotions
    FROM agent_runs
    WHERE exit_signal IS NOT NULL
    GROUP BY model_assigned
    ORDER BY model_assigned
  `).all() as Array<{
    model: string; total_runs: number; successes: number;
    avg_cost: number; avg_duration: number; promotions: number;
  }>;

  return {
    models: rows.map(r => {
      const successRate = r.total_runs > 0 ? r.successes / r.total_runs : 0;
      return {
        model: r.model,
        totalRuns: r.total_runs,
        successRate,
        avgCostUsd: r.avg_cost,
        avgDurationMs: r.avg_duration,
        promotionRate: r.total_runs > 0 ? r.promotions / r.total_runs : 0,
        costPerSuccess: r.successes > 0 ? (r.avg_cost * r.total_runs) / r.successes : 0,
      };
    }),
  };
}

/**
 * Get archetype performance report.
 */
export function getArchetypePerformance(): ArchetypeReport {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      COALESCE(archetype, 'unknown') as archetype,
      COUNT(*) as total_runs,
      SUM(CASE WHEN exit_signal = 'GOAL_COMPLETE' THEN 1 ELSE 0 END) as successes,
      COALESCE(AVG(cost_usd), 0) as avg_cost,
      COALESCE(AVG(duration_ms), 0) as avg_duration,
      model_assigned as top_model
    FROM agent_runs
    WHERE exit_signal IS NOT NULL
    GROUP BY archetype
    ORDER BY total_runs DESC
  `).all() as Array<{
    archetype: string; total_runs: number; successes: number;
    avg_cost: number; avg_duration: number; top_model: string;
  }>;

  return {
    archetypes: rows.map(r => ({
      archetype: r.archetype,
      totalRuns: r.total_runs,
      successRate: r.total_runs > 0 ? r.successes / r.total_runs : 0,
      avgCostUsd: r.avg_cost,
      topModel: r.top_model,
      avgDurationMs: r.avg_duration,
    })),
  };
}

// ── Formatting Helpers ─────────────────────────────────────

/**
 * Format cost report for Telegram display.
 */
export function formatCostReport(report: CostReport): string {
  const lines = [
    `\uD83D\uDCB0 Cost Breakdown (${report.period})`,
    `Total: $${report.totalCostUsd.toFixed(2)} across ${report.runCount} runs`,
    `Avg per goal: $${report.avgCostPerGoal.toFixed(2)}`,
    '',
  ];

  if (report.byProject.length > 0) {
    lines.push('By Project:');
    for (const p of report.byProject) {
      lines.push(`  ${p.project}: $${p.costUsd.toFixed(2)} (${p.runs} runs)`);
    }
    lines.push('');
  }

  if (report.byModel.length > 0) {
    lines.push('By Model:');
    for (const m of report.byModel) {
      lines.push(`  ${m.model}: $${m.costUsd.toFixed(2)} (${m.runs} runs)`);
    }
    lines.push('');
  }

  if (report.byTier.length > 0) {
    lines.push('By Tier:');
    for (const t of report.byTier) {
      lines.push(`  ${t.tier}: $${t.costUsd.toFixed(2)} (${t.runs} runs)`);
    }
    lines.push('');
  }

  if (report.byArchetype.length > 0) {
    lines.push('By Role:');
    for (const a of report.byArchetype) {
      lines.push(`  ${a.archetype}: $${a.costUsd.toFixed(2)} (${a.runs} runs)`);
    }
  }

  return lines.join('\n');
}

/**
 * Format model efficiency report for Telegram display.
 */
export function formatEfficiencyReport(report: ModelEfficiencyReport): string {
  if (report.models.length === 0) {
    return '\uD83D\uDCCA No model data yet. Run some goals first!';
  }

  const lines = ['\uD83D\uDCCA Model Efficiency Report', ''];

  for (const m of report.models) {
    const dur = m.avgDurationMs > 0 ? `${(m.avgDurationMs / 60000).toFixed(1)} min` : '?';
    lines.push(`**${m.model}**`);
    lines.push(`  Runs: ${m.totalRuns} | Success: ${(m.successRate * 100).toFixed(0)}%`);
    lines.push(`  Avg cost: $${m.avgCostUsd.toFixed(2)} | Cost/success: $${m.costPerSuccess.toFixed(2)}`);
    lines.push(`  Avg time: ${dur} | Promotions: ${(m.promotionRate * 100).toFixed(0)}%`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format success patterns for Telegram display.
 */
export function formatPatternsReport(report: PatternReport): string {
  const lines = ['\uD83D\uDD0D Success Patterns', ''];

  if (report.topSuccessPatterns.length === 0) {
    lines.push('No pattern data yet. Run more goals!');
    return lines.join('\n');
  }

  lines.push('Top Success Combinations:');
  for (const p of report.topSuccessPatterns.slice(0, 8)) {
    lines.push(`  ${p.goalType} + ${p.model}: ${(p.successRate * 100).toFixed(0)}% (${p.runs} runs, $${p.avgCostUsd.toFixed(2)}/run)`);
  }

  if (report.failurePatterns.length > 0) {
    lines.push('');
    lines.push('High Failure Combinations:');
    for (const p of report.failurePatterns.slice(0, 5)) {
      lines.push(`  ${p.goalType} + ${p.model}: ${(p.failureRate * 100).toFixed(0)}% fail rate (${p.runs} runs)`);
    }
  }

  return lines.join('\n');
}
