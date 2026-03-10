/**
 * Goal Archival — Prevents unbounded growth of goals.json
 *
 * Moves completed/cancelled goals older than N days to a separate archive file.
 * Archive is kept for historical reference but not loaded into memory by goal-manager.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const GOALS_PATH = join(DATA_DIR, 'goals.json');
const ARCHIVE_PATH = join(DATA_DIR, 'goals-archive.json');

interface GoalRecord {
  id: string;
  status: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface GoalsFile {
  goals: GoalRecord[];
}

/**
 * Archive completed/cancelled goals older than `daysOld` days.
 * Returns count of archived goals and remaining active goals.
 */
export function archiveOldGoals(daysOld: number = 30): { archived: number; remaining: number } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  const cutoffIso = cutoff.toISOString();

  // Read current goals
  const goalsData: GoalsFile = JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));

  const toArchive: GoalRecord[] = [];
  const toKeep: GoalRecord[] = [];

  for (const goal of goalsData.goals) {
    const isTerminal = goal.status === 'completed' || goal.status === 'cancelled';
    if (!isTerminal) {
      toKeep.push(goal);
      continue;
    }

    // Use completedAt, cancelledAt, or createdAt to determine age
    const dateStr = goal.completedAt || goal.cancelledAt || goal.createdAt;
    if (dateStr && dateStr < cutoffIso) {
      toArchive.push(goal);
    } else {
      toKeep.push(goal);
    }
  }

  if (toArchive.length === 0) {
    return { archived: 0, remaining: goalsData.goals.length };
  }

  // Read existing archive (if any)
  let existingArchive: GoalRecord[] = [];
  if (existsSync(ARCHIVE_PATH)) {
    try {
      const archiveData = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
      existingArchive = archiveData.goals || [];
    } catch { /* corrupted archive — start fresh */ }
  }

  // Deduplicate by id
  const archivedIds = new Set(existingArchive.map(g => g.id));
  const newArchive = [...existingArchive];
  for (const goal of toArchive) {
    if (!archivedIds.has(goal.id)) {
      newArchive.push(goal);
    }
  }

  // Write archive
  writeFileSync(ARCHIVE_PATH, JSON.stringify({ goals: newArchive, archivedAt: new Date().toISOString() }, null, 2));

  // Write trimmed goals.json
  goalsData.goals = toKeep;
  writeFileSync(GOALS_PATH, JSON.stringify(goalsData, null, 2));

  console.log(`[GoalArchival] Archived ${toArchive.length} goals (${toKeep.length} remaining, ${newArchive.length} total in archive)`);

  return { archived: toArchive.length, remaining: toKeep.length };
}

/**
 * Get count of goals in archive.
 */
export function getArchiveStats(): { count: number; oldestDate: string | null; newestDate: string | null } {
  if (!existsSync(ARCHIVE_PATH)) return { count: 0, oldestDate: null, newestDate: null };

  try {
    const data = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
    const goals: GoalRecord[] = data.goals || [];
    if (goals.length === 0) return { count: 0, oldestDate: null, newestDate: null };

    const dates = goals
      .map(g => g.completedAt || g.cancelledAt || g.createdAt)
      .filter(Boolean)
      .sort();

    return {
      count: goals.length,
      oldestDate: dates[0] || null,
      newestDate: dates[dates.length - 1] || null,
    };
  } catch {
    return { count: 0, oldestDate: null, newestDate: null };
  }
}
