/**
 * Process Tracker - Tracks spawned Claude processes across orchestrator restarts
 *
 * Solves the orphan process problem: when orchestrator stops, we lose track of
 * running Claude processes. This module persists process info to disk so we can:
 * 1. Detect orphaned processes on startup
 * 2. Recover or kill them appropriately
 * 3. Prevent duplicate work on the same goal
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const PROCESSES_FILE = path.join(DATA_DIR, 'running-processes.json');

export interface TrackedProcess {
  pid: number;
  goalId: string;
  project: string;
  prompt: string;  // First 500 chars for context
  startedAt: string;
  logFile?: string;
}

interface ProcessStore {
  processes: TrackedProcess[];
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): ProcessStore {
  ensureDataDir();
  if (!existsSync(PROCESSES_FILE)) {
    return { processes: [], lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(PROCESSES_FILE, 'utf-8'));
  } catch {
    return { processes: [], lastUpdated: new Date().toISOString() };
  }
}

function saveStore(store: ProcessStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  writeFileSync(PROCESSES_FILE, JSON.stringify(store, null, 2));
}

/**
 * Check if a process is still running
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get process info from ps command (more details than just alive check)
 */
export function getProcessInfo(pid: number): { alive: boolean; cpuTime?: string; command?: string } {
  try {
    const output = execSync(`ps -p ${pid} -o pid,time,command`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return { alive: false };

    const parts = lines[1].trim().split(/\s+/);
    return {
      alive: true,
      cpuTime: parts[1],
      command: parts.slice(2).join(' ').slice(0, 100),
    };
  } catch {
    return { alive: false };
  }
}

/**
 * Register a new Claude process
 */
export function trackProcess(
  pid: number,
  goalId: string,
  project: string,
  prompt: string,
  logFile?: string
): void {
  const store = loadStore();

  // Remove any existing entry for this goal (shouldn't happen, but safety)
  store.processes = store.processes.filter(p => p.goalId !== goalId);

  store.processes.push({
    pid,
    goalId,
    project,
    prompt: prompt.slice(0, 500),
    startedAt: new Date().toISOString(),
    logFile,
  });

  saveStore(store);
  console.log(`[ProcessTracker] Tracking PID ${pid} for goal ${goalId} (${project})`);
}

/**
 * Unregister a process (on normal completion)
 */
export function untrackProcess(goalId: string): void {
  const store = loadStore();
  const before = store.processes.length;
  store.processes = store.processes.filter(p => p.goalId !== goalId);

  if (store.processes.length < before) {
    saveStore(store);
    console.log(`[ProcessTracker] Untracked process for goal ${goalId}`);
  }
}

/**
 * Get all tracked processes
 */
export function getTrackedProcesses(): TrackedProcess[] {
  return loadStore().processes;
}

/**
 * Find orphaned processes - tracked but no longer managed by orchestrator
 */
export function findOrphanedProcesses(): TrackedProcess[] {
  const store = loadStore();
  return store.processes.filter(p => isProcessAlive(p.pid));
}

/**
 * Find dead processes - tracked but no longer running
 */
export function findDeadProcesses(): TrackedProcess[] {
  const store = loadStore();
  return store.processes.filter(p => !isProcessAlive(p.pid));
}

/**
 * Clean up dead process entries from store
 */
export function cleanupDeadProcesses(): TrackedProcess[] {
  const store = loadStore();
  const dead = store.processes.filter(p => !isProcessAlive(p.pid));
  store.processes = store.processes.filter(p => isProcessAlive(p.pid));

  if (dead.length > 0) {
    saveStore(store);
    console.log(`[ProcessTracker] Cleaned up ${dead.length} dead process entries`);
  }

  return dead;
}

/**
 * Kill a tracked process
 */
export function killTrackedProcess(goalId: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): boolean {
  const store = loadStore();
  const proc = store.processes.find(p => p.goalId === goalId);

  if (!proc) {
    console.log(`[ProcessTracker] No tracked process for goal ${goalId}`);
    return false;
  }

  try {
    process.kill(proc.pid, signal);
    console.log(`[ProcessTracker] Sent ${signal} to PID ${proc.pid} (goal ${goalId})`);

    // Remove from tracking
    untrackProcess(goalId);
    return true;
  } catch (err) {
    console.log(`[ProcessTracker] Failed to kill PID ${proc.pid}: ${err}`);
    // Process is probably already dead, clean it up
    untrackProcess(goalId);
    return false;
  }
}

/**
 * Kill all orphaned processes
 */
export function killAllOrphans(): { killed: string[]; failed: string[] } {
  const orphans = findOrphanedProcesses();
  const killed: string[] = [];
  const failed: string[] = [];

  for (const orphan of orphans) {
    if (killTrackedProcess(orphan.goalId, 'SIGTERM')) {
      killed.push(orphan.goalId);
    } else {
      failed.push(orphan.goalId);
    }
  }

  return { killed, failed };
}

/**
 * Get status summary for display
 */
export function getProcessStatus(): {
  total: number;
  alive: number;
  dead: number;
  processes: Array<TrackedProcess & { alive: boolean; cpuTime?: string }>;
} {
  const store = loadStore();
  const processes = store.processes.map(p => {
    const info = getProcessInfo(p.pid);
    return { ...p, alive: info.alive, cpuTime: info.cpuTime };
  });

  return {
    total: processes.length,
    alive: processes.filter(p => p.alive).length,
    dead: processes.filter(p => !p.alive).length,
    processes,
  };
}

/**
 * Check if a goal already has a running process
 */
export function hasRunningProcess(goalId: string): boolean {
  const store = loadStore();
  const proc = store.processes.find(p => p.goalId === goalId);
  return proc ? isProcessAlive(proc.pid) : false;
}

/**
 * Recovery strategy for orphaned processes on orchestrator startup
 */
export interface OrphanRecoveryResult {
  recovered: TrackedProcess[];   // Processes we'll continue to track
  killed: TrackedProcess[];      // Processes we killed
  cleaned: TrackedProcess[];     // Dead entries we cleaned up
}

export function recoverOrphans(
  strategy: 'kill' | 'adopt' | 'ask' = 'adopt'
): OrphanRecoveryResult {
  const result: OrphanRecoveryResult = {
    recovered: [],
    killed: [],
    cleaned: [],
  };

  // First clean up dead entries
  result.cleaned = cleanupDeadProcesses();

  // Get remaining orphans (still alive)
  const orphans = findOrphanedProcesses();

  if (orphans.length === 0) {
    console.log('[ProcessTracker] No orphaned processes found');
    return result;
  }

  console.log(`[ProcessTracker] Found ${orphans.length} orphaned processes`);

  switch (strategy) {
    case 'kill':
      // Kill all orphans
      for (const orphan of orphans) {
        killTrackedProcess(orphan.goalId, 'SIGTERM');
        result.killed.push(orphan);
      }
      break;

    case 'adopt':
      // Keep tracking them - orchestrator will pick them up
      result.recovered = orphans;
      console.log(`[ProcessTracker] Adopting ${orphans.length} orphaned processes`);
      break;

    case 'ask':
      // Don't do anything - let caller decide
      result.recovered = orphans;
      break;
  }

  return result;
}
