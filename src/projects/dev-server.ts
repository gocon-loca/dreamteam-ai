/**
 * Dev Server Manager - Starts, monitors, and restarts dev servers
 */

import { spawn, ChildProcess } from 'child_process';
import { getProject, ProjectConfig } from './registry.js';
import { startTunnel, stopTunnel } from './tunnel-manager.js';
import { ensurePortFree } from './port-manager.js';

interface ServerState {
  process: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastOutput: string[];
  startedAt: Date | null;
  restartCount: number;
}

const servers = new Map<string, ServerState>();
const MAX_OUTPUT_LINES = 100;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const MAX_RESTART_ATTEMPTS = 3;

export function getServerState(projectName: string): ServerState {
  if (!servers.has(projectName)) {
    servers.set(projectName, {
      process: null,
      status: 'stopped',
      lastOutput: [],
      startedAt: null,
      restartCount: 0,
    });
  }
  return servers.get(projectName)!;
}

export async function startDevServer(projectName: string): Promise<{ success: boolean; message: string }> {
  const project = getProject(projectName);

  if (!project.hasDevServer) {
    return { success: false, message: `Project ${projectName} has no dev server configured` };
  }

  const state = getServerState(projectName);

  if (state.status === 'running' && state.process) {
    return { success: true, message: `Dev server for ${projectName} is already running` };
  }

  // Kill any stray process on the assigned port
  if (project.devPort) {
    ensurePortFree(project.devPort);
  }

  const command = project.devCommand || 'pnpm dev';
  const [cmd, ...args] = command.split(' ');

  console.log(`Starting dev server for ${projectName}: ${command}`);

  state.status = 'starting';
  state.lastOutput = [];

  let childProc;
  try {
    childProc = spawn(cmd, args, {
      cwd: project.path,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: project.devPort?.toString(),
        NODE_ENV: 'development',
      },
    });
  } catch (err) {
    console.log(`Dev server ${projectName} spawn failed: ${err}`);
    state.status = 'error';
    return { success: false, message: `Spawn failed: ${err}` };
  }

  state.process = childProc;
  state.startedAt = new Date();

  childProc.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    state.lastOutput.push(...lines);
    if (state.lastOutput.length > MAX_OUTPUT_LINES) {
      state.lastOutput = state.lastOutput.slice(-MAX_OUTPUT_LINES);
    }
  });

  childProc.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    state.lastOutput.push(...lines.map((l: string) => `[stderr] ${l}`));
    if (state.lastOutput.length > MAX_OUTPUT_LINES) {
      state.lastOutput = state.lastOutput.slice(-MAX_OUTPUT_LINES);
    }
  });

  childProc.on('error', (err) => {
    console.log(`Dev server ${projectName} spawn error: ${err.message}`);
    state.status = 'error';
    state.process = null;
  });

  childProc.on('exit', (code) => {
    console.log(`Dev server ${projectName} exited with code ${code}`);
    state.status = code === 0 ? 'stopped' : 'error';
    state.process = null;
  });

  // Wait for server to be ready
  const ready = await waitForHealthCheck(project, 60000);

  if (ready) {
    state.status = 'running';
    state.restartCount = 0;

    // Start a public tunnel for phone access
    if (project.devPort) {
      startTunnel(projectName, project.devPort).catch(err =>
        console.log(`[DevServer] Tunnel for ${projectName} failed: ${err.message}`)
      );
    }

    return { success: true, message: `Dev server for ${projectName} started on port ${project.devPort}` };
  } else {
    state.status = 'error';
    return { success: false, message: `Dev server for ${projectName} failed to start. Last output:\n${state.lastOutput.slice(-10).join('\n')}` };
  }
}

export async function stopDevServer(projectName: string): Promise<{ success: boolean; message: string }> {
  const state = getServerState(projectName);

  stopTunnel(projectName);

  if (!state.process) {
    return { success: true, message: `Dev server for ${projectName} is not running` };
  }

  return new Promise((resolve) => {
    state.process!.on('exit', () => {
      state.status = 'stopped';
      state.process = null;
      resolve({ success: true, message: `Dev server for ${projectName} stopped` });
    });

    state.process!.kill('SIGTERM');

    // Force kill after 5 seconds
    setTimeout(() => {
      if (state.process) {
        state.process.kill('SIGKILL');
      }
    }, 5000);
  });
}

export async function restartDevServer(projectName: string): Promise<{ success: boolean; message: string }> {
  const state = getServerState(projectName);

  if (state.restartCount >= MAX_RESTART_ATTEMPTS) {
    return {
      success: false,
      message: `Dev server for ${projectName} has restarted ${MAX_RESTART_ATTEMPTS} times. Manual intervention required.`
    };
  }

  state.restartCount++;
  await stopDevServer(projectName);
  return startDevServer(projectName);
}

async function waitForHealthCheck(project: ProjectConfig, timeout: number): Promise<boolean> {
  if (!project.healthCheck) {
    // No health check configured, wait a bit and assume ready
    await new Promise(r => setTimeout(r, 3000));
    return true;
  }

  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(project.healthCheck, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return false;
}

/**
 * Quick, non-blocking health check for a project's dev server.
 * Returns true if the server responds, false otherwise.
 * Does NOT attempt to start or restart the server.
 */
export async function quickHealthCheck(projectName: string, timeout = 3000): Promise<boolean> {
  const project = getProject(projectName);
  if (!project.hasDevServer || !project.healthCheck) {
    return false;
  }
  try {
    const response = await fetch(project.healthCheck, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

export async function ensureDevServerRunning(projectName: string): Promise<boolean> {
  const project = getProject(projectName);

  if (!project.hasDevServer) {
    return true; // No server needed
  }

  const state = getServerState(projectName);

  if (state.status === 'running') {
    // Verify it's still healthy
    if (project.healthCheck) {
      try {
        const response = await fetch(project.healthCheck, {
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok || response.status < 500) {
          return true;
        }
      } catch {
        // Server died, try to restart
        console.log(`Health check failed for ${projectName}, restarting...`);
        const result = await restartDevServer(projectName);
        return result.success;
      }
    }
    return true;
  }

  const result = await startDevServer(projectName);
  return result.success;
}

export function getServerStatus(projectName: string): {
  status: string;
  uptime: string | null;
  lastOutput: string[];
} {
  const state = getServerState(projectName);

  let uptime: string | null = null;
  if (state.startedAt && state.status === 'running') {
    const seconds = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }

  return {
    status: state.status,
    uptime,
    lastOutput: state.lastOutput.slice(-10),
  };
}
