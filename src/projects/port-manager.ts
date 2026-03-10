/**
 * Port Manager — ensures each project's assigned port is free before server start.
 */

import { execSync } from 'child_process';
import { getAllProjects } from './registry.js';

/** Kill any process occupying the given port (excluding our own PID). */
export function ensurePortFree(port: number): void {
  try {
    const out = execSync(`/usr/sbin/lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return;
    const myPid = process.pid;
    const parentPid = process.ppid;
    for (const pid of out.split('\n')) {
      const numPid = Number(pid);
      if (numPid === myPid || numPid === parentPid) {
        console.log(`[PortManager] Skipping own process PID ${numPid} on port ${port}`);
        continue;
      }
      console.log(`[PortManager] Killing PID ${pid} on port ${port}`);
      try { process.kill(numPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch {
    // lsof exits non-zero when nothing found — port is free
  }
}

/** Check that no two projects share a port. Throws on conflict. */
export function validatePorts(): void {
  const projects = getAllProjects();
  const seen = new Map<number, string>();
  for (const [name, cfg] of Object.entries(projects)) {
    if (!cfg.devPort) continue;
    const existing = seen.get(cfg.devPort);
    if (existing) {
      throw new Error(`Port conflict: ${name} and ${existing} both use port ${cfg.devPort}`);
    }
    seen.set(cfg.devPort, name);
  }
  console.log(`[PortManager] Validated ${seen.size} port assignments — no conflicts`);
}
