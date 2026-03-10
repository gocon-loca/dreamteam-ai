/**
 * Goal type definitions — pure types with zero runtime imports.
 */

export type GoalStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed';
export type GoalComplexity = 'routine' | 'complex';
export type ReviewStatus = 'pending_review' | 'approved' | 'needs_work';

export interface Goal {
  id: string;
  project: string;
  title: string;
  description?: string;
  status: GoalStatus;
  complexity?: GoalComplexity;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  blockedReason?: string;
  assumptions: string[];
  iterations: number;
  output?: string;
  // Linear integration
  linearId?: string;
  // Triage confidence
  confidence?: 'green' | 'yellow';
  approvedAt?: string;
  // Dependency enforcement — hard gate in dispatch
  dependsOn?: string[];
  // Archetype override (auto-classified if not set)
  archetype?: 'backend' | 'frontend' | 'fullstack';
  // Visual review status — set after completion, updated by user feedback
  reviewStatus?: ReviewStatus;
  // Last rejection details — set by smoke test / review agent for rich Telegram messages
  lastRejectionReason?: string;
  // Attempt counter — incremented on each dispatch, drives model escalation
  attemptCount?: number;
  // Source tag — e.g. "jam:{jamId}" for Jam-sourced goals, "pm-sweep" for PM agent
  source?: string;
  // Pre-fetched Jam context for jam-sourced goals (enriched via jam-enrichment.ts)
  jamContext?: {
    screenshotUrl?: string;
    transcript?: string;
    description?: string;
    consoleLogs?: string;      // Formatted JS errors from Jam recording
    failedRequests?: string;   // Failed API calls summary (method, path, status)
    userEvents?: string;       // User interaction sequence (click/type/navigate)
  };
  // Dedup warning — set by addGoal when similar goals exist
  dupWarning?: string;
  // Parsed debrief from agent output
  debrief?: Record<string, unknown>;
  // Timeout race condition flag — set when agent is stale but GOAL_COMPLETE is in buffer
  timedOut?: boolean;
}

export interface GoalsStore {
  goals: Goal[];
  lastUpdated: string;
}

export interface StructuredDebrief {
  goalId: string;
  project: string;
  title: string;
  completedAt: string;
  commits: string[];
  working: string;
  broken: string;
  tests: string;
  verified: string;                 // What the agent verified before GOAL_COMPLETE
  confidence: string;
  next: string;
  groundTruthCommits: string[];
  retestPassed: boolean | null;
  smokeTestPassed?: boolean;        // From post-completion smoke test
  qualityWarnings?: string[];       // Placeholder data, empty pages, etc.
  reviewConcerns?: string;          // From cross-check review agent
  reviewVerdict?: string;           // 'approve' | 'reject' | 'concern' from review agent
  reviewFeedback?: string;          // Detailed feedback from review agent
  reviewBackend?: string;           // 'claude-code' | 'legacy-sonnet'
  reviewAvgConfidence?: number;     // Average confidence across findings (CC only)
  reviewFilteredCount?: number;     // Low-confidence findings filtered out (CC only)
  reviewPrUrl?: string;             // GitHub PR URL if created (Phase 4)
  behavioralVerifyPassed?: boolean;
  behavioralVerifySummary?: string;
  behavioralVerifyCostUsd?: number;
  visualReviewVerdict?: 'better' | 'same' | 'worse' | 'mixed';
  visualReviewSummary?: string;
  visualReviewCostUsd?: number;
  simulationResults?: { passed: number; total: number; stuckPoints: string[] };
  secretScanWarnings?: string[];
}
