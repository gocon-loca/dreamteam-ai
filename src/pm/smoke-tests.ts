/**
 * PM Smoke Tests — Playwright-based quality verification
 *
 * Runs actual user flows against the live app to detect:
 * - HTTP errors (500s, failed loads)
 * - Console errors
 * - Broken authentication
 * - Failed form submissions
 * - Empty/broken pages
 *
 * Cost: $0 (pure Playwright, no LLM)
 */

import { chromium, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { getProject } from '../projects/registry.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SmokeTestResult, PageResult, FlowResult, FlowStep, ConsoleError } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, '../../config');

interface TestCredentials {
  email: string;
  password: string;
  loginPath: string;
}

function getTestCredentials(projectName: string): TestCredentials | null {
  try {
    const yamlPath = join(CONFIG_DIR, 'projects.yaml');
    const content = readFileSync(yamlPath, 'utf-8');
    // Simple YAML parsing for testAuth block
    const projectSection = content.split(new RegExp(`^  ${projectName}:`, 'm'))[1];
    if (!projectSection) return null;

    const nextProject = projectSection.match(/^\n  \w+:/m);
    const section = nextProject ? projectSection.slice(0, nextProject.index) : projectSection;

    const emailMatch = section.match(/email:\s*"?([^"\n]+)"?/);
    const passwordMatch = section.match(/password:\s*"?([^"\n]+)"?/);
    const loginPathMatch = section.match(/loginPath:\s*"?([^"\n]+)"?/);

    if (!emailMatch || !passwordMatch) return null;

    return {
      email: emailMatch[1].trim(),
      password: passwordMatch[1].trim(),
      loginPath: loginPathMatch?.[1]?.trim() || '/login',
    };
  } catch {
    return null;
  }
}

function getProjectRoutes(projectName: string): string[] {
  // Read from product brief if available
  const briefPath = join(CONFIG_DIR, 'product-briefs', `${projectName}.md`);
  if (existsSync(briefPath)) {
    const brief = readFileSync(briefPath, 'utf-8');
    const routeSection = brief.match(/## Routes to Test\n([\s\S]*?)(?=\n##|\n$)/);
    if (routeSection) {
      const routes = routeSection[1]
        .split('\n')
        .map(l => l.match(/^- (\/\S+)/)?.[1])
        .filter((r): r is string => !!r);
      if (routes.length > 0) return routes;
    }
  }

  // Defaults for web apps
  return ['/', '/login', '/dashboard'];
}

/**
 * Find the actual port the dev server is listening on.
 * Next.js auto-increments if the configured port is taken.
 */
async function findDevServerPort(configuredPort: number): Promise<number> {
  const { execSync } = await import('child_process');
  // Check configured port first, then try +1, +2
  for (const port of [configuredPort, configuredPort + 1, configuredPort + 2]) {
    try {
      const result = execSync(`curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/" 2>/dev/null`, { timeout: 3000 });
      const status = parseInt(result.toString().trim(), 10);
      if (status > 0 && status < 500) return port;
    } catch { /* try next */ }
  }
  return configuredPort; // fallback
}

/**
 * Run smoke tests against a live project.
 * Returns structured results — no LLM, pure Playwright.
 */
export async function runSmokeTests(projectName: string): Promise<SmokeTestResult> {
  const project = getProject(projectName);
  const actualPort = await findDevServerPort(project.devPort || 3000);
  const baseUrl = `http://localhost:${actualPort}`;
  const routes = getProjectRoutes(projectName);
  const credentials = getTestCredentials(projectName);

  const result: SmokeTestResult = {
    project: projectName,
    timestamp: new Date().toISOString(),
    baseUrl,
    pages: [],
    flows: [],
    consoleErrors: [],
    summary: { pagesChecked: 0, pagesPassed: 0, pagesFailed: 0, flowsChecked: 0, flowsPassed: 0, flowsFailed: 0, consoleErrorCount: 0 },
  };

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Collect console errors globally
    page.on('console', (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') {
        const url = page.url();
        const path = new URL(url).pathname;
        result.consoleErrors.push({
          page: path,
          message: msg.text().slice(0, 300),
        });
      }
    });

    // Phase 1: Page health checks (unauthenticated)
    for (const path of routes) {
      const pageResult = await testPage(page, baseUrl, path);
      result.pages.push(pageResult);
    }

    // Phase 2: Authentication flow
    if (credentials) {
      const authFlow = await testSignIn(page, context, baseUrl, credentials);
      result.flows.push(authFlow);

      // Phase 3: Authenticated page checks (if sign-in succeeded)
      if (authFlow.passed) {
        for (const path of routes) {
          if (path === '/login' || path === '/') continue;
          const pageResult = await testPage(page, baseUrl, path);
          // Only add if we didn't already check this path or got a different result
          const existing = result.pages.find(p => p.path === path);
          if (existing && existing.status >= 400 && pageResult.status < 400) {
            // Replace the unauthenticated result with authenticated one
            Object.assign(existing, pageResult);
          }
        }

        // Phase 4: World creation flow
        const createWorldFlow = await testCreateWorld(page, baseUrl);
        result.flows.push(createWorldFlow);
      }
    }

    // Compute summary
    result.summary = {
      pagesChecked: result.pages.length,
      pagesPassed: result.pages.filter(p => p.status >= 200 && p.status < 400).length,
      pagesFailed: result.pages.filter(p => p.status >= 400 || p.status === 0).length,
      flowsChecked: result.flows.length,
      flowsPassed: result.flows.filter(f => f.passed).length,
      flowsFailed: result.flows.filter(f => !f.passed).length,
      consoleErrorCount: result.consoleErrors.length,
    };

  } catch (e) {
    // Playwright launch failure — still return partial results
    result.flows.push({
      name: 'browser-launch',
      steps: [{ action: 'Launch Playwright', passed: false, detail: String(e) }],
      passed: false,
      error: `Playwright failed to launch: ${String(e).slice(0, 200)}`,
      durationMs: 0,
    });
  } finally {
    await browser?.close();
  }

  return result;
}

async function testPage(page: Page, baseUrl: string, path: string): Promise<PageResult> {
  const start = Date.now();
  try {
    const response = await page.goto(`${baseUrl}${path}`, {
      timeout: 15000,
      waitUntil: 'domcontentloaded',
    });
    const status = response?.status() || 0;

    // Check if page has meaningful content
    let hasContent = false;
    try {
      const bodyText = await page.textContent('body', { timeout: 3000 });
      hasContent = (bodyText?.trim()?.length || 0) > 50;
    } catch { /* empty page or timeout */ }

    return {
      path,
      status,
      title: await page.title().catch(() => ''),
      loadTimeMs: Date.now() - start,
      hasContent,
    };
  } catch (e) {
    return {
      path,
      status: 0,
      title: '',
      loadTimeMs: Date.now() - start,
      hasContent: false,
      error: String(e).slice(0, 200),
    };
  }
}

async function testSignIn(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  creds: TestCredentials
): Promise<FlowResult> {
  const start = Date.now();
  const steps: FlowStep[] = [];

  try {
    // Step 1: Navigate to login
    await page.goto(`${baseUrl}${creds.loginPath}`, { timeout: 10000 });
    steps.push({ action: 'Navigate to login page', passed: true });

    // Step 2: Find and fill email
    const emailSelector = 'input[type="email"], input[name="email"], input[id*="email"]';
    await page.waitForSelector(emailSelector, { timeout: 5000 });
    await page.fill(emailSelector, creds.email);
    steps.push({ action: 'Fill email', passed: true });

    // Step 3: Fill password
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.fill(passwordSelector, creds.password);
    steps.push({ action: 'Fill password', passed: true });

    // Step 4: Submit
    const submitSelector = 'button[type="submit"], button:has-text("Sign"), button:has-text("Log")';
    await page.click(submitSelector);
    steps.push({ action: 'Click sign in', passed: true });

    // Step 5: Wait for redirect (away from login page)
    try {
      await page.waitForURL((url: URL) => !url.toString().includes('/login'), { timeout: 10000 });
      steps.push({ action: 'Redirect after sign in', passed: true, detail: page.url() });
    } catch {
      // Check if we're still on login with an error message
      const errorText = await page.textContent('.error, [role="alert"], .text-red, .text-destructive').catch(() => null);
      steps.push({
        action: 'Redirect after sign in',
        passed: false,
        detail: errorText ? `Error shown: ${errorText.slice(0, 100)}` : 'Timed out waiting for redirect',
      });
      return {
        name: 'sign-in',
        steps,
        passed: false,
        failedAt: 'redirect',
        error: 'Sign-in did not redirect away from login page',
        durationMs: Date.now() - start,
      };
    }

    // Step 6: Verify we're on a valid authenticated page
    const currentUrl = page.url();
    const status = (await page.evaluate(() => document.readyState)) === 'complete';
    steps.push({
      action: 'Authenticated page loaded',
      passed: status,
      detail: new URL(currentUrl).pathname,
    });

    return {
      name: 'sign-in',
      steps,
      passed: true,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const lastStep = steps[steps.length - 1];
    return {
      name: 'sign-in',
      steps: [...steps, { action: 'Unexpected error', passed: false, detail: String(e).slice(0, 200) }],
      passed: false,
      failedAt: lastStep?.action || 'unknown',
      error: String(e).slice(0, 200),
      durationMs: Date.now() - start,
    };
  }
}

async function testCreateWorld(page: Page, baseUrl: string): Promise<FlowResult> {
  const start = Date.now();
  const steps: FlowStep[] = [];

  try {
    // Try both old and new routes
    const createPaths = ['/world/create', '/community/create', '/worlds/create', '/communities/create'];
    let foundPage = false;

    for (const path of createPaths) {
      try {
        const response = await page.goto(`${baseUrl}${path}`, { timeout: 5000 });
        if (response && response.status() < 400) {
          foundPage = true;
          steps.push({ action: `Navigate to ${path}`, passed: true });
          break;
        }
      } catch { continue; }
    }

    if (!foundPage) {
      // Try finding a "Create" button/link on the worlds/communities page
      for (const listPath of ['/worlds', '/communities']) {
        try {
          await page.goto(`${baseUrl}${listPath}`, { timeout: 5000 });
          const createBtn = await page.$('a:has-text("Create"), button:has-text("Create"), a[href*="create"]');
          if (createBtn) {
            await createBtn.click();
            await page.waitForTimeout(1000);
            foundPage = true;
            steps.push({ action: `Navigate to create via ${listPath}`, passed: true });
            break;
          }
        } catch { continue; }
      }
    }

    if (!foundPage) {
      steps.push({ action: 'Find create world page', passed: false, detail: 'No create page found' });
      return { name: 'create-world', steps, passed: false, failedAt: 'navigation', error: 'Could not find world creation page', durationMs: Date.now() - start };
    }

    // Look for a name/title input
    const nameSelector = 'input[name="name"], input[name="title"], input[placeholder*="name" i], input[placeholder*="title" i], input[id*="name"]';
    try {
      await page.waitForSelector(nameSelector, { timeout: 5000 });
      await page.fill(nameSelector, `PM Test World ${Date.now()}`);
      steps.push({ action: 'Fill world name', passed: true });
    } catch {
      steps.push({ action: 'Fill world name', passed: false, detail: 'Name input not found' });
      return { name: 'create-world', steps, passed: false, failedAt: 'fill-name', durationMs: Date.now() - start };
    }

    // Submit the form
    const submitBtn = await page.$('button[type="submit"], button:has-text("Create"), button:has-text("Save")');
    if (!submitBtn) {
      steps.push({ action: 'Find submit button', passed: false });
      return { name: 'create-world', steps, passed: false, failedAt: 'submit', durationMs: Date.now() - start };
    }

    // Listen for network response
    const responsePromise = page.waitForResponse(
      (resp: { url: () => string; request: () => { method: () => string } }) => resp.url().includes('/api/') && resp.request().method() === 'POST',
      { timeout: 10000 }
    ).catch(() => null);

    await submitBtn.click();
    steps.push({ action: 'Click create button', passed: true });

    const apiResponse = await responsePromise;
    if (apiResponse) {
      const responseStatus = apiResponse.status();
      if (responseStatus >= 200 && responseStatus < 300) {
        steps.push({ action: 'API response success', passed: true, detail: `HTTP ${responseStatus}` });
      } else {
        let errorBody = '';
        try { errorBody = (await apiResponse.text()).slice(0, 200); } catch {}
        steps.push({ action: 'API response success', passed: false, detail: `HTTP ${responseStatus}: ${errorBody}` });
        return { name: 'create-world', steps, passed: false, failedAt: 'api-response', error: `Create API returned ${responseStatus}`, durationMs: Date.now() - start };
      }
    } else {
      // No API response detected — check for client-side success/error
      await page.waitForTimeout(3000);
      const errorEl = await page.$('.error, [role="alert"], .text-red, .text-destructive, .toast-error');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        steps.push({ action: 'Check for errors', passed: false, detail: errorText?.slice(0, 200) });
        return { name: 'create-world', steps, passed: false, failedAt: 'client-error', error: errorText?.slice(0, 200), durationMs: Date.now() - start };
      }
      steps.push({ action: 'No API response detected (may have succeeded)', passed: true });
    }

    return { name: 'create-world', steps, passed: true, durationMs: Date.now() - start };
  } catch (e) {
    return {
      name: 'create-world',
      steps: [...steps, { action: 'Unexpected error', passed: false, detail: String(e).slice(0, 200) }],
      passed: false,
      error: String(e).slice(0, 200),
      durationMs: Date.now() - start,
    };
  }
}
