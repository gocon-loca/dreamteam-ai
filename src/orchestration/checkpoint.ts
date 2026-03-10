/**
 * State Checkpoint System
 *
 * Captures and restores system state at key points:
 * - Before starting a goal
 * - After completing a goal
 * - Before/after risky operations
 *
 * Enables:
 * - Rollback on regression
 * - State comparison for debugging
 * - Historical audit trail
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { Goal, getAllGoals } from './goal-manager.js';
import { getProject, listProjectNames } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const CHECKPOINTS_DIR = join(DATA_DIR, 'checkpoints');

export type CheckpointTrigger =
  | 'goal_start'
  | 'goal_complete'
  | 'goal_blocked'
  | 'before_risky'
  | 'after_risky'
  | 'manual'
  | 'periodic';

export interface ProjectState {
  project: string;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  modifiedFiles: string[];
  devServerRunning: boolean;
  testsPassing?: boolean;
  lastTestRun?: string;
}

export interface SystemState {
  goals: Goal[];
  projects: ProjectState[];
  timestamp: string;
  trigger: CheckpointTrigger;
  triggeredBy?: string; // goal ID or operation name
  metadata?: Record<string, unknown>;
}

export interface Checkpoint {
  id: string;
  state: SystemState;
  createdAt: string;
  description?: string;
  tags: string[];
}

function ensureCheckpointsDir(): void {
  if (!existsSync(CHECKPOINTS_DIR)) {
    mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

/**
 * Get git status for a project
 */
function getProjectGitState(projectPath: string): {
  branch: string;
  commit: string;
  dirty: boolean;
  modifiedFiles: string[];
} {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const commit = execSync('git rev-parse HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const status = execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const dirty = status.length > 0;
    const modifiedFiles = status
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => line.slice(3)); // Remove status prefix

    return { branch, commit, dirty, modifiedFiles };
  } catch {
    return {
      branch: 'unknown',
      commit: 'unknown',
      dirty: false,
      modifiedFiles: [],
    };
  }
}

/**
 * Capture current state of all projects
 */
export async function captureProjectStates(): Promise<ProjectState[]> {
  const projectNames = listProjectNames();
  const states: ProjectState[] = [];

  for (const name of projectNames) {
    const project = getProject(name);
    const gitState = getProjectGitState(project.path);

    states.push({
      project: name,
      gitBranch: gitState.branch,
      gitCommit: gitState.commit,
      gitDirty: gitState.dirty,
      modifiedFiles: gitState.modifiedFiles,
      devServerRunning: false, // Could check actual server status
    });
  }

  return states;
}

/**
 * Create a checkpoint of the current system state
 */
export async function createCheckpoint(
  trigger: CheckpointTrigger,
  options: {
    triggeredBy?: string;
    description?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<Checkpoint> {
  ensureCheckpointsDir();

  const goals = getAllGoals();
  const projects = await captureProjectStates();

  const state: SystemState = {
    goals,
    projects,
    timestamp: new Date().toISOString(),
    trigger,
    triggeredBy: options.triggeredBy,
    metadata: options.metadata,
  };

  const checkpoint: Checkpoint = {
    id: `cp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    state,
    createdAt: new Date().toISOString(),
    description: options.description,
    tags: options.tags || [],
  };

  // Save checkpoint to file
  const filename = `${checkpoint.id}.json`;
  writeFileSync(
    join(CHECKPOINTS_DIR, filename),
    JSON.stringify(checkpoint, null, 2)
  );

  // Cleanup old checkpoints (keep last 50)
  cleanupOldCheckpoints(50);

  return checkpoint;
}

/**
 * Load a checkpoint by ID
 */
export function loadCheckpoint(id: string): Checkpoint | undefined {
  const filepath = join(CHECKPOINTS_DIR, `${id}.json`);
  if (!existsSync(filepath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

/**
 * List all checkpoints
 */
export function listCheckpoints(options: {
  limit?: number;
  trigger?: CheckpointTrigger;
  project?: string;
  tag?: string;
} = {}): Checkpoint[] {
  ensureCheckpointsDir();

  const files = readdirSync(CHECKPOINTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse(); // Most recent first

  let checkpoints: Checkpoint[] = [];

  for (const file of files) {
    const checkpoint = JSON.parse(
      readFileSync(join(CHECKPOINTS_DIR, file), 'utf-8')
    ) as Checkpoint;

    // Apply filters
    if (options.trigger && checkpoint.state.trigger !== options.trigger) continue;
    if (options.tag && !checkpoint.tags.includes(options.tag)) continue;
    if (options.project) {
      const hasProject = checkpoint.state.projects.some(
        p => p.project === options.project
      );
      if (!hasProject) continue;
    }

    checkpoints.push(checkpoint);

    if (options.limit && checkpoints.length >= options.limit) break;
  }

  return checkpoints;
}

/**
 * Get the most recent checkpoint
 */
export function getLatestCheckpoint(): Checkpoint | undefined {
  const checkpoints = listCheckpoints({ limit: 1 });
  return checkpoints[0];
}

/**
 * Get checkpoint before a specific time
 */
export function getCheckpointBefore(timestamp: Date): Checkpoint | undefined {
  ensureCheckpointsDir();

  const files = readdirSync(CHECKPOINTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of files) {
    const checkpoint = JSON.parse(
      readFileSync(join(CHECKPOINTS_DIR, file), 'utf-8')
    ) as Checkpoint;

    if (new Date(checkpoint.createdAt) < timestamp) {
      return checkpoint;
    }
  }

  return undefined;
}

/**
 * Compare two checkpoints to find differences
 */
export function compareCheckpoints(
  checkpoint1: Checkpoint,
  checkpoint2: Checkpoint
): {
  goalChanges: {
    added: Goal[];
    removed: Goal[];
    statusChanged: { goal: Goal; oldStatus: string; newStatus: string }[];
  };
  projectChanges: {
    project: string;
    commitChanged: boolean;
    oldCommit: string;
    newCommit: string;
    filesChanged: string[];
  }[];
} {
  const goals1 = checkpoint1.state.goals;
  const goals2 = checkpoint2.state.goals;

  const goalIds1 = new Set(goals1.map(g => g.id));
  const goalIds2 = new Set(goals2.map(g => g.id));

  const added = goals2.filter(g => !goalIds1.has(g.id));
  const removed = goals1.filter(g => !goalIds2.has(g.id));

  const statusChanged: { goal: Goal; oldStatus: string; newStatus: string }[] = [];
  for (const goal2 of goals2) {
    const goal1 = goals1.find(g => g.id === goal2.id);
    if (goal1 && goal1.status !== goal2.status) {
      statusChanged.push({
        goal: goal2,
        oldStatus: goal1.status,
        newStatus: goal2.status,
      });
    }
  }

  const projectChanges: {
    project: string;
    commitChanged: boolean;
    oldCommit: string;
    newCommit: string;
    filesChanged: string[];
  }[] = [];

  for (const proj2 of checkpoint2.state.projects) {
    const proj1 = checkpoint1.state.projects.find(
      p => p.project === proj2.project
    );
    if (proj1 && proj1.gitCommit !== proj2.gitCommit) {
      projectChanges.push({
        project: proj2.project,
        commitChanged: true,
        oldCommit: proj1.gitCommit,
        newCommit: proj2.gitCommit,
        filesChanged: proj2.modifiedFiles,
      });
    }
  }

  return {
    goalChanges: { added, removed, statusChanged },
    projectChanges,
  };
}

/**
 * Cleanup old checkpoints, keeping only the most recent N
 */
function cleanupOldCheckpoints(keepCount: number): void {
  ensureCheckpointsDir();

  const files = readdirSync(CHECKPOINTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  // Delete files beyond the keep count
  for (const file of files.slice(keepCount)) {
    try {
      unlinkSync(join(CHECKPOINTS_DIR, file));
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * Create checkpoint before starting a goal
 */
export async function checkpointBeforeGoal(goal: Goal): Promise<Checkpoint> {
  return createCheckpoint('goal_start', {
    triggeredBy: goal.id,
    description: `Before starting: ${goal.title}`,
    tags: [goal.project, 'goal-start'],
    metadata: { goalTitle: goal.title },
  });
}

/**
 * Create checkpoint after completing a goal
 */
export async function checkpointAfterGoal(
  goal: Goal,
  success: boolean
): Promise<Checkpoint> {
  return createCheckpoint(success ? 'goal_complete' : 'goal_blocked', {
    triggeredBy: goal.id,
    description: `After ${success ? 'completing' : 'blocking'}: ${goal.title}`,
    tags: [goal.project, success ? 'goal-complete' : 'goal-blocked'],
    metadata: { goalTitle: goal.title, success },
  });
}

/**
 * Format checkpoint for display
 */
export function formatCheckpointSummary(checkpoint: Checkpoint): string {
  const lines = [
    `📍 Checkpoint: ${checkpoint.id.slice(0, 15)}`,
    `   Time: ${new Date(checkpoint.createdAt).toLocaleString()}`,
    `   Trigger: ${checkpoint.state.trigger}`,
  ];

  if (checkpoint.description) {
    lines.push(`   Desc: ${checkpoint.description}`);
  }

  const goalCounts = {
    pending: checkpoint.state.goals.filter(g => g.status === 'pending').length,
    inProgress: checkpoint.state.goals.filter(g => g.status === 'in-progress').length,
    completed: checkpoint.state.goals.filter(g => g.status === 'completed').length,
    blocked: checkpoint.state.goals.filter(g => g.status === 'blocked').length,
  };

  lines.push(
    `   Goals: ${goalCounts.pending} pending, ${goalCounts.inProgress} in-progress, ${goalCounts.completed} done, ${goalCounts.blocked} blocked`
  );

  const dirtyProjects = checkpoint.state.projects.filter(p => p.gitDirty);
  if (dirtyProjects.length > 0) {
    lines.push(`   Dirty: ${dirtyProjects.map(p => p.project).join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Get commits between two checkpoints for a project
 */
export function getCommitsBetween(
  checkpoint1: Checkpoint,
  checkpoint2: Checkpoint,
  project: string
): string[] {
  const proj1 = checkpoint1.state.projects.find(p => p.project === project);
  const proj2 = checkpoint2.state.projects.find(p => p.project === project);

  if (!proj1 || !proj2) return [];

  const projectConfig = getProject(project);

  try {
    const commits = execSync(
      `git log --oneline ${proj1.gitCommit}..${proj2.gitCommit}`,
      {
        cwd: projectConfig.path,
        encoding: 'utf-8',
        timeout: 10000,
      }
    ).trim();

    return commits.split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}
