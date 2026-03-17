/**
 * Tunnel Manager — Manages cloudflared tunnels for dev servers
 *
 * Each dev server gets its own cloudflared quick tunnel, providing
 * a public https URL that works from a phone via Telegram.
 * URLs are persisted to data/tunnel-urls.json.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const URLS_FILE = join(DATA_DIR, 'tunnel-urls.json');

interface TunnelState {
  process: ChildProcess | null;
  url: string | null;
  port: number;
}

const tunnels = new Map<string, TunnelState>();

function loadUrls(): Record<string, string> {
  if (!existsSync(URLS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(URLS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveUrls(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const urls: Record<string, string> = {};
  for (const [name, state] of tunnels) {
    if (state.url) urls[name] = state.url;
  }
  writeFileSync(URLS_FILE, JSON.stringify(urls, null, 2));
}

/**
 * Start a cloudflared tunnel for a project's dev server.
 * Returns the public URL once available.
 */
export function startTunnel(projectName: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Already running?
    const existing = tunnels.get(projectName);
    if (existing?.process && existing.url) {
      resolve(existing.url);
      return;
    }

    // Kill stale process if any
    if (existing?.process) {
      existing.process.kill('SIGTERM');
    }

    const state: TunnelState = { process: null, url: null, port };
    tunnels.set(projectName, state);

    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    state.process = proc;
    let urlFound = false;
    const timeout = setTimeout(() => {
      if (!urlFound) {
        reject(new Error(`Tunnel for ${projectName} timed out after 15s`));
      }
    }, 15000);

    // cloudflared prints the tunnel URL to stderr
    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      if (!urlFound) {
        const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          urlFound = true;
          clearTimeout(timeout);
          state.url = match[0];
          console.log(`[Tunnel] ${projectName} → ${state.url}`);
          saveUrls();
          resolve(state.url);
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`[Tunnel] ${projectName} failed:`, err.message);
      clearTimeout(timeout);
      tunnels.delete(projectName);
      reject(err);
    });

    proc.on('exit', (code) => {
      console.log(`[Tunnel] ${projectName} exited (code ${code})`);
      state.process = null;
      state.url = null;
      tunnels.delete(projectName);
      saveUrls();
    });
  });
}

/**
 * Stop a project's tunnel.
 */
export function stopTunnel(projectName: string): void {
  const state = tunnels.get(projectName);
  if (state?.process) {
    state.process.kill('SIGTERM');
    state.process = null;
    state.url = null;
    tunnels.delete(projectName);
    saveUrls();
    console.log(`[Tunnel] ${projectName} stopped`);
  }
}

/**
 * Get the Tailscale IP for this machine (cached).
 * Returns null if Tailscale is not running.
 */
/**
 * Get a project's dev port by parsing the config YAML directly.
 * Avoids importing registry (which may not be initialized yet).
 */
function getProjectPort(projectName: string): number | null {
  try {
    const cfgLocal = join(__dirname, '../../config/projects.local.yaml');
    const cfgDefault = join(__dirname, '../../config/projects.yaml');
    const cfgPath = existsSync(cfgLocal) ? cfgLocal : cfgDefault;
    if (!existsSync(cfgPath)) return null;
    const yaml = readFileSync(cfgPath, 'utf-8');
    // Match the project's devPort in the YAML
    const m = yaml.match(new RegExp(`^\\s+${projectName}:[\\s\\S]*?devPort:\\s*(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

let _tailscaleIpCached: string | null = null;
let _tailscaleIpChecked = false;
function getTailscaleIp(): string | null {
  if (_tailscaleIpChecked) return _tailscaleIpCached;
  _tailscaleIpChecked = true;
  try {
    const ip = execSync('tailscale ip -4 2>/dev/null', { timeout: 3000 })
      .toString().trim();
    _tailscaleIpCached = ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    _tailscaleIpCached = null;
  }
  return _tailscaleIpCached;
}

/**
 * Get the accessible URL for a project.
 * Priority: Tailscale IP + dev port > cloudflared tunnel > persisted URL.
 * Tailscale URLs work from any device on the tailnet (phone, laptop).
 */
export function getTunnelUrl(projectName: string): string | null {
  // Priority 1: Tailscale — always works from phone/laptop on the tailnet
  const tsIp = getTailscaleIp();
  if (tsIp) {
    const state = tunnels.get(projectName);
    if (state?.port) {
      return `http://${tsIp}:${state.port}`;
    }
    // Try to get port from project config
    const port = getProjectPort(projectName);
    if (port) return `http://${tsIp}:${port}`;
  }

  // Priority 2: Active cloudflared tunnel
  const state = tunnels.get(projectName);
  if (state?.url) return state.url;

  // Priority 3: Persisted URLs (prototype server, etc.)
  if (projectName === 'prototypes') {
    const protoFile = join(DATA_DIR, 'prototype-url.txt');
    if (existsSync(protoFile)) {
      const url = readFileSync(protoFile, 'utf-8').trim();
      if (url && !url.includes('0.0.0.0')) return url;
    }
  }

  return null;
}

/**
 * Get all active tunnel/access URLs.
 * Prefers Tailscale URLs when available.
 */
export function getAllTunnelUrls(): Record<string, string> {
  const urls: Record<string, string> = {};
  const tsIp = getTailscaleIp();

  for (const [name, state] of tunnels) {
    if (tsIp && state.port) {
      urls[name] = `http://${tsIp}:${state.port}`;
    } else if (state.url) {
      urls[name] = state.url;
    }
  }

  // If we have Tailscale, also include projects with known ports even without active tunnels
  if (tsIp) {
    try {
      const cfgLocal = join(__dirname, '../../config/projects.local.yaml');
      const cfgDefault = join(__dirname, '../../config/projects.yaml');
      const cfgPath = existsSync(cfgLocal) ? cfgLocal : cfgDefault;
      if (existsSync(cfgPath)) {
        const yaml = readFileSync(cfgPath, 'utf-8');
        // Find all devPort entries and map back to project names
        const portMatches = yaml.matchAll(/devPort:\s*(\d+)/g);
        for (const m of portMatches) {
          const port = m[1];
          // Find the project name: scan backwards from the match for a project key
          const before = yaml.slice(0, m.index);
          const nameMatch = before.match(/^\s{2}(\S+):\s*$/gm);
          if (nameMatch) {
            const name = nameMatch[nameMatch.length - 1].trim().replace(':', '');
            if (name && !urls[name]) {
              urls[name] = `http://${tsIp}:${port}`;
            }
          }
        }
      }
    } catch { /* config not available */ }
  }

  // Include prototype server tunnel
  const protoFile = join(DATA_DIR, 'prototype-url.txt');
  if (existsSync(protoFile)) {
    const url = readFileSync(protoFile, 'utf-8').trim();
    if (url && !url.includes('0.0.0.0')) urls['prototypes'] = url;
  }

  return urls;
}

/**
 * Stop all tunnels (for graceful shutdown).
 */
export function stopAllTunnels(): void {
  for (const [name] of tunnels) {
    stopTunnel(name);
  }
}
