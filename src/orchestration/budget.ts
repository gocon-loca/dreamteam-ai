/**
 * Budget Manager - Track token usage and costs against plan limits
 *
 * Uses real USD from SQLite for cost tracking.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getRealBudgetData } from './model-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BudgetConfig {
  // Daily token limits (adjust based on your Claude plan)
  dailyTokenLimit: number;
  // Cost per 1K tokens (approximate)
  costPerKToken: number;
  // Maximum daily spend in dollars
  dailyBudget: number;
  // Reserve percentage - stop when this % of budget remains
  reservePercent: number;
}

export interface UsageStats {
  date: string;
  tokensUsed: number;
  estimatedCost: number;
  goalsCompleted: number;
  goalsBlocked: number;
  sessions: SessionUsage[];
}

export interface SessionUsage {
  goalId: string;
  project: string;
  startTime: string;
  endTime?: string;
  tokensUsed: number;
  iterations: number;
}

const DEFAULT_CONFIG: BudgetConfig = {
  dailyTokenLimit: 5_000_000,  // 5M tokens/day (adjust for your plan)
  costPerKToken: 0.003,        // ~$3 per 1M tokens (Sonnet estimate)
  dailyBudget: 20.00,          // $20/day max
  reservePercent: 10,          // Stop at 10% remaining
};

const DATA_DIR = join(__dirname, '../../data');
const USAGE_FILE = join(DATA_DIR, 'usage.json');
const CONFIG_FILE = join(DATA_DIR, 'budget-config.json');

function getTodayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function loadUsageStats(): UsageStats {
  const today = getTodayKey();

  if (!existsSync(USAGE_FILE)) {
    return createEmptyStats(today);
  }

  try {
    const content = readFileSync(USAGE_FILE, 'utf-8');
    const stats = JSON.parse(content) as UsageStats;

    // Reset if it's a new day
    if (stats.date !== today) {
      return createEmptyStats(today);
    }

    return stats;
  } catch {
    return createEmptyStats(today);
  }
}

function createEmptyStats(date: string): UsageStats {
  return {
    date,
    tokensUsed: 0,
    estimatedCost: 0,
    goalsCompleted: 0,
    goalsBlocked: 0,
    sessions: [],
  };
}

function saveUsageStats(stats: UsageStats): void {
  if (!existsSync(DATA_DIR)) {
    require('fs').mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(USAGE_FILE, JSON.stringify(stats, null, 2));
}

export function loadBudgetConfig(): BudgetConfig {
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveBudgetConfig(config: Partial<BudgetConfig>): void {
  const current = loadBudgetConfig();
  const merged = { ...current, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

export function recordTokenUsage(
  goalId: string,
  project: string,
  tokensUsed: number,
  iterations: number
): void {
  const stats = loadUsageStats();
  const config = loadBudgetConfig();

  stats.tokensUsed += tokensUsed;
  stats.estimatedCost = (stats.tokensUsed / 1000) * config.costPerKToken;

  // Find or create session
  let session = stats.sessions.find(s => s.goalId === goalId && !s.endTime);
  if (!session) {
    session = {
      goalId,
      project,
      startTime: new Date().toISOString(),
      tokensUsed: 0,
      iterations: 0,
    };
    stats.sessions.push(session);
  }

  session.tokensUsed += tokensUsed;
  session.iterations += iterations;

  saveUsageStats(stats);
}

export function endSession(goalId: string): void {
  const stats = loadUsageStats();
  const session = stats.sessions.find(s => s.goalId === goalId && !s.endTime);
  if (session) {
    session.endTime = new Date().toISOString();
    saveUsageStats(stats);
  }
}

export function recordGoalCompleted(): void {
  const stats = loadUsageStats();
  stats.goalsCompleted++;
  saveUsageStats(stats);
}

export function recordGoalBlocked(): void {
  const stats = loadUsageStats();
  stats.goalsBlocked++;
  saveUsageStats(stats);
}

export interface BudgetStatus {
  tokensUsed: number;
  tokensRemaining: number;
  percentUsed: number;
  estimatedCost: number;
  budgetRemaining: number;
  canContinue: boolean;
  shouldThrottle: boolean;
  reason?: string;
}

export function checkBudget(): BudgetStatus {
  const config = loadBudgetConfig();

  // Prefer real USD from SQLite, fall back to estimated tokens
  let realCostUsd: number | null = null;
  try {
    const real = getRealBudgetData();
    realCostUsd = real.todayUsd;
  } catch {
    // SQLite not available — fall back to estimates
  }

  const stats = loadUsageStats();
  const costUsed = realCostUsd ?? stats.estimatedCost;
  const tokensRemaining = config.dailyTokenLimit - stats.tokensUsed;
  const percentUsed = realCostUsd !== null
    ? (costUsed / config.dailyBudget) * 100
    : (stats.tokensUsed / config.dailyTokenLimit) * 100;
  const budgetRemaining = config.dailyBudget - costUsed;

  const reserveThreshold = 100 - config.reservePercent;

  let canContinue = true;
  let shouldThrottle = false;
  let reason: string | undefined;

  // Check if we've exceeded budget (real USD preferred)
  if (costUsed >= config.dailyBudget) {
    canContinue = false;
    reason = `Daily budget exhausted ($${costUsed.toFixed(2)} / $${config.dailyBudget})`;
  }
  // Check if we're approaching limits (throttle mode)
  else if (percentUsed >= reserveThreshold) {
    shouldThrottle = true;
    reason = `Approaching budget limit (${percentUsed.toFixed(1)}% used, $${costUsed.toFixed(2)} spent)`;
  }

  return {
    tokensUsed: stats.tokensUsed,
    tokensRemaining,
    percentUsed,
    estimatedCost: costUsed,
    budgetRemaining,
    canContinue,
    shouldThrottle,
    reason,
  };
}

export function getUsageSummary(): string {
  const config = loadBudgetConfig();
  const status = checkBudget();

  // Try real data from SQLite first
  let realData: { todayUsd: number; weekUsd: number; runCountToday: number; byProject: Record<string, number>; byModel: Record<string, number> } | null = null;
  try {
    realData = getRealBudgetData();
  } catch { /* SQLite not available */ }

  if (realData) {
    const lines = [
      `💰 Budget Status (${new Date().toISOString().split('T')[0]})`,
      ``,
      `Today: $${realData.todayUsd.toFixed(2)} / $${config.dailyBudget.toFixed(2)} (${status.percentUsed.toFixed(1)}%)`,
      `This week: $${realData.weekUsd.toFixed(2)}`,
      `Runs today: ${realData.runCountToday}`,
    ];

    if (Object.keys(realData.byProject).length > 0) {
      lines.push(``, `By project:`);
      for (const [project, cost] of Object.entries(realData.byProject)) {
        lines.push(`  ${project}: $${cost.toFixed(2)}`);
      }
    }

    if (Object.keys(realData.byModel).length > 0) {
      lines.push(``, `By model:`);
      for (const [model, cost] of Object.entries(realData.byModel)) {
        lines.push(`  ${model}: $${cost.toFixed(2)}`);
      }
    }

    if (status.reason) {
      lines.push(``, `⚠️ ${status.reason}`);
    }

    return lines.join('\n');
  }

  // Fallback to legacy stats
  const stats = loadUsageStats();
  const lines = [
    `📊 Budget Status (${stats.date})`,
    ``,
    `Cost: $${stats.estimatedCost.toFixed(2)} / $${config.dailyBudget.toFixed(2)} (estimated)`,
    `Goals: ${stats.goalsCompleted} completed, ${stats.goalsBlocked} blocked`,
  ];

  if (status.reason) {
    lines.push(``, `⚠️ ${status.reason}`);
  }

  return lines.join('\n');
}

// Estimate tokens for a prompt (rough: ~4 chars per token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
