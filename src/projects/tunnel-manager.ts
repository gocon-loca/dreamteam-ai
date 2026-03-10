/**
 * Tunnel Manager — Manages cloudflared tunnels for dev servers
 *
 * Each dev server gets its own cloudflared quick tunnel, providing
 * a public https URL that works from a phone via Telegram.
 * URLs are persisted to data/tunnel-urls.json.
 */

import { spawn, ChildProcess } from 'child_process';
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
 * Get the tunnel URL for a project. Returns null if no tunnel is active.
 */
export function getTunnelUrl(projectName: string): string | null {
  const state = tunnels.get(projectName);
  if (state?.url) return state.url;

  // Check persisted URLs as fallback (tunnel might be managed by prototype-server)
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
 * Get all active tunnel URLs.
 */
export function getAllTunnelUrls(): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [name, state] of tunnels) {
    if (state.url) urls[name] = state.url;
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
