/**
 * E2E Test Registry - Defines critical flows that MUST work for each project
 *
 * The orchestrator uses this registry to:
 * 1. Run E2E tests continuously during overnight work
 * 2. Verify all critical flows pass before marking goals complete
 * 3. Detect regressions and auto-create fix goals
 */

export interface E2EFlow {
  id: string;
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium';
  steps: string[];  // Human-readable steps for the agent to execute
  successCriteria: string[];
  timeout: number;  // ms
  dependencies?: string[];  // Other flow IDs that must pass first
}

export interface E2ETestResult {
  flowId: string;
  passed: boolean;
  timestamp: Date;
  duration: number;
  error?: string;
  screenshots?: string[];
  agentOutput?: string;
}

export interface E2ETestSuite {
  project: string;
  flows: E2EFlow[];
  lastRunAt?: Date;
  results: Map<string, E2ETestResult>;
}

/**
 * Registry of all E2E test flows by project.
 *
 * Add your project's flows here. Each flow defines a critical user journey
 * that must work. The orchestrator runs these to detect regressions.
 *
 * Example:
 *   'my-app': [
 *     { id: 'my-app-login', name: 'Login Flow', priority: 'critical',
 *       description: '...', steps: [...], successCriteria: [...], timeout: 60000 },
 *   ]
 */
export const E2E_FLOWS: Record<string, E2EFlow[]> = {
  // Add your project flows here. See E2EFlow interface for the shape.
  // Flows are keyed by project name (must match config/projects.yaml).
};

/**
 * Get all flows for a project, ordered by priority and dependencies
 */
export function getProjectFlows(project: string): E2EFlow[] {
  const flows = E2E_FLOWS[project] || [];

  // Sort by priority (critical first) then by dependencies
  return flows.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2 };
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }

    // If b depends on a, a should come first
    if (b.dependencies?.includes(a.id)) return -1;
    if (a.dependencies?.includes(b.id)) return 1;

    return 0;
  });
}

/**
 * Get critical flows only (must pass for goal completion)
 */
export function getCriticalFlows(project: string): E2EFlow[] {
  return getProjectFlows(project).filter(f => f.priority === 'critical');
}

/**
 * Map flow IDs to Playwright spec file paths (relative to tests/e2e/).
 * Used by playwright-runner.ts to filter which specs to run.
 *
 * Add entries as you create spec files, e.g.:
 *   'my-app-login': 'my-app/login.spec.ts',
 */
export const FLOW_TO_SPEC: Record<string, string> = {};
