/**
 * Supervisor Health — HTTP health endpoint and preflight check runner.
 */

import { createServer as createHttpServer } from 'http';

import {
  getActiveItems,
  getQueuedCount,
} from '../db/work-queue.js';
import { getPendingGoals } from '../orchestration/goal-manager.js';
import { preflight } from './preflight.js';

import {
  getStatus,
  getLastPreflight, setLastPreflight,
  setLastPreflightTime,
  getLastPreflightHealthy, setLastPreflightHealthy,
  lastHeartbeat,
} from './supervisor-state.js';
import { log, withTimeout } from './supervisor-utils.js';
import { sendTelegram } from './supervisor-telegram.js';

// ── Health Server ──────────────────────────────────────────

const HEALTH_PORT = 3457;
const supervisorStartTime = Date.now();

export function startHealthServer(): void {
  const server = createHttpServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const activeWorkers = getActiveItems().length;
    const pendingGoalsCount = getPendingGoals().length;

    const payload = {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - supervisorStartTime) / 1000),
      activeWorkers,
      pendingGoalsCount,
      lastHeartbeatAt: lastHeartbeat > 0 ? new Date(lastHeartbeat).toISOString() : null,
      supervisorStatus: getStatus(),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Health server port ${HEALTH_PORT} already in use — skipping`, 'warn');
    } else {
      log(`Health server error: ${err.message}`, 'warn');
    }
  });

  server.listen(HEALTH_PORT, '127.0.0.1', () => {
    log(`Health server listening on http://127.0.0.1:${HEALTH_PORT}/health`);
  });
}

// ── Preflight Check Runner ──────────────────────────────────

export async function runPreflightCheck(): Promise<void> {
  log('Running initial preflight...');
  const initialPreflight = await withTimeout(preflight(log), 90_000, 'initial preflight');
  if (initialPreflight) {
    setLastPreflight(initialPreflight);
  } else {
    log('Initial preflight timed out — starting with defaults', 'warn');
  }
  setLastPreflightTime(Date.now());
  const lastPreflight = getLastPreflight();
  setLastPreflightHealthy(lastPreflight.ready);
  if (!lastPreflight.ready) {
    log(`Preflight issues: ${lastPreflight.issues.join('; ')}`, 'warn');
    sendTelegram(`🔴 Startup preflight issues:\n${lastPreflight.issues.map(i => `• ${i}`).join('\n')}`).catch(() => {});
  }
}
