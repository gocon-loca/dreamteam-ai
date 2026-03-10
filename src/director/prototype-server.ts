/**
 * Prototype Server — Lightweight static file server for HTML prototypes
 *
 * Serves data/prototypes/ at a public URL via Cloudflare Tunnel.
 * Falls back to local IP if tunnel fails.
 * Persists the base URL to data/prototype-url.txt for other modules to read.
 */

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const URL_FILE = join(DATA_DIR, 'prototype-url.txt');

const app = new Hono();

// Serve prototype HTML files
app.use('/prototypes/*', serveStatic({ root: './data' }));

// Health check
app.get('/health', (c) => c.text('ok'));

const PORT = 8080;

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`[PrototypeServer] Listening on 0.0.0.0:${PORT}`);
  startCloudflaredTunnel();
});

function startCloudflaredTunnel(): void {
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlFound = false;

  // cloudflared prints the tunnel URL to stderr
  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    if (!urlFound) {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        urlFound = true;
        const url = match[0];
        console.log(`[PrototypeServer] Tunnel URL: ${url}`);
        writeFileSync(URL_FILE, url);
      }
    }
  });

  proc.on('error', (err) => {
    console.error(`[PrototypeServer] cloudflared failed:`, err.message);
    writeFileSync(URL_FILE, `http://0.0.0.0:${PORT}`);
  });

  proc.on('exit', (code) => {
    console.log(`[PrototypeServer] cloudflared exited with code ${code}, restarting in 5s...`);
    setTimeout(() => startCloudflaredTunnel(), 5000);
  });
}
