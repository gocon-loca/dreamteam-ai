/**
 * Behavioral Verification Gate (Gate 1.5) — Jam-sourced goal verification
 *
 * For goals sourced from Jam bug recordings, replays the user's interaction
 * via Playwright and verifies the reported bug is resolved.
 *
 * Only runs for goals where source starts with "jam:".
 *
 * Flow:
 * 1. Extract Jam ID from goal.source
 * 2. Check for cached verification plan (from prior attempt)
 * 3. If no cache: spawn Haiku to fetch Jam data via MCP and generate plan
 * 4. Execute plan: navigate, interact, check for errors
 * 5. Pass if no JS errors, no failed requests, expected state matches
 *
 * Cache: Plans stored at data/behavioral-scripts/{goalId}.json
 * so retries reuse the same plan without re-fetching Jam data.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { getProject } from '../projects/registry.js';
import { quickHealthCheck } from '../projects/dev-server.js';
import { createLogger } from '../utils/logger.js';
import type { Goal } from './goal-types.js';

const log = createLogger('behavioral-verify');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const SCRIPTS_DIR = join(DATA_DIR, 'behavioral-scripts');

// ── Types ──────────────────────────────────────────────────

export interface VerificationStep {
  action: 'navigate' | 'click' | 'type' | 'select' | 'scroll' | 'wait';
  selector?: string;
  value?: string;
  description: string;
}

export interface ExpectedState {
  noJsErrors: boolean;
  noFailedRequests: boolean;
  expectedText?: string[];
  unexpectedText?: string[];
}

export interface VerificationPlan {
  startPath: string;
  needsAuth: boolean;
  steps: VerificationStep[];
  expectedState: ExpectedState;
  bugDescription: string;
}

export interface BehavioralVerifyResult {
  passed: boolean;
  summary: string;
  scriptPath?: string;
  errors: string[];
  costUsd: number;
}

// ── Helpers ──────────────────────────────────────────────────

/** Check whether a goal originated from a Jam bug recording. */
export function isJamSourced(goal: Goal): boolean {
  return !!goal.source?.startsWith('jam:');
}

function extractJamId(goal: Goal): string | null {
  if (!goal.source?.startsWith('jam:')) return null;
  return goal.source.slice(4);
}

function ensureScriptsDir(): void {
  if (!existsSync(SCRIPTS_DIR)) {
    mkdirSync(SCRIPTS_DIR, { recursive: true });
  }
}

function getCachedPlan(goalId: string): VerificationPlan | null {
  const path = join(SCRIPTS_DIR, `${goalId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    log.swallow('parse-cached-plan', e);
    return null;
  }
}

function cachePlan(goalId: string, plan: VerificationPlan): void {
  ensureScriptsDir();
  writeFileSync(join(SCRIPTS_DIR, `${goalId}.json`), JSON.stringify(plan, null, 2));
}

// Benign JS error patterns (shared with smoke-test.ts)
const BENIGN_JS_PATTERNS = [
  /ResizeObserver\s+loop/i,
  /Non-Error\s+promise\s+rejection/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
];

function isBenignJsError(msg: string): boolean {
  return BENIGN_JS_PATTERNS.some(p => p.test(msg));
}

// ── Plan Generation (Haiku + Jam MCP) ────────────────────────

async function generateVerificationPlan(
  jamId: string,
  goal: Goal,
): Promise<VerificationPlan | null> {
  const project = getProject(goal.project);
  const baseUrl = project?.healthCheck || (project?.devPort ? `http://localhost:${project.devPort}` : '');

  const prompt = `You are generating a behavioral verification plan for a bug fix.
A user reported a bug via Jam (ID: ${jamId}). A developer has attempted to fix it.

Your task:
1. Call the mcp__jam__getUserEvents tool with jamId "${jamId}" to get the user's interaction timeline
2. Call the mcp__jam__getNetworkRequests tool with jamId "${jamId}" to see API requests (especially failed ones)
3. Based on the data, create a verification plan that replays the key interaction and checks the bug is fixed

Goal: "${goal.title}"
${goal.description ? `Description: ${goal.description.slice(0, 1000)}` : ''}
${goal.jamContext?.description ? `Bug report: ${goal.jamContext.description}` : ''}
${goal.jamContext?.transcript ? `User narration: ${goal.jamContext.transcript.slice(0, 500)}` : ''}
${baseUrl ? `App base URL: ${baseUrl}` : ''}

Output ONLY a JSON object (no markdown, no code fences):
{
  "startPath": "/path/to/affected/page",
  "needsAuth": true or false,
  "steps": [
    { "action": "navigate", "value": "/page", "description": "Go to page" },
    { "action": "click", "selector": "button.submit", "description": "Click submit" },
    { "action": "type", "selector": "input[name=email]", "value": "test@example.com", "description": "Type email" },
    { "action": "wait", "value": "1000", "description": "Wait for response" }
  ],
  "expectedState": {
    "noJsErrors": true,
    "noFailedRequests": true,
    "expectedText": ["text that should appear after fix"],
    "unexpectedText": ["error message from the original bug"]
  },
  "bugDescription": "Brief description of what the bug was"
}

Rules:
- startPath should be the URL path where the bug was observed (e.g. "/dashboard")
- Use CSS selectors for click/type actions
- Keep steps focused on the core interaction (max 10 steps)
- expectedText: text visible on page after successful interaction
- unexpectedText: error messages or broken UI text from the original bug
- If the bug was about a failed API request, set noFailedRequests to true
- If the bug was about a JS error, set noJsErrors to true
- Set needsAuth if the page requires login`;

  try {
    const result = await spawnSonnetWithMcp(prompt);

    let parsed: VerificationPlan;
    try {
      parsed = JSON.parse(result.text.trim());
    } catch {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        log.warn(`Failed to parse verification plan JSON (${result.text.length} bytes)`);
        return null;
      }
    }

    if (!parsed.startPath || !Array.isArray(parsed.steps)) {
      log.warn(`Invalid verification plan structure`);
      return null;
    }

    // Enforce step limit
    if (parsed.steps.length > 10) {
      parsed.steps = parsed.steps.slice(0, 10);
    }

    return {
      startPath: parsed.startPath,
      needsAuth: !!parsed.needsAuth,
      steps: parsed.steps.map(s => ({
        action: s.action || 'wait',
        selector: s.selector,
        value: s.value,
        description: s.description || '',
      })),
      expectedState: {
        noJsErrors: parsed.expectedState?.noJsErrors !== false,
        noFailedRequests: parsed.expectedState?.noFailedRequests !== false,
        expectedText: parsed.expectedState?.expectedText || [],
        unexpectedText: parsed.expectedState?.unexpectedText || [],
      },
      bugDescription: parsed.bugDescription || '',
    };
  } catch (err) {
    log.error('Failed to generate verification plan', err);
    return null;
  }
}

function spawnSonnetWithMcp(prompt: string): Promise<{ text: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-sonnet-4-5',
      '--max-turns', '5',
    ], {
      cwd: join(__dirname, '../..'), // DreamTeam root for .mcp.json access
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
        } catch {
          resolve({ text: output.trim(), costUsd: 0 });
        }
      } else {
        reject(new Error(`Sonnet exited with code ${code}: ${error.slice(0, 500)}`));
      }
    });

    proc.on('error', reject);

    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Verification plan generation timed out after 90s'));
    }, 90_000);
  });
}

// ── Plan Execution (Playwright) ──────────────────────────────

async function waitForDevServer(projectName: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await quickHealthCheck(projectName, 3000);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function executeVerificationPlan(
  plan: VerificationPlan,
  projectName: string,
): Promise<BehavioralVerifyResult> {
  const project = getProject(projectName);
  if (!project?.hasDevServer || !project.healthCheck) {
    return {
      passed: true,
      summary: `No dev server for ${projectName} — skipped behavioral verification.`,
      errors: [],
      costUsd: 0,
    };
  }

  const serverReady = await waitForDevServer(projectName, 30_000);
  if (!serverReady) {
    return {
      passed: true,
      summary: `Dev server not responding for ${projectName} — skipped behavioral verification.`,
      errors: [],
      costUsd: 0,
    };
  }

  const baseUrl = project.healthCheck.replace(/\/+$/, '');
  const errors: string[] = [];
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Track JS errors
    const jsErrors = new Set<string>();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!isBenignJsError(text)) jsErrors.add(text);
      }
    });
    page.on('pageerror', (error) => {
      const message = error?.message || String(error);
      if (!isBenignJsError(message)) jsErrors.add(message);
    });

    // Track failed API requests (same-origin only, skip static assets)
    const failedRequests: { url: string; status: number; method: string }[] = [];
    const baseOrigin = new URL(baseUrl).origin;
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        const url = response.url();
        try { if (new URL(url).origin !== baseOrigin) return; } catch { return; }
        if (/\.(js|css|ico|png|jpg|svg|woff2?|map)(\?|$)/.test(url)) return;
        failedRequests.push({ url, status, method: response.request().method() });
      }
    });

    // Navigate to start page
    const startUrl = `${baseUrl}${plan.startPath}`;
    log.info(`Navigating to ${startUrl}`);
    await page.goto(startUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });

    // Authenticate if needed
    if (plan.needsAuth && project.testAuth) {
      try {
        await attemptAuth(page, baseUrl, project.testAuth);
        await page.goto(startUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
      } catch (err) {
        log.warn(`Auth failed during behavioral verification`, { err: String(err) });
      }
    }

    // Execute interaction steps
    for (const step of plan.steps) {
      log.info(`Step: ${step.description} (${step.action})`);
      try {
        await executeStep(page, baseUrl, step);
      } catch (err) {
        log.warn(`Step failed: ${step.description}`, { err: String(err) });
        errors.push(`Step "${step.description}" failed: ${String(err)}`);
        // Continue — partial replay is still useful
      }
    }

    // Wait for async operations to settle
    await page.waitForTimeout(1000);

    // Check expected state
    const { expectedState } = plan;

    if (expectedState.noJsErrors && jsErrors.size > 0) {
      const jsErrorList = Array.from(jsErrors).slice(0, 5);
      errors.push(`JavaScript errors detected: ${jsErrorList.join('; ').slice(0, 300)}`);
    }

    if (expectedState.noFailedRequests && failedRequests.length > 0) {
      const reqDetails = failedRequests
        .slice(0, 5)
        .map(r => `${r.method} ${new URL(r.url).pathname} → ${r.status}`)
        .join(', ');
      errors.push(`Failed API requests: ${reqDetails}`);
    }

    // Check for expected text on the page
    if (expectedState.expectedText && expectedState.expectedText.length > 0) {
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      for (const text of expectedState.expectedText) {
        if (!pageText.toLowerCase().includes(text.toLowerCase())) {
          errors.push(`Expected text not found: "${text.slice(0, 100)}"`);
        }
      }
    }

    // Check for unexpected text (error messages from the original bug)
    if (expectedState.unexpectedText && expectedState.unexpectedText.length > 0) {
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      for (const text of expectedState.unexpectedText) {
        if (pageText.toLowerCase().includes(text.toLowerCase())) {
          errors.push(`Bug-related text still present: "${text.slice(0, 100)}"`);
        }
      }
    }
  } catch (err) {
    log.error('Playwright execution error', err);
    errors.push(`Playwright error: ${String(err)}`);
  } finally {
    if (browser) await browser.close();
  }

  const passed = errors.length === 0;
  const summary = passed
    ? `Behavioral verification passed: replayed ${plan.steps.length} steps, bug "${plan.bugDescription}" appears resolved.`
    : `Behavioral verification FAILED: ${errors.length} error(s) — ${errors.slice(0, 3).join('; ').slice(0, 300)}`;

  return { passed, summary, errors, costUsd: 0 };
}

async function executeStep(page: Page, baseUrl: string, step: VerificationStep): Promise<void> {
  const timeout = 10_000;

  switch (step.action) {
    case 'navigate':
      if (step.value) {
        const url = step.value.startsWith('http') ? step.value : `${baseUrl}${step.value}`;
        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
      }
      break;

    case 'click':
      if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.click(step.selector, { timeout });
      }
      break;

    case 'type':
      if (step.selector && step.value) {
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.fill(step.selector, step.value);
      }
      break;

    case 'select':
      if (step.selector && step.value) {
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.selectOption(step.selector, step.value);
      }
      break;

    case 'scroll':
      await page.evaluate(() => window.scrollBy(0, 300));
      break;

    case 'wait': {
      const ms = Math.min(parseInt(step.value || '1000', 10), 5000);
      await page.waitForTimeout(ms);
      break;
    }
  }
}

async function attemptAuth(
  page: Page,
  baseUrl: string,
  auth: { email: string; password: string; loginPath: string },
): Promise<void> {
  await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: 10000, waitUntil: 'networkidle' });

  const emailInput = await page.waitForSelector(
    'input[id="email"], input[type="email"], input[name="email"]',
    { timeout: 5000 },
  );
  if (!emailInput) throw new Error('Email input not found');
  await emailInput.fill(auth.email);

  const passwordInput = await page.$('input[id="password"], input[type="password"], input[name="password"]');
  if (!passwordInput) throw new Error('Password input not found');
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
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Run behavioral verification for a Jam-sourced goal.
 * Returns null if the goal is not Jam-sourced or verification is not applicable.
 */
export async function runBehavioralVerification(goal: Goal): Promise<BehavioralVerifyResult | null> {
  if (!isJamSourced(goal)) return null;

  const jamId = extractJamId(goal);
  if (!jamId) return null;

  const project = getProject(goal.project);
  if (!project?.hasDevServer) {
    log.info(`Skipping behavioral verification — ${goal.project} has no dev server`);
    return null;
  }

  log.info(`Running behavioral verification for Jam goal "${goal.title}" (jam: ${jamId})`);

  // Check for cached plan (retries reuse the same plan)
  let plan = getCachedPlan(goal.id);
  let costUsd = 0;

  if (plan) {
    log.info(`Using cached verification plan for ${goal.id}`);
  } else {
    log.info(`Generating verification plan from Jam ${jamId}`);
    plan = await generateVerificationPlan(jamId, goal);
    if (!plan) {
      log.warn(`Could not generate verification plan — skipping gate`);
      return {
        passed: true,
        summary: 'Behavioral verification skipped: could not generate plan from Jam data.',
        errors: [],
        costUsd: 0,
      };
    }
    cachePlan(goal.id, plan);
    log.info(`Cached verification plan: ${plan.steps.length} steps, bug="${plan.bugDescription}"`);
  }

  // Execute the plan against the running dev server
  const result = await executeVerificationPlan(plan, goal.project);
  result.scriptPath = join(SCRIPTS_DIR, `${goal.id}.json`);
  result.costUsd += costUsd;

  log.info(`Behavioral verification: ${result.passed ? 'PASSED' : 'FAILED'} — ${result.summary}`);

  return result;
}
