/**
 * PM Agent Types — Product Manager quality assurance system
 */

export interface SmokeTestResult {
  project: string;
  timestamp: string;
  baseUrl: string;
  pages: PageResult[];
  flows: FlowResult[];
  consoleErrors: ConsoleError[];
  summary: {
    pagesChecked: number;
    pagesPassed: number;
    pagesFailed: number;
    flowsChecked: number;
    flowsPassed: number;
    flowsFailed: number;
    consoleErrorCount: number;
  };
}

export interface PageResult {
  path: string;
  status: number;
  title: string;
  loadTimeMs: number;
  hasContent: boolean;
  error?: string;
}

export interface FlowResult {
  name: string;
  steps: FlowStep[];
  passed: boolean;
  failedAt?: string;
  error?: string;
  durationMs: number;
}

export interface FlowStep {
  action: string;
  passed: boolean;
  detail?: string;
}

export interface ConsoleError {
  page: string;
  message: string;
  source?: string;
}

export interface PMIssue {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'broken-flow' | 'server-error' | 'empty-page' | 'console-error' | 'slow-load' | 'ux-issue';
  title: string;
  description: string;
  affectedPages: string[];
  acceptanceCriteria: string[];
}

export interface PMFindings {
  project: string;
  timestamp: string;
  smokeResults: SmokeTestResult;
  issues: PMIssue[];
  goalsCreated: string[];
  costUsd: number;
}

export interface ProductBrief {
  project: string;
  content: string;
  routes: string[];
}
