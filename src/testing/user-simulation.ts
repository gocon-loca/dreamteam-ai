/**
 * User Simulation v1 — Real Haiku agent that tries natural language tasks
 *
 * A Haiku agent gets a simple task description (e.g. "Find a recording
 * about meetings and play it") and tries to accomplish it using Playwright
 * via the MCP server. Reports: success / failure / stuck points.
 *
 * If stuck, that's a UX issue worth logging ("button exists but user
 * can't find it"). Runs after all goals for a project complete in a
 * daemon cycle, or manually via /simulate Telegram command.
 *
 * Cost: ~$0.05-0.10 per simulation (Haiku + Playwright), runs once per
 * project per cycle = negligible.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runTask } from '../projects/task-runner.js';
import { getProject } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const RESULTS_FILE = join(DATA_DIR, 'user-simulation-results.json');

// ── Types ──────────────────────────────────────────────────

export interface UserTask {
  id: string;
  description: string;
  expectedOutcome: string;
}

export interface SimulationResult {
  taskId: string;
  taskDescription: string;
  project: string;
  success: boolean;
  stuckPoints: string[];
  analysis: string;
  durationMs: number;
  timestamp: string;
  costUsd: number;
}

export interface SimulationRunResult {
  project: string;
  results: SimulationResult[];
  overallSuccess: boolean;
  timestamp: string;
}

interface SimulationStore {
  runs: SimulationRunResult[];
  lastUpdated: string;
}

// ── Task Registry ──────────────────────────────────────────

/**
 * Predefined user journey tasks per project.
 * These represent real things a user would try to do.
 *
 * Add your project's tasks here, e.g.:
 *   'my-app': [
 *     { id: 'my-app-login', description: 'Log in and reach the dashboard',
 *       expectedOutcome: 'Should reach the dashboard after logging in' },
 *   ]
 */
export const USER_TASKS: Record<string, UserTask[]> = {
  // Add your project tasks here. See UserTask interface for the shape.
};

// ── Project URLs ───────────────────────────────────────────

/**
 * Get the base URL for a project from the registry, falling back to localhost.
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

// ── Core Simulation ────────────────────────────────────────

/**
 * Run a single user simulation task.
 *
 * Spawns a Haiku agent with Playwright access that tries to accomplish
 * the task as a real user would. Reports success, failures, and stuck points.
 */
export async function runUserSimulation(
  project: string,
  task: UserTask,
  onProgress?: (msg: string) => void
): Promise<SimulationResult> {
  const baseURL = getProjectUrl(project);
  if (!baseURL) {
    return {
      taskId: task.id,
      taskDescription: task.description,
      project,
      success: false,
      stuckPoints: ['Unknown project'],
      analysis: `No URL configured for project ${project}`,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      costUsd: 0,
    };
  }

  const prompt = `You are testing a web application as a REAL USER (not a developer).
You have access to Playwright MCP for browser automation.

## Your Task
${task.description}

## Application URL
${baseURL}

## Expected Outcome
${task.expectedOutcome}

## Instructions
1. Navigate to the application URL
2. Try to accomplish the task as a regular user would
3. If you get stuck, describe exactly WHERE you got stuck and WHY
4. Take screenshots at key moments
5. Do NOT look at source code or use developer tools — act like a user

## Report Format
At the end, output ONE of these:
- SIMULATION_SUCCESS: <what you accomplished>
- SIMULATION_STUCK: <where you got stuck and why>
- SIMULATION_FAIL: <what went wrong>

Include details about:
- What you clicked/typed
- What you saw on screen
- Where the UX was confusing (if anywhere)
- Any buttons/links that were hard to find`;

  const startTime = Date.now();

  try {
    onProgress?.(`Simulating: "${task.description}"`);

    const result = await runTask(project, prompt, {
      autonomous: false,
      maxIterations: 5,
      model: 'ancillary',
    });

    const durationMs = Date.now() - startTime;
    const output = result.output;

    // Parse result
    const isSuccess = output.includes('SIMULATION_SUCCESS');
    const isStuck = output.includes('SIMULATION_STUCK');

    // Extract stuck points
    const stuckPoints: string[] = [];
    const stuckMatch = output.match(/SIMULATION_STUCK:\s*(.+)/);
    if (stuckMatch) {
      stuckPoints.push(stuckMatch[1].trim());
    }

    // Extract analysis from the last portion of output
    const analysis = output.slice(-1000).trim();

    const simResult: SimulationResult = {
      taskId: task.id,
      taskDescription: task.description,
      project,
      success: isSuccess,
      stuckPoints,
      analysis,
      durationMs,
      timestamp: new Date().toISOString(),
      costUsd: result.costUsd || 0,
    };

    if (isSuccess) {
      onProgress?.(`  ✅ Success: ${task.id}`);
    } else if (isStuck) {
      onProgress?.(`  ⚠️ Stuck: ${task.id} — ${stuckPoints[0] || 'unknown'}`);
    } else {
      onProgress?.(`  ❌ Failed: ${task.id}`);
    }

    return simResult;
  } catch (error) {
    return {
      taskId: task.id,
      taskDescription: task.description,
      project,
      success: false,
      stuckPoints: [`Error: ${error instanceof Error ? error.message : String(error)}`],
      analysis: `Simulation crashed: ${error}`,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      costUsd: 0,
    };
  }
}

/**
 * Run all user simulation tasks for a project.
 */
export async function runProjectSimulation(
  project: string,
  onProgress?: (msg: string) => void
): Promise<SimulationRunResult> {
  const tasks = USER_TASKS[project];
  if (!tasks || tasks.length === 0) {
    onProgress?.(`No simulation tasks defined for ${project}`);
    return {
      project,
      results: [],
      overallSuccess: true,
      timestamp: new Date().toISOString(),
    };
  }

  onProgress?.(`Running ${tasks.length} user simulations for ${project}...`);

  const results: SimulationResult[] = [];
  for (const task of tasks) {
    const result = await runUserSimulation(project, task, onProgress);
    results.push(result);
  }

  const run: SimulationRunResult = {
    project,
    results,
    overallSuccess: results.every(r => r.success),
    timestamp: new Date().toISOString(),
  };

  // Persist results
  saveSimulationRun(run);

  const successCount = results.filter(r => r.success).length;
  const stuckCount = results.filter(r => r.stuckPoints.length > 0 && !r.success).length;
  onProgress?.(`Simulation complete: ${successCount}/${results.length} success, ${stuckCount} stuck`);

  return run;
}

// ── Persistence ────────────────────────────────────────────

function loadStore(): SimulationStore {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(RESULTS_FILE)) {
    return { runs: [], lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(RESULTS_FILE, 'utf-8')) as SimulationStore;
}

function saveSimulationRun(run: SimulationRunResult): void {
  const store = loadStore();
  store.runs.push(run);
  // Keep only last 50 runs
  if (store.runs.length > 50) {
    store.runs = store.runs.slice(-50);
  }
  store.lastUpdated = new Date().toISOString();
  writeFileSync(RESULTS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get recent simulation results for a project.
 */
export function getRecentSimulations(project: string, limit = 5): SimulationRunResult[] {
  const store = loadStore();
  return store.runs
    .filter(r => r.project === project)
    .slice(-limit);
}

/**
 * Get a formatted summary of recent simulation results.
 */
export function getSimulationSummary(): string {
  const store = loadStore();
  if (store.runs.length === 0) {
    return 'No user simulations recorded yet.';
  }

  let output = '**User Simulation Summary**\n\n';

  // Group by project, show latest run per project
  const latestByProject = new Map<string, SimulationRunResult>();
  for (const run of store.runs) {
    latestByProject.set(run.project, run);
  }

  for (const [project, run] of latestByProject) {
    const successCount = run.results.filter(r => r.success).length;
    const status = run.overallSuccess ? '✅' : '⚠️';
    const ago = Math.round((Date.now() - new Date(run.timestamp).getTime()) / 3600000);

    output += `${status} **${project}**: ${successCount}/${run.results.length} tasks succeeded (${ago}h ago)\n`;

    // Show stuck points
    const stuckResults = run.results.filter(r => r.stuckPoints.length > 0 && !r.success);
    for (const stuck of stuckResults) {
      output += `  - ${stuck.taskId}: ${stuck.stuckPoints[0]}\n`;
    }
  }

  return output;
}
