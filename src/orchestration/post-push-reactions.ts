/**
 * Post-Push Reactions — Hooks that fire after a goal is merged and pushed.
 *
 * Consolidates the various things that should happen when code lands on main:
 * 1. Unblock dependent goals (check dependsOn chains)
 * 2. Restart dev server if the project has one running
 * 3. Notify via Telegram with structured completion message
 *
 * All reactions are fire-and-forget — failures are logged but don't block.
 */

import { execSync } from 'child_process';
import type { Goal, StructuredDebrief } from './goal-manager.js';
import { getAllGoals, updateGoal } from './goal-manager.js';
import { getProject } from '../projects/registry.js';

export interface ReactionResult {
  unblockedGoals: string[];
  devServerRestarted: boolean;
  errors: string[];
}

/**
 * Run all post-push reactions for a completed goal.
 * Called after merge+push succeeds in runPostCompletionHooks.
 */
export async function runPostPushReactions(
  goal: Goal,
  _debrief: StructuredDebrief,
): Promise<ReactionResult> {
  const result: ReactionResult = {
    unblockedGoals: [],
    devServerRestarted: false,
    errors: [],
  };

  // 1. Unblock dependent goals
  try {
    const unblocked = checkAndUnblockDependents(goal.id);
    result.unblockedGoals = unblocked;
    if (unblocked.length > 0) {
      console.log(`[PostPush] Unblocked ${unblocked.length} goals after "${goal.title}": ${unblocked.join(', ')}`);
    }
  } catch (err) {
    const msg = `Unblock dependents failed: ${err}`;
    console.error(`[PostPush] ${msg}`);
    result.errors.push(msg);
  }

  // 2. Restart dev server if project has one
  try {
    const restarted = await restartDevServer(goal.project);
    result.devServerRestarted = restarted;
    if (restarted) {
      console.log(`[PostPush] Dev server restarted for ${goal.project}`);
    }
  } catch (err) {
    const msg = `Dev server restart failed: ${err}`;
    console.error(`[PostPush] ${msg}`);
    result.errors.push(msg);
  }

  return result;
}

/**
 * Check all pending/blocked goals to see if this completed goal
 * was in their dependsOn list. If all dependencies are now met,
 * transition them from blocked to pending.
 */
function checkAndUnblockDependents(completedGoalId: string): string[] {
  const allGoals = getAllGoals();
  const unblocked: string[] = [];

  for (const goal of allGoals) {
    if (!goal.dependsOn || goal.dependsOn.length === 0) continue;
    if (goal.status !== 'blocked' && goal.status !== 'pending') continue;
    if (!goal.dependsOn.includes(completedGoalId)) continue;

    // Check if ALL dependencies are now complete
    const allDepsComplete = goal.dependsOn.every(depId => {
      const dep = allGoals.find(g => g.id === depId);
      return dep?.status === 'completed';
    });

    if (allDepsComplete) {
      if (goal.status === 'blocked') {
        updateGoal(goal.id, {
          status: 'pending',
          blockedReason: undefined,
        });
        unblocked.push(goal.title);
      }
    }
  }

  return unblocked;
}

/**
 * Restart the dev server for a project if it has one running.
 * Uses PM2 if the project has a managed dev server process.
 */
async function restartDevServer(projectName: string): Promise<boolean> {
  const project = getProject(projectName);
  if (!project?.hasDevServer) return false;

  try {
    // Check if there's a PM2 process for this project's dev server
    const pm2List = execSync('pm2 jlist 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000,
    });

    const processes = JSON.parse(pm2List) as Array<{ name: string; pm2_env?: { status: string } }>;
    const devProcess = processes.find(p =>
      p.name === `${projectName}-dev` || p.name === projectName
    );

    if (devProcess && devProcess.pm2_env?.status === 'online') {
      execSync(`pm2 restart ${devProcess.name}`, { timeout: 10000, stdio: 'pipe' });
      return true;
    }
  } catch {
    // PM2 not available or process not found — that's fine
  }

  return false;
}
