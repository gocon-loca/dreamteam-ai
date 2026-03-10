/**
 * Weekly Optimization Report — Analyzes 7 days of system performance data
 * and generates actionable recommendations.
 *
 * Data sources:
 * - model_task_memory (success rates, costs, model selection)
 * - agent_runs (execution details, cross-check results, tokens)
 * - human_feedback (positive, negative, redo counts)
 * - director_interactions (goal creation, Director costs)
 * - goals.json (goal statuses, throughput)
 *
 * Usage: Called by /optimize Telegram command or weekly digest.
 */

import { getDb } from '../db/index.js';
import {
  getSuccessPatterns,
  getCostBreakdown,
  getModelEfficiency,
  getArchetypePerformance,
} from './patterns.js';
import { getFeedbackStats } from '../db/feedback.js';
import { getDirectorCostSummary } from '../db/director-log.js';
import { getAllGoals } from '../orchestration/goal-manager.js';

// ── Types ──────────────────────────────────────────────────

export interface OptimizationReport {
  period: { start: string; end: string };

  // Section 1: Throughput
  throughput: {
    goalsCompleted: number;
    goalsFailed: number;
    goalsBlocked: number;
    totalRuns: number;
    overallSuccessRate: number;
  };

  // Section 2: Cost Analysis
  cost: {
    totalCostUsd: number;
    agentCostUsd: number;
    directorCostUsd: number;
    avgCostPerGoal: number;
    costPerSuccess: number;
    byProject: Array<{ project: string; costUsd: number; runs: number }>;
    byModel: Array<{ model: string; costUsd: number; runs: number }>;
  };

  // Section 3: Model Performance
  modelPerformance: Array<{
    model: string;
    runs: number;
    successRate: number;
    avgCostUsd: number;
    costPerSuccess: number;
    promotionRate: number;
  }>;

  // Section 4: Archetype Performance
  archetypePerformance: Array<{
    archetype: string;
    runs: number;
    successRate: number;
    avgCostUsd: number;
    topModel: string;
  }>;

  // Section 5: Quality Signals
  quality: {
    crossCheckConcerns: number;
    crossCheckClean: number;
    feedbackPositive: number;
    feedbackNegative: number;
    feedbackRedos: number;
    avgQualityScore: number | null;
  };

  // Section 6: Recommendations
  recommendations: OptimizationRecommendation[];
}

export interface OptimizationRecommendation {
  category: 'cost' | 'quality' | 'routing' | 'throughput';
  severity: 'info' | 'warning' | 'action';
  title: string;
  detail: string;
}

// ── Report Generation ──────────────────────────────────────

/**
 * Generate a weekly optimization report analyzing the last N days of data.
 */
export function generateOptimizationReport(days = 7): OptimizationReport {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  const sinceStr = start.toISOString();

  const db = getDb();

  // ── Throughput ──────────────────────────────────────────
  const goals = getAllGoals();
  const periodGoals = goals.filter(g => {
    const completedAt = g.completedAt ? new Date(g.completedAt) : null;
    return completedAt && completedAt >= start && completedAt <= end;
  });
  const goalsCompleted = periodGoals.filter(g => g.status === 'completed').length;
  const goalsFailed = periodGoals.filter(g => g.status === 'failed').length;
  const goalsBlocked = goals.filter(g => g.status === 'blocked').length; // current, not period

  const runTotals = db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN exit_signal = 'GOAL_COMPLETE' THEN 1 ELSE 0 END) as successes
    FROM agent_runs
    WHERE started_at >= ?
  `).get(sinceStr) as { total_runs: number; successes: number };

  const throughput = {
    goalsCompleted,
    goalsFailed,
    goalsBlocked,
    totalRuns: runTotals.total_runs,
    overallSuccessRate: runTotals.total_runs > 0
      ? runTotals.successes / runTotals.total_runs
      : 0,
  };

  // ── Cost Analysis ──────────────────────────────────────
  const costReport = getCostBreakdown('week');
  const directorCost = getDirectorCostSummary(sinceStr);

  const totalCostUsd = costReport.totalCostUsd + directorCost.totalCostUsd;
  const costPerSuccess = runTotals.successes > 0
    ? costReport.totalCostUsd / runTotals.successes
    : 0;

  const cost = {
    totalCostUsd,
    agentCostUsd: costReport.totalCostUsd,
    directorCostUsd: directorCost.totalCostUsd,
    avgCostPerGoal: costReport.avgCostPerGoal,
    costPerSuccess,
    byProject: costReport.byProject,
    byModel: costReport.byModel,
  };

  // ── Model Performance ──────────────────────────────────
  const efficiency = getModelEfficiency();
  const modelPerformance = efficiency.models.map(m => ({
    model: m.model,
    runs: m.totalRuns,
    successRate: m.successRate,
    avgCostUsd: m.avgCostUsd,
    costPerSuccess: m.costPerSuccess,
    promotionRate: m.promotionRate,
  }));

  // ── Archetype Performance ──────────────────────────────
  const archetypeReport = getArchetypePerformance();
  const archetypePerformance = archetypeReport.archetypes.map(a => ({
    archetype: a.archetype,
    runs: a.totalRuns,
    successRate: a.successRate,
    avgCostUsd: a.avgCostUsd,
    topModel: a.topModel,
  }));

  // ── Quality Signals ────────────────────────────────────
  const crossCheckStats = db.prepare(`
    SELECT
      SUM(CASE WHEN cross_check_result = 'CONCERN' THEN 1 ELSE 0 END) as concerns,
      SUM(CASE WHEN cross_check_result = 'CLEAN' THEN 1 ELSE 0 END) as clean
    FROM agent_runs
    WHERE started_at >= ? AND cross_check_result IS NOT NULL
  `).get(sinceStr) as { concerns: number; clean: number };

  const feedbackStats = getFeedbackStats();

  const avgQualityRow = db.prepare(`
    SELECT AVG(quality_score) as avg_qs
    FROM agent_runs
    WHERE started_at >= ? AND quality_score IS NOT NULL
  `).get(sinceStr) as { avg_qs: number | null };

  const quality = {
    crossCheckConcerns: crossCheckStats.concerns ?? 0,
    crossCheckClean: crossCheckStats.clean ?? 0,
    feedbackPositive: feedbackStats.positive ?? 0,
    feedbackNegative: feedbackStats.negative ?? 0,
    feedbackRedos: feedbackStats.redos ?? 0,
    avgQualityScore: avgQualityRow.avg_qs,
  };

  // ── Recommendations ────────────────────────────────────
  const recommendations = generateRecommendations({
    throughput,
    cost,
    modelPerformance,
    archetypePerformance,
    quality,
  });

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    throughput,
    cost,
    modelPerformance,
    archetypePerformance,
    quality,
    recommendations,
  };
}

// ── Recommendation Engine ────────────────────────────────

function generateRecommendations(data: {
  throughput: OptimizationReport['throughput'];
  cost: OptimizationReport['cost'];
  modelPerformance: OptimizationReport['modelPerformance'];
  archetypePerformance: OptimizationReport['archetypePerformance'];
  quality: OptimizationReport['quality'];
}): OptimizationRecommendation[] {
  const recs: OptimizationRecommendation[] = [];

  // Cost recommendations
  if (data.cost.costPerSuccess > 5.0) {
    recs.push({
      category: 'cost',
      severity: 'warning',
      title: 'High cost per successful goal',
      detail: `$${data.cost.costPerSuccess.toFixed(2)}/success. Consider routing more routine tasks to Sonnet to reduce cost.`,
    });
  }

  if (data.cost.directorCostUsd > data.cost.agentCostUsd * 0.3) {
    recs.push({
      category: 'cost',
      severity: 'info',
      title: 'Director cost is high relative to agent work',
      detail: `Director: $${data.cost.directorCostUsd.toFixed(2)} vs Agents: $${data.cost.agentCostUsd.toFixed(2)}. Consider batching Director conversations.`,
    });
  }

  // Quality recommendations
  const totalCrossChecks = data.quality.crossCheckConcerns + data.quality.crossCheckClean;
  if (totalCrossChecks > 0 && data.quality.crossCheckConcerns / totalCrossChecks > 0.3) {
    recs.push({
      category: 'quality',
      severity: 'warning',
      title: 'High cross-check concern rate',
      detail: `${data.quality.crossCheckConcerns}/${totalCrossChecks} runs flagged concerns (${((data.quality.crossCheckConcerns / totalCrossChecks) * 100).toFixed(0)}%). Review goal specs for clarity.`,
    });
  }

  if (data.quality.feedbackRedos > 3) {
    recs.push({
      category: 'quality',
      severity: 'action',
      title: 'Multiple redo requests',
      detail: `${data.quality.feedbackRedos} redos requested. Investigate common failure patterns and improve goal specs.`,
    });
  }

  // Model routing recommendations
  for (const model of data.modelPerformance) {
    if (model.runs >= 5 && model.successRate < 0.4) {
      recs.push({
        category: 'routing',
        severity: 'action',
        title: `Low success rate for ${model.model}`,
        detail: `${(model.successRate * 100).toFixed(0)}% success across ${model.runs} runs. Consider switching goal types away from this model.`,
      });
    }

    if (model.promotionRate > 0.5 && model.runs >= 3) {
      recs.push({
        category: 'routing',
        severity: 'info',
        title: `Frequent promotions from ${model.model}`,
        detail: `${(model.promotionRate * 100).toFixed(0)}% of runs promoted. Consider starting these goal types at a higher tier.`,
      });
    }
  }

  // Archetype recommendations
  for (const arch of data.archetypePerformance) {
    if (arch.runs >= 5 && arch.successRate < 0.3) {
      recs.push({
        category: 'routing',
        severity: 'warning',
        title: `${arch.archetype} archetype struggling`,
        detail: `${(arch.successRate * 100).toFixed(0)}% success across ${arch.runs} runs. Review archetype prompt and context docs.`,
      });
    }
  }

  // Throughput recommendations
  if (data.throughput.goalsBlocked > 3) {
    recs.push({
      category: 'throughput',
      severity: 'action',
      title: 'Multiple goals currently blocked',
      detail: `${data.throughput.goalsBlocked} goals blocked. Review blockers and unblock or remove stale goals.`,
    });
  }

  if (data.throughput.totalRuns > 0 && data.throughput.overallSuccessRate < 0.5) {
    recs.push({
      category: 'throughput',
      severity: 'warning',
      title: 'Overall success rate below 50%',
      detail: `${(data.throughput.overallSuccessRate * 100).toFixed(0)}% success across ${data.throughput.totalRuns} runs. Focus on goal spec quality and model routing.`,
    });
  }

  return recs;
}

// ── Formatting ─────────────────────────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
  info: '\u2139\uFE0F',
  warning: '\u26A0\uFE0F',
  action: '\uD83D\uDEA8',
};

/**
 * Format optimization report for Telegram display.
 */
export function formatOptimizationReport(report: OptimizationReport): string {
  const lines: string[] = [];
  const startDate = new Date(report.period.start).toLocaleDateString();
  const endDate = new Date(report.period.end).toLocaleDateString();

  lines.push(`\uD83D\uDCCA Weekly Optimization Report`);
  lines.push(`${startDate} - ${endDate}`);
  lines.push('');

  // Throughput
  lines.push('\uD83D\uDCCB Throughput');
  lines.push(`  Completed: ${report.throughput.goalsCompleted} | Failed: ${report.throughput.goalsFailed} | Blocked: ${report.throughput.goalsBlocked}`);
  lines.push(`  Agent runs: ${report.throughput.totalRuns} | Success: ${(report.throughput.overallSuccessRate * 100).toFixed(0)}%`);
  lines.push('');

  // Cost
  lines.push('\uD83D\uDCB0 Cost');
  lines.push(`  Total: $${report.cost.totalCostUsd.toFixed(2)} (agents: $${report.cost.agentCostUsd.toFixed(2)}, director: $${report.cost.directorCostUsd.toFixed(2)})`);
  lines.push(`  Per goal: $${report.cost.avgCostPerGoal.toFixed(2)} | Per success: $${report.cost.costPerSuccess.toFixed(2)}`);
  if (report.cost.byProject.length > 0) {
    lines.push('  By project: ' + report.cost.byProject.map(p =>
      `${p.project} $${p.costUsd.toFixed(2)}`
    ).join(', '));
  }
  lines.push('');

  // Model Performance
  if (report.modelPerformance.length > 0) {
    lines.push('\uD83E\uDD16 Models');
    for (const m of report.modelPerformance) {
      lines.push(`  ${m.model}: ${(m.successRate * 100).toFixed(0)}% success, $${m.avgCostUsd.toFixed(2)}/run, ${m.runs} runs`);
    }
    lines.push('');
  }

  // Archetype Performance
  if (report.archetypePerformance.length > 0) {
    lines.push('\uD83C\uDFAD Archetypes');
    for (const a of report.archetypePerformance) {
      lines.push(`  ${a.archetype}: ${(a.successRate * 100).toFixed(0)}% success, ${a.runs} runs (${a.topModel})`);
    }
    lines.push('');
  }

  // Quality
  lines.push('\u2728 Quality');
  const totalChecks = report.quality.crossCheckConcerns + report.quality.crossCheckClean;
  if (totalChecks > 0) {
    lines.push(`  Cross-check: ${report.quality.crossCheckClean} clean, ${report.quality.crossCheckConcerns} concerns`);
  }
  lines.push(`  Feedback: +${report.quality.feedbackPositive} / -${report.quality.feedbackNegative} / ${report.quality.feedbackRedos} redos`);
  if (report.quality.avgQualityScore !== null) {
    lines.push(`  Avg quality score: ${report.quality.avgQualityScore.toFixed(1)}`);
  }
  lines.push('');

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push('\uD83D\uDCA1 Recommendations');
    for (const rec of report.recommendations) {
      lines.push(`  ${SEVERITY_EMOJI[rec.severity]} [${rec.category}] ${rec.title}`);
      lines.push(`    ${rec.detail}`);
    }
  } else {
    lines.push('\u2705 No optimization recommendations — system performing well!');
  }

  return lines.join('\n');
}
