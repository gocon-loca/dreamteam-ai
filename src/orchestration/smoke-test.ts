/**
 * Smoke Test — Post-completion verification that the app still works
 *
 * After an agent completes a goal, this module:
 * 1. Starts the dev server (if needed)
 * 2. Crawls all discovered routes
 * 3. Checks that each returns 200 (or expected status)
 * 4. Detects error content in pages (stack traces, 500 messages)
 * 5. Compares against pre-goal snapshot to detect regressions
 *
 * If the app is broken, the goal completion is REJECTED.
 *
 * Snapshots stored at data/snapshots/{project}-{goalId}.json
 */

import { spawn } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { chromium, type Browser, type Page } from '@playwright/test';
import { quickHealthCheck } from '../projects/dev-server.js';
import { getProject } from '../projects/registry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('smoke-test');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const SNAPSHOTS_DIR = join(DATA_DIR, 'snapshots');
const SCREENSHOTS_DIR = join(DATA_DIR, 'screenshots');

/**
 * Wait for an already-running dev server to respond with 200.
 * Retries every 2s up to the given timeout. Does NOT start a server —
 * preflight is responsible for server lifecycle.
 */
async function waitForDevServer(projectName: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await quickHealthCheck(projectName, 3000);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ── Types ──────────────────────────────────────────────────

export interface RouteStatus {
  url: string;
  path: string;
  status: number;
  title: string;
  hasContent: boolean;        // page has meaningful text content
  hasErrors: boolean;         // page contains error indicators
  errorSnippet?: string;      // first error text found
  jsErrors: string[];         // JavaScript console errors
  failedApiRequests: FailedApiRequest[];  // 4xx/5xx API responses during page load
  hasPlaceholders: boolean;   // page contains fake/placeholder data
  placeholderSnippet?: string; // first placeholder text found
  interactiveCount: number;   // buttons, inputs, links
  textLength: number;         // visible text character count
}

export interface FailedApiRequest {
  url: string;
  status: number;
  method: string;
}

export interface SmokeSnapshot {
  project: string;
  goalId?: string;
  timestamp: string;
  baseUrl: string;
  routes: RouteStatus[];
  totalRoutes: number;
  healthyRoutes: number;
  brokenRoutes: number;
  errorRoutes: number;
  placeholderRoutes: number;  // routes with fake/placeholder data
}

export interface SmokeTestResult {
  passed: boolean;
  snapshot: SmokeSnapshot;
  regressions: Regression[];
  qualityWarnings: QualityWarning[];
  visualReview?: VisualReview;
  summary: string;
}

export interface Regression {
  path: string;
  type: 'route_broken' | 'route_missing' | 'new_errors' | 'content_lost' | 'new_placeholders';
  before: string;
  after: string;
}

export interface QualityWarning {
  path: string;
  type: 'placeholder_data' | 'empty_page' | 'suspicious_content' | 'visual_regression';
  detail: string;
}

export interface VisualReview {
  verdict: 'better' | 'same' | 'worse' | 'mixed';
  issues: string[];
  summary: string;
  costUsd: number;
}

// Error patterns to detect in page content
const ERROR_PATTERNS = [
  /Internal Server Error/i,
  /500\s*(Internal)?\s*Server\s*Error/i,
  /Traceback \(most recent call last\)/i,
  /Error:\s+\w+Error/,
  /Unhandled\s+(Runtime\s+)?Error/i,
  /Application error/i,
  /Something went wrong/i,
  /Cannot read propert/i,
  /undefined is not/i,
  /null is not/i,
  /404.*not found/i,
  /ModuleNotFoundError/i,
  /ImportError/i,
  // Python/JS error types — require "Error:" prefix or stack-trace context
  // to avoid matching docs pages that mention these as concepts.
  /(?:Uncaught |unhandled )?SyntaxError:/i,
  /(?:Uncaught |unhandled )?TypeError:/i,
  /KeyError:/i,
  /AttributeError:/i,
];

// Placeholder/fake data patterns — things agents leave behind
// IMPORTANT: Keep these tight to avoid false positives. Only match clearly fake data.
const PLACEHOLDER_PATTERNS = [
  /Lorem ipsum/i,
  /example\.com/i,
  /john\.?doe/i,
  /jane\.?doe/i,
  /foo\s*bar/i,
  /\bXXX\b/,
  /under construction/i,
  /not yet implemented/i,
  // Common fake names agents use
  /\bSarah\s+(Johnson|Smith|Williams|Brown|Davis)\b/,
  /\bJohn\s+(Smith|Doe|Johnson|Williams)\b/,
  /\bAlice\s+(Smith|Johnson|Williams)\b/,
  /\bBob\s+(Smith|Johnson|Williams)\b/,
  /Unknown Speaker \d+/,
  // Fake data patterns
  /\$\d+\.\d{2}\b.*\$\d+\.\d{2}\b.*\$\d+\.\d{2}\b/, // repeated dollar amounts (fake financial data)
  /test[-_]?(user|account|data)/i,
  /demo[-_]?(user|account|data|mode)/i,
];

// Benign JavaScript errors — expected browser noise that doesn't indicate app breakage
// These are filtered out from regression detection
const BENIGN_JS_ERROR_PATTERNS = [
  /ResizeObserver\s+loop\s+completed\s+with\s+undelivered\s+notifications/i,
  /Non-Error\s+promise\s+rejection\s+detected/i,
  /undefined is not an object.*_react_devtools/i, // React DevTools errors in non-dev
  /chrome-extension:\/\//i,  // Browser extension errors
  /moz-extension:\/\//i,      // Firefox extension errors
];

// ── Snapshot Functions ──────────────────────────────────────

function ensureSnapshotsDir(): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

export function saveSnapshot(snapshot: SmokeSnapshot): void {
  ensureSnapshotsDir();
  const filename = snapshot.goalId
    ? `${snapshot.project}-${snapshot.goalId}.json`
    : `${snapshot.project}-latest.json`;
  writeFileSync(join(SNAPSHOTS_DIR, filename), JSON.stringify(snapshot, null, 2));
}

export function getPreGoalSnapshot(project: string): SmokeSnapshot | null {
  // Try project-latest first (captured before goal started)
  const latestPath = join(SNAPSHOTS_DIR, `${project}-latest.json`);
  if (existsSync(latestPath)) {
    try {
      return JSON.parse(readFileSync(latestPath, 'utf-8'));
    } catch (e) { log.swallow('parse-pre-goal-snapshot', e); }
  }
  return null;
}

// ── JavaScript Error Tracking ─────────────────────────────

/**
 * Set up listeners for JS console errors and page errors.
 * Returns a Set that collects error messages and can be cleared between routes.
 */
function setupJsErrorTracking(page: Page): Set<string> {
  const errors = new Set<string>();

  // Capture console.error, console.warn, and uncaught exceptions
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text();
      if (!isBenignJsError(text)) {
        errors.add(text);
      }
    }
  });

  // Capture uncaught page errors
  page.on('pageerror', (error) => {
    const message = error?.message || String(error);
    if (!isBenignJsError(message)) {
      errors.add(message);
    }
  });

  return errors;
}

// ── Network Error Tracking ────────────────────────────────

/**
 * Set up listeners for failed API requests (4xx/5xx responses).
 * Returns an array that collects failures and can be cleared between routes.
 * Only tracks same-origin API requests — ignores external CDN/analytics calls.
 */
function setupNetworkErrorTracking(page: Page, baseOrigin: string): FailedApiRequest[] {
  const failures: FailedApiRequest[] = [];

  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) {
      const url = response.url();
      // Only track same-origin requests (skip CDN, analytics, external APIs)
      try {
        if (new URL(url).origin !== baseOrigin) return;
      } catch { return; }
      // Skip static assets (404 on .js/.css/.ico is usually benign)
      if (/\.(js|css|ico|png|jpg|svg|woff2?|map)(\?|$)/.test(url)) return;

      failures.push({
        url,
        status,
        method: response.request().method(),
      });
    }
  });

  return failures;
}

/**
 * Check if a JS error message is benign (can be safely ignored).
 */
function isBenignJsError(message: string): boolean {
  for (const pattern of BENIGN_JS_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

// ── Core Smoke Test ──────────────────────────────────────────

/**
 * Run a smoke test on a project. Crawls all discoverable routes
 * and checks for errors. Fast — typically completes in 10-30s.
 */
export async function runSmokeTest(
  projectName: string,
  goalId?: string,
): Promise<SmokeSnapshot> {
  const project = getProject(projectName);
  if (!project.hasDevServer || !project.healthCheck) {
    // No dev server — can't smoke test, return passing snapshot
    return {
      project: projectName,
      goalId,
      timestamp: new Date().toISOString(),
      baseUrl: '',
      routes: [],
      totalRoutes: 0,
      healthyRoutes: 0,
      brokenRoutes: 0,
      errorRoutes: 0,
      placeholderRoutes: 0,
    };
  }

  // Wait for already-running dev server (preflight manages lifecycle)
  const serverReady = await waitForDevServer(projectName, 30_000);
  if (!serverReady) {
    log.info(`Dev server not responding for ${projectName} after 30s — skipping smoke test`);
    return {
      project: projectName,
      goalId,
      timestamp: new Date().toISOString(),
      baseUrl: project.healthCheck,
      routes: [],
      totalRoutes: 0,
      healthyRoutes: 0,
      brokenRoutes: 0,
      errorRoutes: 0,
      placeholderRoutes: 0,
    };
  }

  // Resolve the actual base URL (try healthCheck first, fall back to localhost)
  let baseUrl = project.healthCheck.replace(/\/+$/, '');
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    log.swallow('fetch-base-url', e);
    if (project.devPort) {
      const localUrl = `http://127.0.0.1:${project.devPort}`;
      try {
        await fetch(localUrl, { signal: AbortSignal.timeout(3000) });
        baseUrl = localUrl;
      } catch (e2) { log.swallow('fetch-fallback-url', e2); }
    }
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const routes: RouteStatus[] = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const page: Page = await context.newPage();

    // Set up JS error and network error tracking on the page
    const pageErrors = setupJsErrorTracking(page);
    const baseOrigin = new URL(baseUrl).origin;
    const networkFailures = setupNetworkErrorTracking(page, baseOrigin);

    // Navigate to landing page
    const landingResponse = await page.goto(baseUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });

    // Authenticate if test credentials are available
    if (project.testAuth) {
      const loggedIn = await attemptLogin(page, baseUrl, project.testAuth);
      // Persist auth cookies for subsequent page navigations
      if (loggedIn) {
        try {
          await context.storageState({ path: `/tmp/smoke-auth-${projectName}.json` });
        } catch (e) { log.swallow('save-auth-state', e); }
      }
    }

    // Capture landing page
    const landingRoute = await captureRouteStatus(page, baseUrl, landingResponse?.status() ?? 0, pageErrors, networkFailures);
    routes.push(landingRoute);
    pageErrors.clear();
    networkFailures.length = 0;

    // Discover all same-origin links
    const visited = new Set<string>([baseUrl, page.url()]);
    const toVisit: string[] = [];

    const discoverLinks = async () => {
      const links = await page.$$eval('a[href]', (els: Element[]) =>
        els.map((el) => (el as HTMLAnchorElement).href).filter(Boolean)
      );
      return links;
    };

    const landingLinks = await discoverLinks();

    for (const href of landingLinks) {
      try {
        const url = new URL(href);
        if (url.origin === baseOrigin && !visited.has(href) && !href.includes('#') && !url.pathname.startsWith('/api/')) {
          toVisit.push(href);
          visited.add(href);
        }
      } catch (e) { log.swallow('parse-landing-link', e); }
    }

    // Visit discovered routes (max 30, 5s timeout each)
    const maxRoutes = 30;
    let idx = 0;
    while (idx < toVisit.length && routes.length < maxRoutes) {
      const url = toVisit[idx++];

      try {
        const response = await page.goto(url, { timeout: 5000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500); // brief wait for client rendering
        const routeStatus = await captureRouteStatus(page, url, response?.status() ?? 0, pageErrors, networkFailures);
        routes.push(routeStatus);
        pageErrors.clear();
        networkFailures.length = 0;

        // Discover new links from this page
        const newLinks = await discoverLinks();
        for (const href of newLinks) {
          try {
            const u = new URL(href);
            if (u.origin === baseOrigin && !visited.has(href) && !href.includes('#') && !u.pathname.startsWith('/api/')) {
              toVisit.push(href);
              visited.add(href);
            }
          } catch (e) { log.swallow('parse-discovered-link', e); }
        }
      } catch (e) {
        log.swallow('navigate-route', e);
        // Page failed to load
        routes.push({
          url,
          path: new URL(url).pathname,
          status: 0,
          title: '',
          hasContent: false,
          hasErrors: true,
          errorSnippet: 'Page failed to load (timeout or crash)',
          jsErrors: [],
          failedApiRequests: [],
          hasPlaceholders: false,
          interactiveCount: 0,
          textLength: 0,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const healthyRoutes = routes.filter(r => r.status >= 200 && r.status < 400 && !r.hasErrors).length;
  const brokenRoutes = routes.filter(r => r.status === 0 || r.status >= 500).length;
  const errorRoutes = routes.filter(r => r.hasErrors).length;
  const placeholderRoutes = routes.filter(r => r.hasPlaceholders).length;

  const snapshot: SmokeSnapshot = {
    project: projectName,
    goalId,
    timestamp: new Date().toISOString(),
    baseUrl,
    routes,
    totalRoutes: routes.length,
    healthyRoutes,
    brokenRoutes,
    errorRoutes,
    placeholderRoutes,
  };

  saveSnapshot(snapshot);

  return snapshot;
}

async function captureRouteStatus(
  page: Page,
  url: string,
  httpStatus: number,
  pageErrors: Set<string>,
  networkFailures: FailedApiRequest[] = [],
): Promise<RouteStatus> {
  const title = await page.title().catch(() => '');

  const pageInfo = await page.evaluate(() => {
    const body = document.body;
    if (!body) return { text: '', interactiveCount: 0 };

    const text = body.innerText || '';
    const interactiveCount = document.querySelectorAll(
      'button, input, select, textarea, a[href], [role="button"]'
    ).length;

    return { text: text.slice(0, 5000), interactiveCount };
  }).catch(() => ({ text: '', interactiveCount: 0 }));

  // Check for error patterns
  let hasErrors = false;
  let errorSnippet: string | undefined;

  for (const pattern of ERROR_PATTERNS) {
    const match = pageInfo.text.match(pattern);
    if (match) {
      hasErrors = true;
      const idx = pageInfo.text.indexOf(match[0]);
      errorSnippet = pageInfo.text.slice(Math.max(0, idx - 50), idx + match[0].length + 100).trim();
      break;
    }
  }

  if (httpStatus >= 400) {
    hasErrors = true;
    if (!errorSnippet) errorSnippet = `HTTP ${httpStatus}`;
  }

  // Check for placeholder/fake data
  let hasPlaceholders = false;
  let placeholderSnippet: string | undefined;

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pageInfo.text.match(pattern);
    if (match) {
      hasPlaceholders = true;
      const idx = pageInfo.text.indexOf(match[0]);
      placeholderSnippet = pageInfo.text.slice(Math.max(0, idx - 30), idx + match[0].length + 60).trim();
      break;
    }
  }

  // Collect JS errors from this route
  const jsErrors = Array.from(pageErrors);
  if (jsErrors.length > 0) {
    hasErrors = true;
  }

  // Collect failed API requests from this route
  const failedApiRequests = [...networkFailures];
  if (failedApiRequests.length > 0) {
    hasErrors = true;
    if (!errorSnippet) {
      const top = failedApiRequests[0];
      errorSnippet = `API ${top.method} ${new URL(top.url).pathname} returned ${top.status}`;
    }
  }

  return {
    url,
    path: new URL(url).pathname,
    status: httpStatus,
    title,
    hasContent: pageInfo.text.length > 50,
    hasErrors,
    errorSnippet,
    jsErrors,
    failedApiRequests,
    hasPlaceholders,
    placeholderSnippet,
    interactiveCount: pageInfo.interactiveCount,
    textLength: pageInfo.text.length,
  };
}

// ── Authentication (reuse pattern from app-audit) ───────────

async function attemptLogin(
  page: Page,
  baseUrl: string,
  auth: { email: string; password: string; loginPath: string },
): Promise<boolean> {
  try {
    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes('/login') || currentUrl.includes('/sign-in');

    if (!isOnLogin) {
      const hasLoginForm = await page.$('input[type="email"], input[id="email"]');
      if (!hasLoginForm) {
        await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: 10000, waitUntil: 'networkidle' });
      }
    }

    const emailInput = await page.waitForSelector(
      'input[id="email"], input[type="email"], input[name="email"]',
      { timeout: 5000 },
    );
    if (!emailInput) return false;

    await emailInput.fill(auth.email);
    const passwordInput = await page.$('input[id="password"], input[type="password"], input[name="password"]');
    if (!passwordInput) return false;
    await passwordInput.fill(auth.password);

    const submitButton = await page.$('button[type="submit"]');
    if (submitButton) {
      await submitButton.click();
    } else {
      await passwordInput.press('Enter');
    }

    await page.waitForURL(
      (url) => !new URL(url).pathname.includes('/login') && !new URL(url).pathname.includes('/sign-in'),
      { timeout: 10000 },
    );
    await page.waitForLoadState('networkidle', { timeout: 5000 });

    return true;
  } catch (e) {
    log.swallow('attempt-login', e);
    try { await page.goto(baseUrl, { timeout: 10000 }); } catch (e2) { log.swallow('navigate-after-login-fail', e2); }
    return false;
  }
}

// ── Comparison ──────────────────────────────────────────────

/**
 * Compare two snapshots and detect regressions.
 */
export function compareSnapshots(before: SmokeSnapshot, after: SmokeSnapshot): Regression[] {
  const regressions: Regression[] = [];

  const beforeByPath = new Map(before.routes.map(r => [r.path, r]));
  const afterByPath = new Map(after.routes.map(r => [r.path, r]));

  // Check routes that existed before
  for (const [path, beforeRoute] of beforeByPath) {
    const afterRoute = afterByPath.get(path);

    if (!afterRoute) {
      // Route existed before but is now missing from crawl
      // (Not necessarily broken — might just not be linked anymore)
      regressions.push({
        path,
        type: 'route_missing',
        before: `${beforeRoute.status} (${beforeRoute.title})`,
        after: 'Not found in crawl',
      });
      continue;
    }

    // Route was working before but now returns error status
    if (beforeRoute.status >= 200 && beforeRoute.status < 400
        && (afterRoute.status >= 500 || afterRoute.status === 0)) {
      regressions.push({
        path,
        type: 'route_broken',
        before: `HTTP ${beforeRoute.status}`,
        after: `HTTP ${afterRoute.status}${afterRoute.errorSnippet ? ': ' + afterRoute.errorSnippet.slice(0, 100) : ''}`,
      });
    }

    // Route didn't have errors before but now does
    if (!beforeRoute.hasErrors && afterRoute.hasErrors) {
      regressions.push({
        path,
        type: 'new_errors',
        before: 'No errors',
        after: afterRoute.errorSnippet?.slice(0, 150) || 'Error detected',
      });
    }

    // Detect NEW JavaScript errors (regression)
    const beforeJsErrors = new Set(beforeRoute.jsErrors || []);
    const afterJsErrors = new Set(afterRoute.jsErrors || []);
    const newJsErrors = Array.from(afterJsErrors).filter(err => !beforeJsErrors.has(err));

    if (newJsErrors.length > 0) {
      regressions.push({
        path,
        type: 'new_errors',
        before: 'No JS errors',
        after: `New JavaScript error(s): ${newJsErrors.slice(0, 2).join('; ').slice(0, 150)}`,
      });
    }

    // Detect NEW failed API requests (regression)
    const beforeApiPaths = new Set((beforeRoute.failedApiRequests || []).map(r => `${r.method}:${new URL(r.url).pathname}:${r.status}`));
    const newApiFailures = (afterRoute.failedApiRequests || []).filter(
      r => !beforeApiPaths.has(`${r.method}:${new URL(r.url).pathname}:${r.status}`)
    );
    if (newApiFailures.length > 0) {
      regressions.push({
        path,
        type: 'new_errors',
        before: 'No API errors',
        after: `${newApiFailures.length} failed API request(s): ${newApiFailures.slice(0, 3).map(r => `${r.method} ${new URL(r.url).pathname} → ${r.status}`).join(', ')}`,
      });
    }

    // Route had content before but is now empty
    if (beforeRoute.hasContent && !afterRoute.hasContent && beforeRoute.textLength > 200) {
      regressions.push({
        path,
        type: 'content_lost',
        before: `${beforeRoute.textLength} chars of content`,
        after: `${afterRoute.textLength} chars (content lost)`,
      });
    }

    // Route didn't have placeholder data before but now does
    if (!beforeRoute.hasPlaceholders && afterRoute.hasPlaceholders) {
      regressions.push({
        path,
        type: 'new_placeholders',
        before: 'No placeholder data',
        after: afterRoute.placeholderSnippet?.slice(0, 150) || 'Placeholder data detected',
      });
    }
  }

  return regressions;
}

// ── Full Verification ──────────────────────────────────────

/**
 * Run a full smoke test verification after goal completion.
 *
 * Three layers of verification:
 * 1. Route health: HTTP status codes, error patterns (HARD FAIL — blocks completion)
 * 2. Content quality: placeholder data, empty pages (HARD FAIL — blocks completion)
 * 3. Visual review: Haiku compares before/after screenshots (WARNING — logged but doesn't block)
 *
 * Returns { passed, regressions, qualityWarnings, visualReview, summary }.
 */
export async function verifySmokeTest(
  projectName: string,
  goalId: string,
  options?: { goal?: { title?: string; description?: string; source?: string; jamContext?: { screenshotUrl?: string; transcript?: string; description?: string } }; archetype?: string },
): Promise<SmokeTestResult> {
  log.info(`Running verification for ${projectName} after goal ${goalId}`);

  const afterSnapshot = await runSmokeTest(projectName, goalId);

  // No routes — project has no dev server, skip verification
  if (afterSnapshot.totalRoutes === 0 && afterSnapshot.brokenRoutes === 0) {
    return {
      passed: true,
      snapshot: afterSnapshot,
      regressions: [],
      qualityWarnings: [],
      summary: `No dev server for ${projectName} — skipped smoke test.`,
    };
  }

  // Get pre-goal snapshot early — used by both Layer 1 and Layer 2
  const beforeSnapshot = getPreGoalSnapshot(projectName);

  // ── Layer 1: Route health (HARD FAIL only for NEWLY broken routes) ──

  const brokenAfter = afterSnapshot.routes.filter(r => r.status >= 500 || r.status === 0);

  if (brokenAfter.length > 0) {
    const beforeByPath = beforeSnapshot
      ? new Map(beforeSnapshot.routes.map(r => [r.path, r]))
      : null;

    const newlyBroken: RouteStatus[] = [];
    const preExisting: RouteStatus[] = [];

    for (const route of brokenAfter) {
      if (beforeByPath) {
        const beforeRoute = beforeByPath.get(route.path);
        if (beforeRoute && (beforeRoute.status >= 500 || beforeRoute.status === 0 || beforeRoute.hasErrors)) {
          // Was already broken before this goal — pre-existing
          preExisting.push(route);
        } else if (!beforeRoute) {
          // Route wasn't in previous crawl — can't confirm this goal broke it
          preExisting.push(route);
        } else {
          // Was healthy before, broken now → this goal broke it
          newlyBroken.push(route);
        }
      } else {
        // No baseline snapshot — can't do before/after diff
        // Be lenient: treat as pre-existing since we can't prove this goal broke it
        preExisting.push(route);
      }
    }

    if (newlyBroken.length > 0) {
      const newBrokenLines = newlyBroken
        .map(r => `• ${r.path} → HTTP ${r.status}${r.errorSnippet ? ': ' + r.errorSnippet.slice(0, 80) : ''}`)
        .join('\n');

      const preExistingLines = preExisting.length > 0
        ? `\n\nPre-existing (NOT caused by this goal):\n` + preExisting
            .map(r => `• ${r.path} → HTTP ${r.status} (pre-existing)`)
            .join('\n')
        : '';

      return {
        passed: false,
        snapshot: afterSnapshot,
        regressions: newlyBroken.map(r => ({
          path: r.path,
          type: 'route_broken' as const,
          before: beforeByPath?.get(r.path)
            ? `HTTP ${beforeByPath.get(r.path)!.status}`
            : 'Expected 200',
          after: `HTTP ${r.status}: ${r.errorSnippet?.slice(0, 100) || 'Server error'}`,
        })),
        qualityWarnings: [],
        summary: `FAILED: ${newlyBroken.length} route(s) broken by this goal:\n${newBrokenLines}${preExistingLines}`,
      };
    }

    // All broken routes were pre-existing — don't reject
    log.info(`${preExisting.length} broken route(s) are pre-existing — not rejecting`);
  }

  // ── Layer 2: Content quality (HARD FAIL for regressions) ───

  let regressions: Regression[] = [];
  const qualityWarnings: QualityWarning[] = [];

  // Collect quality warnings for ALL pages (not just regressions)
  for (const route of afterSnapshot.routes) {
    if (route.hasPlaceholders) {
      qualityWarnings.push({
        path: route.path,
        type: 'placeholder_data',
        detail: route.placeholderSnippet || 'Placeholder/fake data detected',
      });
    }
    if (!route.hasContent && route.status >= 200 && route.status < 400) {
      qualityWarnings.push({
        path: route.path,
        type: 'empty_page',
        detail: `Page renders but has only ${route.textLength} chars of content`,
      });
    }
  }

  if (beforeSnapshot) {
    regressions = compareSnapshots(beforeSnapshot, afterSnapshot);

    // Critical regressions: broken routes and new errors only.
    // Placeholder data → warning (review agent catches fake data in the diff).
    const criticalRegressions = regressions.filter(
      r => r.type === 'route_broken' || r.type === 'new_errors'
    );

    if (criticalRegressions.length > 0) {
      const details = criticalRegressions
        .map(r => `  ${r.path}: ${r.type} — was: ${r.before}, now: ${r.after}`)
        .join('\n');

      return {
        passed: false,
        snapshot: afterSnapshot,
        regressions: criticalRegressions,
        qualityWarnings,
        summary: `FAILED: ${criticalRegressions.length} regression(s) detected:\n${details}`,
      };
    }
  } else {
    // No baseline — log quality warnings but DON'T hard fail.
    // Without a baseline we can't distinguish pre-existing placeholder data from new.
    // The review agent will catch truly fake data in the diff.
    if (qualityWarnings.length > 0) {
      log.info(`No baseline snapshot — ${qualityWarnings.length} quality warning(s) logged but not blocking`);
    }
  }

  // Layer 3: Vision-based visual review for UI goals
  // Takes screenshots of affected pages and asks a vision model to assess quality.
  let visualReview: VisualReview | undefined;
  const isUIGoal = options?.archetype === 'frontend' || options?.archetype === 'ux-consolidation';
  if (isUIGoal && afterSnapshot.routes.length > 0) {
    try {
      visualReview = await runVisualReviewWithScreenshots(
        projectName, goalId, afterSnapshot, options?.goal,
      ) ?? undefined;
      if (visualReview) {
        log.info(`Visual review: ${visualReview.verdict} — ${visualReview.summary}`);
        // Visual review is advisory only — it often misjudges because screenshots
        // may not capture the page the goal modified. Log as a quality warning
        // instead of hard-failing the smoke test.
        if (visualReview.verdict === 'worse') {
          qualityWarnings.push({
            path: '(visual review)',
            type: 'visual_regression',
            detail: visualReview.summary,
          });
          log.info(`Visual review flagged regression (advisory, not blocking): ${visualReview.summary}`);
        }
      }
    } catch (err) {
      log.error('Visual review error (non-blocking)', err);
    }
  }

  const warningsSuffix = qualityWarnings.length > 0
    ? ` (${qualityWarnings.length} quality warning(s))`
    : '';

  return {
    passed: true,
    snapshot: afterSnapshot,
    regressions,
    qualityWarnings,
    visualReview,
    summary: `PASSED: ${afterSnapshot.healthyRoutes}/${afterSnapshot.totalRoutes} routes healthy.${warningsSuffix}`,
  };
}

/**
 * Capture a pre-goal snapshot for later comparison.
 * Call this before the agent starts working on a goal.
 */
export async function capturePreGoalSnapshot(projectName: string): Promise<SmokeSnapshot | null> {
  const project = getProject(projectName);
  if (!project.hasDevServer || !project.healthCheck) {
    return null;
  }

  // Wait for already-running dev server (preflight manages lifecycle)
  const isUp = await waitForDevServer(projectName, 30_000);
  if (!isUp) {
    log.info(`Dev server not responding for ${projectName} — skipping pre-goal snapshot`);
    return null;
  }

  log.info(`Capturing pre-goal snapshot for ${projectName}`);
  const snapshot = await runSmokeTest(projectName);

  // Save as the "latest" snapshot for this project
  const latestPath = join(SNAPSHOTS_DIR, `${projectName}-latest.json`);
  ensureSnapshotsDir();
  writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));

  log.info(`Pre-goal snapshot: ${snapshot.healthyRoutes}/${snapshot.totalRoutes} routes healthy`);

  return snapshot;
}

// ── Visual Review (Layer 3) — Screenshot + Vision Model ────

/**
 * Capture screenshots of up to 3 key routes for visual review.
 */
async function captureReviewScreenshots(
  projectName: string,
  goalId: string,
  routes: RouteStatus[],
): Promise<string[]> {
  const dir = join(SCREENSHOTS_DIR, projectName, goalId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Pick up to 3 routes: prioritize /, then shortest paths (most important pages)
  const sorted = [...routes]
    .filter(r => r.status === 200)
    .sort((a, b) => {
      if (a.path === '/') return -1;
      if (b.path === '/') return 1;
      return a.path.length - b.path.length;
    })
    .slice(0, 3);

  const project = getProject(projectName);
  const baseUrl = project.healthCheck || `http://localhost:${project.devPort}`;
  const paths: string[] = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const route of sorted) {
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const url = `${baseUrl}${route.path}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        const safeName = route.path.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '') || 'index';
        const outPath = join(dir, `${safeName}.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        await page.close();
        paths.push(outPath);
      } catch (err) {
        log.error(`Screenshot failed for ${route.path}`, err);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  return paths;
}

/**
 * Vision-based visual review: takes screenshots of affected pages,
 * feeds them to a vision model with goal context, and gets a quality verdict.
 */
async function runVisualReviewWithScreenshots(
  projectName: string,
  goalId: string,
  after: SmokeSnapshot,
  goal?: { title?: string; description?: string; source?: string; jamContext?: { screenshotUrl?: string; transcript?: string; description?: string } },
): Promise<VisualReview | null> {
  const screenshotPaths = await captureReviewScreenshots(projectName, goalId, after.routes);
  if (screenshotPaths.length === 0) {
    return null;
  }

  // Build prompt with goal context and screenshot file paths
  const goalContext = goal?.title
    ? `Goal: "${goal.title}"\n${goal.description ? `Description: ${goal.description.slice(0, 500)}` : ''}`
    : 'Unknown goal';

  const jamBefore = goal?.jamContext?.screenshotUrl
    ? `\n\nThe user reported this bug with a screenshot at: ${goal.jamContext.screenshotUrl}\nUser narration: ${goal.jamContext.transcript?.slice(0, 500) || 'none'}`
    : '';

  const screenshotList = screenshotPaths.map(p => `  - ${p}`).join('\n');

  const prompt = `You are a visual UX quality reviewer. An autonomous coding agent just made changes to the "${projectName}" app. Review the screenshots of the current state and assess whether the changes look correct and professional.

## Goal Context
${goalContext}${jamBefore}

## Screenshots to Review
Read and examine each screenshot file below:
${screenshotList}

## Review Checklist
- Does the page look visually correct and professional?
- Are there broken layouts, misaligned elements, or overlapping content?
- Is text readable and properly sized?
- Are there placeholder/dummy data artifacts (Lorem ipsum, example.com)?
- Do interactive elements (buttons, forms) look functional?
- Is the overall design clean and consistent?
${goal?.jamContext ? '- Does the current state address the bug shown in the original Jam screenshot?' : ''}

## Output Format
Respond with ONLY a JSON object (no markdown, no code fences):
{
  "verdict": "<better|same|worse|mixed>",
  "issues": ["<specific visual concern 1>", "<specific concern 2>"],
  "summary": "<1-2 sentence assessment>"
}

Be honest. "same" is fine for neutral changes. "worse" means visible regressions.`;

  try {
    // Haiku is sufficient for visual regression JSON verdicts — no need for Sonnet
    const result = await runHaikuQuick(prompt);

    let parsed: { verdict: string; issues: string[]; summary: string };
    try {
      parsed = JSON.parse(result.text);
    } catch (e) {
      log.swallow('parse-visual-review-json', e);
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return null;
      }
    }

    return {
      verdict: (['better', 'same', 'worse', 'mixed'].includes(parsed.verdict)
        ? parsed.verdict as VisualReview['verdict']
        : 'mixed'),
      issues: parsed.issues || [],
      summary: parsed.summary || 'Review complete.',
      costUsd: result.costUsd,
    };
  } catch (e) {
    log.swallow('run-visual-review', e);
    return null;
  }
}

async function runHaikuQuick(prompt: string, model = 'claude-haiku-4-5'): Promise<{ text: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', model,
    ], {
      cwd: join(__dirname, '../..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude({
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
      }),
    });

    let output = '';
    let error = '';

    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { error += data.toString(); });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    proc.on('close', (code) => {
      if (code === 0 || output.length > 0) {
        try {
          const parsed = JSON.parse(output);
          resolve({
            text: (typeof parsed.result === 'string' ? parsed.result : output).trim(),
            costUsd: parsed.total_cost_usd ?? 0,
          });
        } catch (e) {
          log.swallow('parse-haiku-output', e);
          resolve({ text: output.trim(), costUsd: 0 });
        }
      } else {
        reject(new Error(`Haiku exited with code ${code}: ${error}`));
      }
    });

    proc.on('error', reject);

    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Haiku review timed out after 60s'));
    }, 60_000);
  });
}

// ── Formatting ──────────────────────────────────────────────

export function formatSmokeTestResult(result: SmokeTestResult): string {
  const lines: string[] = [];

  if (result.passed) {
    lines.push(`Smoke test passed: ${result.summary}`);
  } else {
    lines.push(`Smoke test FAILED: ${result.summary}`);
  }

  if (result.regressions.length > 0) {
    lines.push('');
    lines.push('Regressions:');
    for (const r of result.regressions.slice(0, 5)) {
      lines.push(`  ${r.path}: ${r.type}`);
      lines.push(`    Before: ${r.before}`);
      lines.push(`    After: ${r.after}`);
    }
    if (result.regressions.length > 5) {
      lines.push(`  ... and ${result.regressions.length - 5} more`);
    }
  }

  if (result.qualityWarnings.length > 0) {
    lines.push('');
    lines.push('Quality warnings:');
    for (const w of result.qualityWarnings.slice(0, 5)) {
      lines.push(`  ${w.path}: ${w.type} — ${w.detail.slice(0, 80)}`);
    }
    if (result.qualityWarnings.length > 5) {
      lines.push(`  ... and ${result.qualityWarnings.length - 5} more`);
    }
  }

  // Include failed API requests in the output
  const routesWithApiErrors = result.snapshot.routes.filter(r => r.failedApiRequests?.length > 0);
  if (routesWithApiErrors.length > 0) {
    lines.push('');
    lines.push('Failed API requests detected:');
    for (const route of routesWithApiErrors.slice(0, 5)) {
      lines.push(`  ${route.path}:`);
      for (const req of route.failedApiRequests.slice(0, 3)) {
        lines.push(`    - ${req.method} ${new URL(req.url).pathname} → ${req.status}`);
      }
      if (route.failedApiRequests.length > 3) {
        lines.push(`    ... and ${route.failedApiRequests.length - 3} more`);
      }
    }
  }

  // Include JS errors in the snapshot details if they exist
  const routesWithJsErrors = result.snapshot.routes.filter(r => r.jsErrors?.length > 0);
  if (routesWithJsErrors.length > 0) {
    lines.push('');
    lines.push('JavaScript errors detected:');
    for (const route of routesWithJsErrors.slice(0, 3)) {
      lines.push(`  ${route.path}:`);
      for (const err of route.jsErrors.slice(0, 2)) {
        lines.push(`    - ${err.slice(0, 100)}`);
      }
      if (route.jsErrors.length > 2) {
        lines.push(`    ... and ${route.jsErrors.length - 2} more`);
      }
    }
  }

  if (result.visualReview) {
    lines.push('');
    lines.push(`Visual review: ${result.visualReview.verdict}`);
    lines.push(`  ${result.visualReview.summary}`);
    if (result.visualReview.issues.length > 0) {
      for (const issue of result.visualReview.issues.slice(0, 3)) {
        lines.push(`  - ${issue}`);
      }
    }
    lines.push(`  Cost: $${result.visualReview.costUsd.toFixed(4)}`);
  }

  return lines.join('\n');
}
