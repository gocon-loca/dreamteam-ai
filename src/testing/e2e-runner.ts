/**
 * E2E Results Data Layer
 *
 * Tracks pass/fail history for E2E flows, detects regressions,
 * and provides health summaries. Reads/writes data/e2e-results.json.
 *
 * Agent-spawning execution was removed in favor of deterministic
 * Playwright tests (see playwright-runner.ts).
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { E2ETestResult, getCriticalFlows } from './e2e-registry.js';

const RESULTS_FILE = join(process.cwd(), 'data', 'e2e-results.json');

interface E2EResultsStore {
  lastFullRun: Record<string, Date>;  // project -> timestamp
  results: Record<string, Record<string, E2ETestResult>>;  // project -> flowId -> result
  regressions: Array<{
    project: string;
    flowId: string;
    detectedAt: Date;
    resolved: boolean;
  }>;
}

let resultsStore: E2EResultsStore | null = null;

function loadResults(): E2EResultsStore {
  if (resultsStore) return resultsStore;

  if (existsSync(RESULTS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
      resultsStore = {
        ...data,
        lastFullRun: Object.fromEntries(
          Object.entries(data.lastFullRun || {}).map(([k, v]) => [k, new Date(v as string)])
        ),
        results: Object.fromEntries(
          Object.entries(data.results || {}).map(([project, flows]) => [
            project,
            Object.fromEntries(
              Object.entries(flows as Record<string, E2ETestResult>).map(([flowId, result]) => [
                flowId,
                { ...result, timestamp: new Date(result.timestamp) },
              ])
            ),
          ])
        ),
        regressions: (data.regressions || []).map((r: { project: string; flowId: string; detectedAt: string; resolved: boolean }) => ({
          ...r,
          detectedAt: new Date(r.detectedAt),
        })),
      };
    } catch {
      resultsStore = { lastFullRun: {}, results: {}, regressions: [] };
    }
  } else {
    resultsStore = { lastFullRun: {}, results: {}, regressions: [] };
  }

  return resultsStore!;
}

function saveResults(): void {
  const store = loadResults();
  writeFileSync(RESULTS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Check if there are any active regressions for a project
 */
export function hasActiveRegressions(project: string): boolean {
  const store = loadResults();
  return store.regressions.some(r => r.project === project && !r.resolved);
}

/**
 * Get active regressions for a project
 */
export function getActiveRegressions(project: string): Array<{
  flowId: string;
  detectedAt: Date;
}> {
  const store = loadResults();
  return store.regressions
    .filter(r => r.project === project && !r.resolved)
    .map(r => ({ flowId: r.flowId, detectedAt: r.detectedAt }));
}

/**
 * Get last result for a specific flow
 */
export function getLastResult(project: string, flowId: string): E2ETestResult | undefined {
  const store = loadResults();
  return store.results[project]?.[flowId];
}

/**
 * Check if critical flows were passing and are now failing (regression)
 */
export function detectRegressions(
  project: string,
  newResults: E2ETestResult[]
): string[] {
  const store = loadResults();
  const regressions: string[] = [];

  for (const result of newResults) {
    // Record the result
    if (!store.results[project]) {
      store.results[project] = {};
    }
    const previousResult = store.results[project][result.flowId];
    store.results[project][result.flowId] = result;

    if (!result.passed) {
      if (previousResult?.passed) {
        // This was passing before, now failing = regression
        regressions.push(result.flowId);
        store.regressions.push({
          project,
          flowId: result.flowId,
          detectedAt: new Date(),
          resolved: false,
        });
      }
    }

    // Check if a regression is now resolved
    if (result.passed && previousResult && !previousResult.passed) {
      const regression = store.regressions.find(
        r => r.project === project && r.flowId === result.flowId && !r.resolved
      );
      if (regression) {
        regression.resolved = true;
      }
    }
  }

  store.lastFullRun[project] = new Date();
  saveResults();

  return regressions;
}

/**
 * Mark a regression as resolved
 */
export function resolveRegression(project: string, flowId: string): void {
  const store = loadResults();
  const regression = store.regressions.find(
    r => r.project === project && r.flowId === flowId && !r.resolved
  );
  if (regression) {
    regression.resolved = true;
    saveResults();
  }
}

/**
 * Get a summary of E2E health for all projects
 */
export function getE2EHealthSummary(): Record<string, {
  lastRun: Date | null;
  criticalFlowsPassing: number;
  criticalFlowsFailing: number;
  hasRegressions: boolean;
}> {
  const store = loadResults();
  const summary: Record<string, {
    lastRun: Date | null;
    criticalFlowsPassing: number;
    criticalFlowsFailing: number;
    hasRegressions: boolean;
  }> = {};

  for (const project of Object.keys(store.results)) {
    const criticalFlows = getCriticalFlows(project);
    let passing = 0;
    let failing = 0;

    for (const flow of criticalFlows) {
      const result = store.results[project]?.[flow.id];
      if (result?.passed) passing++;
      else failing++;
    }

    summary[project] = {
      lastRun: store.lastFullRun[project] ? new Date(store.lastFullRun[project]) : null,
      criticalFlowsPassing: passing,
      criticalFlowsFailing: failing,
      hasRegressions: hasActiveRegressions(project),
    };
  }

  return summary;
}
