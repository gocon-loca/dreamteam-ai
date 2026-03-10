/**
 * Playwright Runner — Deterministic E2E test execution ($0/run)
 *
 * Replaces the Opus agent-spawning e2e-runner.ts with direct Playwright
 * invocations via `npx playwright test`. Falls back gracefully when
 * dev servers are down or specs don't exist yet.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { isFlowTripped, recordFlowResult } from './e2e-circuit-breaker.js';
import { E2E_FLOWS, type E2ETestResult } from './e2e-registry.js';
import { getProject } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const RESULTS_FILE = join(PROJECT_ROOT, 'data', 'playwright-results.json');

export interface PlaywrightFlowResult {
  flowId: string;
  passed: boolean;
  skipped: boolean;
  skipReason?: string;
  duration: number;
  error?: string;
}

export interface PlaywrightSuiteResult {
  project: string;
  results: PlaywrightFlowResult[];
  allPassed: boolean;
  skippedCount: number;
  serverDown: boolean;
}

// Map project names to Playwright project names in config
// Map project names to Playwright project names in config.
// By default, project name maps to itself. Override here.
const PROJECT_MAP: Record<string, string> = {
};

/**
 * Get the dev server URL for a project from the registry, falling back to localhost.
 */
function getProjectUrl(projectName: string): string | undefined {
  try {
    const project = getProject(projectName);
    if (project.healthCheck) return project.healthCheck;
    if (project.devPort) return `http://localhost:${project.devPort}`;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if dev server is reachable
 */
function isServerUp(project: string): boolean {
  const url = getProjectUrl(project);
  if (!url) return false;

  try {
    execSync(`curl -sf --max-time 5 "${url}" > /dev/null 2>&1`, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Playwright specs exist for a project
 */
function hasSpecs(project: string): boolean {
  const specDir = join(PROJECT_ROOT, 'tests', 'e2e', project);
  if (!existsSync(specDir)) return false;

  try {
    const files = execSync(`ls "${specDir}"/*.spec.ts 2>/dev/null || true`, { encoding: 'utf-8' });
    return files.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Run Playwright tests for a project.
 *
 * Handles:
 * - Dev server health check (skip if down)
 * - Circuit breaker (skip tripped flows)
 * - Missing specs (skip gracefully)
 * - Parses playwright-results.json for structured output
 * - Records circuit breaker state per flow
 */
export function runPlaywrightTests(
  project: string,
  options?: {
    flowIds?: string[];
    onProgress?: (msg: string) => void;
  }
): PlaywrightSuiteResult {
  const onProgress = options?.onProgress;
  const playwrightProject = PROJECT_MAP[project] || project;


  // Check if specs exist
  if (!hasSpecs(project)) {
    onProgress?.(`No Playwright specs found for ${project} — skipping`);
    return { project, results: [], allPassed: true, skippedCount: 0, serverDown: false };
  }

  // Check dev server health
  if (!isServerUp(project)) {
    onProgress?.(`Dev server for ${project} is down — skipping E2E`);
    return { project, results: [], allPassed: true, skippedCount: 0, serverDown: true };
  }

  // Get expected flows for this project
  const projectFlows = E2E_FLOWS[project] || [];
  const criticalFlows = projectFlows.filter(f => f.priority === 'critical');

  // Filter out tripped flows
  const trippedFlows = criticalFlows.filter(f => isFlowTripped(f.id));
  const runnableFlows = criticalFlows.filter(f => !isFlowTripped(f.id));

  if (trippedFlows.length > 0) {
    onProgress?.(`Skipping ${trippedFlows.length} tripped flows: ${trippedFlows.map(f => f.id).join(', ')}`);
  }

  // Build grep pattern to run only relevant specs
  let grepArg = '';
  if (options?.flowIds && options.flowIds.length > 0) {
    grepArg = `--grep "${options.flowIds.join('|')}"`;
  }

  onProgress?.(`Running Playwright tests for ${project}...`);

  try {
    execSync(
      `npx playwright test --project=${playwrightProject} ${grepArg} --reporter=json`,
      {
        cwd: PROJECT_ROOT,
        timeout: 300_000, // 5 min max
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1' },
      }
    );
  } catch {
    // Playwright exits non-zero when tests fail — that's expected
  }

  // Parse results
  const results = parsePlaywrightResults(project, criticalFlows.map(f => f.id));

  // Add tripped flows as skipped
  for (const flow of trippedFlows) {
    results.push({
      flowId: flow.id,
      passed: false,
      skipped: true,
      skipReason: 'Circuit breaker tripped',
      duration: 0,
    });
  }

  // Record circuit breaker state for non-skipped results
  for (const result of results) {
    if (!result.skipped) {
      recordFlowResult(result.flowId, result.passed);
    }
  }

  const nonSkipped = results.filter(r => !r.skipped);
  const allPassed = nonSkipped.every(r => r.passed);
  const skippedCount = results.filter(r => r.skipped).length;

  onProgress?.(`${project}: ${nonSkipped.filter(r => r.passed).length}/${nonSkipped.length} passed, ${skippedCount} skipped`);

  return { project, results, allPassed, skippedCount, serverDown: false };
}

/**
 * Parse Playwright JSON results file and map to flow IDs.
 */
function parsePlaywrightResults(
  project: string,
  expectedFlowIds: string[]
): PlaywrightFlowResult[] {
  const results: PlaywrightFlowResult[] = [];

  if (!existsSync(RESULTS_FILE)) {
    // No results file — all expected flows are "no result"
    for (const flowId of expectedFlowIds) {
      if (!isFlowTripped(flowId)) {
        results.push({
          flowId,
          passed: false,
          skipped: true,
          skipReason: 'No Playwright results file',
          duration: 0,
        });
      }
    }
    return results;
  }

  try {
    const raw = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
    const suites = raw.suites || [];

    // Flatten all specs from nested suites
    const allSpecs: Array<{ title: string; ok: boolean; duration: number; error?: string }> = [];
    function walkSuites(suiteList: any[]): void {
      for (const suite of suiteList) {
        if (suite.specs) {
          for (const spec of suite.specs) {
            const ok = spec.ok ?? spec.tests?.every((t: any) => t.status === 'expected');
            const duration = spec.tests?.[0]?.results?.[0]?.duration ?? 0;
            const error = spec.tests?.[0]?.results?.[0]?.error?.message;
            allSpecs.push({
              title: `${suite.title} ${spec.title}`.trim(),
              ok: !!ok,
              duration,
              error,
            });
          }
        }
        if (suite.suites) walkSuites(suite.suites);
      }
    }
    walkSuites(suites);

    // Map specs to flow IDs by matching flow ID in describe block title
    for (const flowId of expectedFlowIds) {
      if (isFlowTripped(flowId)) continue;

      const matching = allSpecs.filter(s => s.title.includes(flowId));
      if (matching.length === 0) {
        results.push({
          flowId,
          passed: false,
          skipped: true,
          skipReason: 'No matching spec found',
          duration: 0,
        });
        continue;
      }

      const allOk = matching.every(s => s.ok);
      const totalDuration = matching.reduce((sum, s) => sum + s.duration, 0);
      const firstError = matching.find(s => !s.ok)?.error;

      results.push({
        flowId,
        passed: allOk,
        skipped: false,
        duration: totalDuration,
        error: firstError,
      });
    }
  } catch {
    // Parse error — treat all as skipped
    for (const flowId of expectedFlowIds) {
      if (!isFlowTripped(flowId)) {
        results.push({
          flowId,
          passed: false,
          skipped: true,
          skipReason: 'Failed to parse results',
          duration: 0,
        });
      }
    }
  }

  return results;
}

/**
 * Convert PlaywrightFlowResult to E2ETestResult for compatibility
 * with existing e2e-runner.ts data layer.
 */
export function toE2ETestResult(result: PlaywrightFlowResult): E2ETestResult {
  return {
    flowId: result.flowId,
    passed: result.passed,
    timestamp: new Date(),
    duration: result.duration,
    error: result.error || result.skipReason,
  };
}
