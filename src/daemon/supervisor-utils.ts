/**
 * Supervisor Utilities — logging, timeout wrapper, and guarded execution.
 */

// ── Logging ────────────────────────────────────────────────

export function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [supervisor]`;
  if (level === 'error') console.error(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`);
}

// ── Timeout Wrapper ───────────────────────────────────────
// Every async operation in the main loop MUST go through this.
// A skipped operation is better than a dead supervisor.

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log(`TIMEOUT: ${label} exceeded ${ms}ms — skipping`, 'warn');
        resolve(null);
      }, ms);
    }),
  ]);
}

// Guard: prevent re-entering an async function while a previous call is still hanging.
// The guard stays locked until the REAL promise settles (not the timeout).
const inFlight = new Set<string>();

export async function guarded<T>(label: string, fn: () => Promise<T>, ms: number): Promise<T | null> {
  if (inFlight.has(label)) {
    // Previous call still hanging — don't pile up
    return null;
  }
  inFlight.add(label);
  const real = fn();
  // Release the guard when the REAL promise settles, not the timeout
  real.then(() => inFlight.delete(label), () => inFlight.delete(label));
  return withTimeout(real, ms, label);
}
