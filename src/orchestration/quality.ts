/**
 * Quality & Calibration System
 *
 * Agents log their assessments of work quality. Humans calibrate.
 * Over time, the system learns what "good" really means.
 *
 * Features:
 * - Self-assessment: Agents rate their own work
 * - Escalation: Agents can flag concerns and uncertainties
 * - Calibration: Human provides ground truth feedback
 * - Learning: System tracks calibration delta over time
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const QUALITY_FILE = join(DATA_DIR, 'quality-log.json');
const CALIBRATION_FILE = join(DATA_DIR, 'calibration-history.json');

// Confidence levels agents can report
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'uncertain';

// Types of concerns agents can escalate
export type ConcernType =
  | 'quality' // Work might not meet standards
  | 'scope' // Unclear if this is what was wanted
  | 'breaking' // Might break existing functionality
  | 'security' // Potential security implications
  | 'architecture' // Architectural concern
  | 'performance' // Performance implications
  | 'other';

export interface SelfAssessment {
  id: string;
  goalId: string;
  project: string;
  timestamp: string;

  // What the agent thinks
  workingWell: string[]; // Things agent thinks are good
  notWorkingWell: string[]; // Things agent thinks need work
  confidence: ConfidenceLevel;
  confidenceReason: string;

  // Specific claims for calibration
  claims: AssessmentClaim[];

  // Optional escalation
  escalation?: Escalation;

  // Human calibration (filled in later)
  calibration?: HumanCalibration;
}

export interface AssessmentClaim {
  claim: string; // "The login flow works correctly"
  confidence: ConfidenceLevel;
  evidence?: string; // "Tested with puppeteer, screenshot attached"
}

export interface Escalation {
  type: ConcernType;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  suggestedAction?: string;
  needsHumanDecision: boolean;
}

export interface HumanCalibration {
  timestamp: string;
  reviewer: string; // "telegram" or specific identifier

  // Rating of agent's self-assessment accuracy
  assessmentAccuracy: 'accurate' | 'overconfident' | 'underconfident' | 'mixed';

  // Specific feedback on claims
  claimFeedback: {
    claimIndex: number;
    wasCorrect: boolean;
    feedback?: string;
  }[];

  // Overall quality rating
  actualQuality: 'excellent' | 'good' | 'acceptable' | 'needs-work' | 'poor';

  // Free-form notes for learning
  notes?: string;

  // Direction for future work
  direction?: string;
}

interface QualityStore {
  assessments: SelfAssessment[];
  lastUpdated: string;
}

interface CalibrationStats {
  totalAssessments: number;
  calibrated: number;
  uncalibrated: number;
  accuracyRate: number; // % of assessments rated "accurate"
  overconfidenceRate: number;
  underconfidenceRate: number;
  byProject: Record<string, {
    total: number;
    accuracyRate: number;
  }>;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadQuality(): QualityStore {
  ensureDataDir();
  if (existsSync(QUALITY_FILE)) {
    return JSON.parse(readFileSync(QUALITY_FILE, 'utf-8'));
  }
  return { assessments: [], lastUpdated: new Date().toISOString() };
}

function saveQuality(store: QualityStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(QUALITY_FILE, JSON.stringify(store, null, 2));
}

/**
 * Agent submits a self-assessment of their work
 */
export function submitAssessment(assessment: Omit<SelfAssessment, 'id' | 'timestamp'>): SelfAssessment {
  const store = loadQuality();

  const fullAssessment: SelfAssessment = {
    ...assessment,
    id: `qa-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
  };

  store.assessments.push(fullAssessment);
  saveQuality(store);

  return fullAssessment;
}

/**
 * Agent escalates a concern
 */
export function escalateConcern(
  goalId: string,
  project: string,
  escalation: Escalation
): SelfAssessment {
  return submitAssessment({
    goalId,
    project,
    workingWell: [],
    notWorkingWell: [],
    confidence: 'uncertain',
    confidenceReason: `Escalating: ${escalation.description}`,
    claims: [],
    escalation,
  });
}

/**
 * Get assessments needing calibration
 */
export function getUncalibratedAssessments(): SelfAssessment[] {
  const store = loadQuality();
  return store.assessments.filter(a => !a.calibration);
}

/**
 * Get assessments with escalations
 */
export function getEscalations(unresolvedOnly: boolean = true): SelfAssessment[] {
  const store = loadQuality();
  return store.assessments.filter(a => {
    if (!a.escalation) return false;
    if (unresolvedOnly && a.calibration) return false;
    return true;
  });
}

/**
 * Human provides calibration feedback
 */
export function calibrateAssessment(
  assessmentId: string,
  calibration: Omit<HumanCalibration, 'timestamp'>
): SelfAssessment | undefined {
  const store = loadQuality();
  const index = store.assessments.findIndex(a => a.id === assessmentId);

  if (index === -1) return undefined;

  store.assessments[index].calibration = {
    ...calibration,
    timestamp: new Date().toISOString(),
  };

  saveQuality(store);
  return store.assessments[index];
}

/**
 * Get calibration statistics
 */
export function getCalibrationStats(): CalibrationStats {
  const store = loadQuality();
  const assessments = store.assessments;

  const calibrated = assessments.filter(a => a.calibration);
  const byProject: Record<string, { total: number; accurate: number }> = {};

  let accurate = 0;
  let overconfident = 0;
  let underconfident = 0;

  for (const a of calibrated) {
    if (a.calibration!.assessmentAccuracy === 'accurate') accurate++;
    if (a.calibration!.assessmentAccuracy === 'overconfident') overconfident++;
    if (a.calibration!.assessmentAccuracy === 'underconfident') underconfident++;

    if (!byProject[a.project]) {
      byProject[a.project] = { total: 0, accurate: 0 };
    }
    byProject[a.project].total++;
    if (a.calibration!.assessmentAccuracy === 'accurate') {
      byProject[a.project].accurate++;
    }
  }

  const projectStats: Record<string, { total: number; accuracyRate: number }> = {};
  for (const [project, stats] of Object.entries(byProject)) {
    projectStats[project] = {
      total: stats.total,
      accuracyRate: stats.total > 0 ? stats.accurate / stats.total : 0,
    };
  }

  return {
    totalAssessments: assessments.length,
    calibrated: calibrated.length,
    uncalibrated: assessments.length - calibrated.length,
    accuracyRate: calibrated.length > 0 ? accurate / calibrated.length : 0,
    overconfidenceRate: calibrated.length > 0 ? overconfident / calibrated.length : 0,
    underconfidenceRate: calibrated.length > 0 ? underconfident / calibrated.length : 0,
    byProject: projectStats,
  };
}

/**
 * Get recent assessments for a project
 */
export function getProjectAssessments(project: string, limit: number = 10): SelfAssessment[] {
  const store = loadQuality();
  return store.assessments
    .filter(a => a.project === project)
    .slice(-limit);
}

/**
 * Format assessment for Telegram display
 */
export function formatAssessmentForTelegram(assessment: SelfAssessment): string {
  const lines = [
    `📊 Assessment: ${assessment.id.slice(0, 12)}`,
    `Project: ${assessment.project}`,
    `Confidence: ${assessment.confidence} - ${assessment.confidenceReason}`,
    '',
  ];

  if (assessment.workingWell.length > 0) {
    lines.push('✅ Working Well:');
    lines.push(...assessment.workingWell.map(w => `  • ${w}`));
    lines.push('');
  }

  if (assessment.notWorkingWell.length > 0) {
    lines.push('⚠️ Needs Work:');
    lines.push(...assessment.notWorkingWell.map(w => `  • ${w}`));
    lines.push('');
  }

  if (assessment.escalation) {
    const e = assessment.escalation;
    lines.push(`🚨 ESCALATION (${e.severity}): ${e.type}`);
    lines.push(`  ${e.description}`);
    if (e.needsHumanDecision) {
      lines.push('  ⚡ Needs your decision');
    }
  }

  if (assessment.calibration) {
    lines.push('');
    lines.push(`📝 Calibrated: ${assessment.calibration.assessmentAccuracy}`);
    lines.push(`   Quality: ${assessment.calibration.actualQuality}`);
  } else {
    lines.push('');
    lines.push('⏳ Awaiting calibration');
  }

  return lines.join('\n');
}

/**
 * Generate calibration prompt for agents to learn from
 */
export function getCalibrationContext(project: string): string {
  const stats = getCalibrationStats();
  const projectStats = stats.byProject[project];
  const recentAssessments = getProjectAssessments(project, 5);

  let context = `## Quality Calibration Context\n\n`;

  if (projectStats) {
    context += `Your accuracy rate on ${project}: ${(projectStats.accuracyRate * 100).toFixed(0)}%\n`;
    if (stats.overconfidenceRate > 0.3) {
      context += `⚠️ You tend to be overconfident. Be more critical of your work.\n`;
    }
    if (stats.underconfidenceRate > 0.3) {
      context += `💡 You tend to underestimate. You're doing better than you think!\n`;
    }
  }

  const calibrated = recentAssessments.filter(a => a.calibration);
  if (calibrated.length > 0) {
    context += `\n### Recent Feedback:\n`;
    for (const a of calibrated.slice(-3)) {
      if (a.calibration?.notes) {
        context += `- ${a.calibration.notes}\n`;
      }
      if (a.calibration?.direction) {
        context += `  Direction: ${a.calibration.direction}\n`;
      }
    }
  }

  return context;
}
