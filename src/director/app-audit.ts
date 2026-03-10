/**
 * App Audit Agent — Playwright crawl + Haiku analysis
 *
 * Two-phase approach:
 * 1. Playwright crawl: navigate the app, capture pages/nav/interactive elements
 * 2. Haiku analysis: structured audit of features, UX issues, and summary
 *
 * Results saved to data/audits/{project}-audit.json
 */

import { spawn } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { chromium, type Browser, type Page } from '@playwright/test';
import { ensureDevServerRunning } from '../projects/dev-server.js';
import { getProject } from '../projects/registry.js';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const AUDITS_DIR = join(DATA_DIR, 'audits');

// ── Types ──────────────────────────────────────────────────

export interface AppAudit {
  project: string;
  timestamp: string;
  version: string;
  pages: PageAudit[];
  navigation: {
    type: 'sidebar' | 'tabs' | 'navbar' | 'mixed';
    depth: number;
    totalItems: number;
  };
  features: FeatureEntry[];
  uxIssues: UxIssue[];
  summary: string;
  costUsd: number;
}

export interface PageAudit {
  url: string;
  title: string;
  purpose: string;
  interactiveElements: number;
  contentStatus: 'populated' | 'empty' | 'error' | 'placeholder';
}

export interface FeatureEntry {
  name: string;
  category: string;
  status: 'working' | 'partial' | 'broken' | 'empty';
  pages: string[];
}

export interface UxIssue {
  type: 'redundant-nav' | 'empty-page' | 'dead-end' | 'deep-nesting' | 'orphan-feature';
  description: string;
  affectedPages: string[];
  suggestion: string;
}

interface CrawlPage {
  url: string;
  title: string;
  visibleTextSnippet: string;
  interactiveElementsCount: number;
  navLinks: string[];
}

interface CrawlResult {
  pages: CrawlPage[];
  navStructure: string[];
  totalRoutes: number;
}

// ── Crawl Phase ──────────────────────────────────────────────

async function crawlApp(projectName: string): Promise<CrawlResult> {
  const project = getProject(projectName);
  if (!project.healthCheck) {
    throw new Error(`Project ${projectName} has no healthCheck URL configured`);
  }

  await ensureDevServerRunning(projectName);

  // Try the configured healthCheck URL first; fall back to localhost if unreachable
  let baseUrl = project.healthCheck.replace(/\/+$/, '');
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
  } catch {
    // Health check URL unreachable — try localhost with same port
    if (project.devPort) {
      const localUrl = `http://127.0.0.1:${project.devPort}`;
      try {
        await fetch(localUrl, { signal: AbortSignal.timeout(3000) });
        console.log(`[Audit] Falling back to ${localUrl} (healthCheck URL unreachable)`);
        baseUrl = localUrl;
      } catch { /* both unreachable, let Playwright fail with a clear error */ }
    }
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page: Page = await context.newPage();

  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  const allNavLinks: string[] = [];

  try {
    // Navigate to landing page
    await page.goto(baseUrl, { timeout: 15000, waitUntil: 'networkidle' });

    // Authenticate if test credentials are available
    if (project.testAuth) {
      const authenticated = await attemptLogin(page, baseUrl, project.testAuth);
      if (authenticated) {
        console.log(`[Audit] Authenticated as ${project.testAuth.email}`);
        // Wait for async dashboard content to render (Next.js fetches data after hydration)
        await waitForAsyncContent(page);
      } else {
        console.log(`[Audit] Authentication failed, crawling as guest`);
      }
    }

    // Capture the current page (may be dashboard after auth, or landing page)
    const currentUrl = page.url();
    const landingPage = await capturePage(page, currentUrl);
    pages.push(landingPage);
    visited.add(currentUrl);
    // Also mark the baseUrl as visited to avoid re-crawling
    visited.add(baseUrl);

    // Collect nav links from the current (possibly authenticated) page
    const navSelectors = 'a[href], nav button, [role="tab"], [role="menuitem"]';
    const collectLinks = async () => {
      return page.$$eval(navSelectors, (els: Element[]) =>
        els.map((el: Element) => {
          const href = (el as HTMLAnchorElement).href || '';
          const text = el.textContent?.trim() || '';
          return { href, text };
        })
      );
    };

    const links = await collectLinks();

    // Filter to same-origin links (handle both baseUrl and current page origin)
    const currentOrigin = new URL(page.url()).origin;
    const baseOrigin = new URL(baseUrl).origin;
    const isAppLink = (href: string) => {
      try {
        const origin = new URL(href).origin;
        return origin === baseOrigin || origin === currentOrigin;
      } catch { return false; }
    };

    const navTargets: Array<{ href: string; text: string }> = [];
    for (const link of links) {
      if (link.href && isAppLink(link.href) && !visited.has(link.href)) {
        navTargets.push(link);
        allNavLinks.push(link.text || link.href);
      }
    }

    // Visit nav targets (max 20), discovering new links from each page
    const maxPages = 20;
    let targetIdx = 0;
    while (targetIdx < navTargets.length && pages.length < maxPages) {
      const target = navTargets[targetIdx++];
      if (visited.has(target.href)) continue;
      visited.add(target.href);

      try {
        await page.goto(target.href, { timeout: 8000, waitUntil: 'domcontentloaded' });
        // Brief wait for client-side rendering on sub-pages
        await page.waitForTimeout(1000);
        const crawled = await capturePage(page, target.href);
        pages.push(crawled);

        // Discover new links from this page
        const newLinks = await collectLinks();
        for (const link of newLinks) {
          if (link.href && isAppLink(link.href) && !visited.has(link.href)) {
            const alreadyQueued = navTargets.some(t => t.href === link.href);
            if (!alreadyQueued) {
              navTargets.push(link);
              allNavLinks.push(link.text || link.href);
            }
          }
        }
      } catch {
        // Page failed to load — record as error
        pages.push({
          url: target.href,
          title: target.text,
          visibleTextSnippet: '',
          interactiveElementsCount: 0,
          navLinks: [],
        });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    pages,
    navStructure: allNavLinks,
    totalRoutes: visited.size,
  };
}

async function capturePage(page: Page, url: string): Promise<CrawlPage> {
  const title = await page.title();

  const visibleText = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    return body.innerText.slice(0, 500);
  });

  const interactiveCount = await page.evaluate(() => {
    const selectors = 'button, input, select, textarea, a[href], [role="button"], [onclick]';
    return document.querySelectorAll(selectors).length;
  });

  const navLinks = await page.$$eval('a[href], nav button', (els: Element[]) =>
    els.map((el: Element) => (el as HTMLAnchorElement).href || el.textContent?.trim() || '').filter(Boolean)
  ) as string[];

  return {
    url,
    title,
    visibleTextSnippet: visibleText.slice(0, 300),
    interactiveElementsCount: interactiveCount,
    navLinks: [...new Set(navLinks)].slice(0, 20),
  };
}

// ── Authentication ──────────────────────────────────────────

async function attemptLogin(
  page: Page,
  baseUrl: string,
  auth: { email: string; password: string; loginPath: string },
): Promise<boolean> {
  try {
    // Check if we're already on a login page or if one exists
    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes('/login') || currentUrl.includes('/sign-in');

    if (!isOnLogin) {
      // Check if the page has a login form (redirected to login)
      const hasLoginForm = await page.$('input[type="email"], input[id="email"]');
      if (!hasLoginForm) {
        // Navigate to the login page explicitly
        await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: 10000, waitUntil: 'networkidle' });
      }
    }

    // Wait for email input to be visible
    const emailInput = await page.waitForSelector('input[id="email"], input[type="email"], input[name="email"]', { timeout: 5000 });
    if (!emailInput) return false;

    // Fill in credentials
    await emailInput.fill(auth.email);

    const passwordInput = await page.$('input[id="password"], input[type="password"], input[name="password"]');
    if (!passwordInput) return false;
    await passwordInput.fill(auth.password);

    // Submit the form
    const submitButton = await page.$('button[type="submit"]');
    if (submitButton) {
      await submitButton.click();
    } else {
      await passwordInput.press('Enter');
    }

    // Wait for navigation away from login page
    await page.waitForURL((url) => {
      const path = new URL(url).pathname;
      return !path.includes('/login') && !path.includes('/sign-in');
    }, { timeout: 10000 });

    // Wait for the authenticated page to load
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    console.log(`[Audit] Post-login URL: ${page.url()}`);
    return true;
  } catch (err) {
    console.error(`[Audit] Login attempt failed:`, err instanceof Error ? err.message : err);
    // Navigate back to base URL so crawl can continue as guest
    try {
      await page.goto(baseUrl, { timeout: 10000, waitUntil: 'networkidle' });
    } catch { /* best effort */ }
    return false;
  }
}

// ── Async Content Wait ──────────────────────────────────────

/**
 * After login, Next.js apps hydrate then fetch data asynchronously.
 * networkidle fires before these fetches complete. We wait for the
 * link count to stabilize, indicating async content has rendered.
 */
async function waitForAsyncContent(page: Page, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  let prevLinkCount = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(500);
    const linkCount = await page.$$eval('a[href]', (els: Element[]) => els.length);

    if (linkCount === prevLinkCount && linkCount > 0) {
      stableCount++;
      // Links stable for 1.5s (3 checks) — content has settled
      if (stableCount >= 3) {
        console.log(`[Audit] Async content settled (${linkCount} links found)`);
        return;
      }
    } else {
      stableCount = 0;
      prevLinkCount = linkCount;
    }
  }

  console.log(`[Audit] Async content wait timed out after ${timeoutMs}ms (${prevLinkCount} links)`);
}

// ── Analysis Phase ──────────────────────────────────────────

async function analyzeWithHaiku(projectName: string, crawl: CrawlResult): Promise<AppAudit> {
  const version = getGitVersion(projectName);

  const prompt = `You are a UX auditor. Analyze this crawl data from the "${projectName}" app and produce a structured audit.

## Crawl Data
${JSON.stringify(crawl, null, 2)}

## Output Format
Respond with ONLY a JSON object (no markdown, no code fences) matching this exact structure:
{
  "pages": [
    {
      "url": "<url>",
      "title": "<title>",
      "purpose": "<what this page does in one sentence>",
      "interactiveElements": <number>,
      "contentStatus": "<populated|empty|error|placeholder>"
    }
  ],
  "navigation": {
    "type": "<sidebar|tabs|navbar|mixed>",
    "depth": <max nesting level>,
    "totalItems": <number of top-level nav items>
  },
  "features": [
    {
      "name": "<feature name>",
      "category": "<category>",
      "status": "<working|partial|broken|empty>",
      "pages": ["<urls where this feature appears>"]
    }
  ],
  "uxIssues": [
    {
      "type": "<redundant-nav|empty-page|dead-end|deep-nesting|orphan-feature>",
      "description": "<what's wrong>",
      "affectedPages": ["<urls>"],
      "suggestion": "<how to fix>"
    }
  ],
  "summary": "<2-3 sentence overview of app state, key strengths, main UX concerns>"
}

Be thorough but concise. Focus on real issues — empty pages, redundant navigation, dead ends, orphan features.`;

  const result = await runHaiku(prompt);

  let analysis: {
    pages: PageAudit[];
    navigation: AppAudit['navigation'];
    features: FeatureEntry[];
    uxIssues: UxIssue[];
    summary: string;
  };

  try {
    analysis = JSON.parse(result.text);
  } catch {
    // Attempt to extract JSON from response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Haiku returned non-JSON response');
    }
  }

  const audit: AppAudit = {
    project: projectName,
    timestamp: new Date().toISOString(),
    version,
    pages: analysis.pages || [],
    navigation: analysis.navigation || { type: 'mixed', depth: 1, totalItems: 0 },
    features: analysis.features || [],
    uxIssues: analysis.uxIssues || [],
    summary: analysis.summary || 'Audit complete.',
    costUsd: result.costUsd,
  };

  return audit;
}

function getGitVersion(projectName: string): string {
  try {
    const project = getProject(projectName);
    return execSync('git rev-parse --short HEAD', {
      cwd: project.path,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

interface HaikuResult {
  text: string;
  costUsd: number;
}

async function runHaiku(prompt: string): Promise<HaikuResult> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-haiku-4-5',
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
        } catch {
          resolve({ text: output.trim(), costUsd: 0 });
        }
      } else {
        reject(new Error(`Haiku exited with code ${code}: ${error}`));
      }
    });

    proc.on('error', reject);

    // Timeout after 2 minutes
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Haiku timed out after 2 minutes'));
    }, 120_000);
  });
}

// ── Public API ──────────────────────────────────────────────

export async function runAppAudit(projectName: string): Promise<AppAudit> {
  // Validate project exists
  getProject(projectName);

  console.log(`[Audit] Starting audit for ${projectName}...`);

  // Phase 1: Playwright crawl
  console.log(`[Audit] Phase 1: Crawling ${projectName}...`);
  const crawl = await crawlApp(projectName);
  console.log(`[Audit] Crawled ${crawl.totalRoutes} pages`);

  // Phase 2: Haiku analysis
  console.log(`[Audit] Phase 2: Analyzing with Haiku...`);
  const audit = await analyzeWithHaiku(projectName, crawl);

  // Save to disk
  if (!existsSync(AUDITS_DIR)) {
    mkdirSync(AUDITS_DIR, { recursive: true });
  }
  writeFileSync(
    join(AUDITS_DIR, `${projectName}-audit.json`),
    JSON.stringify(audit, null, 2)
  );

  console.log(`[Audit] Complete. ${audit.pages.length} pages, ${audit.features.length} features, ${audit.uxIssues.length} issues. Cost: $${audit.costUsd.toFixed(4)}`);

  return audit;
}

export function getLatestAudit(project: string): AppAudit | null {
  const filePath = join(AUDITS_DIR, `${project}-audit.json`);
  if (!existsSync(filePath)) return null;

  try {
    const audit: AppAudit = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Return null if older than 24h
    const ageMs = Date.now() - new Date(audit.timestamp).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) return null;
    return audit;
  } catch {
    return null;
  }
}

export function isAuditStale(project: string): boolean {
  const filePath = join(AUDITS_DIR, `${project}-audit.json`);
  if (!existsSync(filePath)) return true;

  try {
    const audit: AppAudit = JSON.parse(readFileSync(filePath, 'utf-8'));
    const ageMs = Date.now() - new Date(audit.timestamp).getTime();
    return ageMs > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

export function formatAuditSummary(audit: AppAudit): string {
  const lines: string[] = [];

  lines.push(`📊 Audit: ${audit.project} (${audit.version})`);
  lines.push('');
  lines.push(audit.summary);
  lines.push('');
  lines.push(`📄 Pages: ${audit.pages.length} | Nav: ${audit.navigation.type} (${audit.navigation.totalItems} items)`);
  lines.push(`🔧 Features: ${audit.features.length} detected`);

  // Feature status breakdown
  const statusCounts = { working: 0, partial: 0, broken: 0, empty: 0 };
  for (const f of audit.features) {
    if (f.status in statusCounts) statusCounts[f.status as keyof typeof statusCounts]++;
  }
  const statusParts: string[] = [];
  if (statusCounts.working) statusParts.push(`${statusCounts.working} working`);
  if (statusCounts.partial) statusParts.push(`${statusCounts.partial} partial`);
  if (statusCounts.broken) statusParts.push(`${statusCounts.broken} broken`);
  if (statusCounts.empty) statusParts.push(`${statusCounts.empty} empty`);
  if (statusParts.length) lines.push(`  ${statusParts.join(', ')}`);

  // UX issues
  if (audit.uxIssues.length > 0) {
    lines.push('');
    lines.push(`⚠️ UX Issues: ${audit.uxIssues.length}`);
    for (const issue of audit.uxIssues.slice(0, 5)) {
      lines.push(`  • ${issue.type}: ${issue.description}`);
    }
    if (audit.uxIssues.length > 5) {
      lines.push(`  ... and ${audit.uxIssues.length - 5} more`);
    }
  }

  lines.push('');
  lines.push(`💰 Cost: $${audit.costUsd.toFixed(4)}`);

  return lines.join('\n');
}
