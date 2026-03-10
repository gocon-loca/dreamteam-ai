/**
 * Structured Logger — Lightweight logging with context.
 *
 * Usage:
 *   import { createLogger } from '../utils/logger.js';
 *   const log = createLogger('supervisor');
 *   log.info('Goal dispatched', { goalId, project });
 *   log.warn('Rate limit approaching');
 *   log.error('Dispatch failed', error);
 *   log.swallow('non-blocking-op', error);  // silent catch replacement
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default to 'info' in production, 'debug' if DREAMTEAM_LOG_LEVEL is set
const minLevel: LogLevel = (process.env.DREAMTEAM_LOG_LEVEL as LogLevel) || 'info';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, ctx?: Record<string, unknown>): void;
  /** Replace silent `catch {}` blocks — logs at debug level so failures are traceable */
  swallow(operation: string, err?: unknown): void;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatContext(ctx?: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) return '';
  const parts = Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return ` ${parts}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

export function createLogger(module: string): Logger {
  const prefix = `[${module}]`;

  return {
    debug(msg: string, ctx?: Record<string, unknown>) {
      if (!shouldLog('debug')) return;
      console.log(`${formatTimestamp()} ${prefix} ${msg}${formatContext(ctx)}`);
    },

    info(msg: string, ctx?: Record<string, unknown>) {
      if (!shouldLog('info')) return;
      console.log(`${formatTimestamp()} ${prefix} ${msg}${formatContext(ctx)}`);
    },

    warn(msg: string, ctx?: Record<string, unknown>) {
      if (!shouldLog('warn')) return;
      console.warn(`${formatTimestamp()} ${prefix} WARN ${msg}${formatContext(ctx)}`);
    },

    error(msg: string, err?: unknown, ctx?: Record<string, unknown>) {
      if (!shouldLog('error')) return;
      const errMsg = err instanceof Error ? err.message : err ? String(err) : '';
      const errStr = errMsg ? ` — ${errMsg}` : '';
      console.error(`${formatTimestamp()} ${prefix} ERROR ${msg}${errStr}${formatContext(ctx)}`);
    },

    swallow(operation: string, err?: unknown) {
      if (!shouldLog('debug')) return;
      const errMsg = err instanceof Error ? err.message : err ? String(err) : 'unknown';
      console.log(`${formatTimestamp()} ${prefix} [swallowed] ${operation}: ${errMsg}`);
    },
  };
}
