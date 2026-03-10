/**
 * File-based lock for git operations on a project directory.
 *
 * Prevents the worker and supervisor from running concurrent git operations
 * (checkout, merge, push, etc.) on the same repository. Both processes are
 * separate Node.js processes managed by PM2, so we use a file lock for
 * inter-process coordination.
 *
 * Usage:
 *   const release = await acquireGitLock('my-project');
 *   try { ... git operations ... } finally { release(); }
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const LOCK_DIR = tmpdir();
const POLL_MS = 200;
const MAX_WAIT_MS = 120_000; // 2 minutes max wait
const STALE_MS = 300_000;    // 5 minutes = stale lock (process died)

function lockPath(project: string): string {
  return join(LOCK_DIR, `dreamteam-git-${project}.lock`);
}

function isLockStale(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf8');
    const ts = parseInt(content, 10);
    if (isNaN(ts)) return true;
    return Date.now() - ts > STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Acquire the git lock for a project. Blocks until the lock is available
 * or MAX_WAIT_MS is exceeded (in which case it proceeds anyway with a warning).
 */
export async function acquireGitLock(project: string): Promise<() => void> {
  const path = lockPath(project);
  const start = Date.now();

  while (existsSync(path)) {
    if (isLockStale(path)) {
      console.log(`[GitLock] Stale lock for ${project} — breaking it`);
      try { unlinkSync(path); } catch { /* ignore */ }
      break;
    }

    if (Date.now() - start > MAX_WAIT_MS) {
      console.warn(`[GitLock] Waited ${MAX_WAIT_MS}ms for ${project} lock — proceeding anyway`);
      try { unlinkSync(path); } catch { /* ignore */ }
      break;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // Write lock with timestamp
  writeFileSync(path, String(Date.now()));

  // Return release function
  return () => {
    try { unlinkSync(path); } catch { /* ignore */ }
  };
}
