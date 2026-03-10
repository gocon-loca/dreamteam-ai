/**
 * Usage Scraper — Fetch real weekly usage % from claude.ai/settings/usage
 *
 * Uses Playwright with a persistent browser profile to maintain Cloudflare clearance.
 * First run requires `node dist/orchestration/usage-scraper.js --setup` to solve
 * the Cloudflare challenge interactively. After that, headless scrapes work.
 *
 * Caches the result for 30 minutes to avoid excessive scraping.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';
import { createLogger } from '../utils/logger.js';

const log = createLogger('usage-scraper');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const CACHE_FILE = join(DATA_DIR, 'usage-cache.json');
const BROWSER_STATE_DIR = join(DATA_DIR, 'browser-state');

// Cache TTL: 30 minutes
const CACHE_TTL_MS = 30 * 60 * 1000;

interface UsageCache {
  weeklyUsagePct: number;    // 0-100
  fetchedAt: string;         // ISO timestamp
  planType: string;          // e.g. "max", "pro"
  rawText?: string;          // raw text from the page for debugging
}

function loadCache(): UsageCache | null {
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as UsageCache;
      const age = Date.now() - new Date(data.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return data;
      }
    }
  } catch (e) {
    log.swallow('load-usage-cache', e);
  }
  return null;
}

function saveCache(cache: UsageCache): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    log.swallow('save-usage-cache', e);
  }
}

/**
 * Load OAuth credentials from Claude CLI's credential file.
 */
function getOAuthCredentials(): { accessToken: string; subscriptionType: string } | null {
  try {
    const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
    const credPath = join(homedir, '.claude', '.credentials.json');
    if (!existsSync(credPath)) return null;
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      subscriptionType: oauth.subscriptionType || 'unknown',
    };
  } catch (e) {
    log.swallow('load-oauth-creds', e);
    return null;
  }
}

/**
 * Interactive setup: opens a visible browser for the user to solve Cloudflare
 * and log into claude.ai. Saves the browser state for subsequent headless use.
 */
async function interactiveSetup(): Promise<void> {
  console.log('\n🔧 Usage Scraper Setup');
  console.log('A browser window will open. Please:');
  console.log('  1. Solve the Cloudflare challenge if prompted');
  console.log('  2. Log into claude.ai if needed');
  console.log('  3. Navigate to Settings → Usage');
  console.log('  4. Once you see the usage page, close the browser\n');

  if (!existsSync(BROWSER_STATE_DIR)) mkdirSync(BROWSER_STATE_DIR, { recursive: true });

  const browser = await chromium.launchPersistentContext(BROWSER_STATE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://claude.ai/settings/usage');

  // Wait for user to close the browser
  await new Promise<void>((resolve) => {
    browser.on('close', () => resolve());
  });

  console.log('✅ Browser state saved. Headless scrapes should now work.\n');
}

/**
 * Scrape the usage page using persistent browser state.
 */
async function scrapeUsagePage(): Promise<UsageCache | null> {
  const creds = getOAuthCredentials();
  if (!creds) {
    log.warn('No OAuth credentials found — cannot scrape usage');
    return null;
  }

  // Check if we have browser state from interactive setup
  if (!existsSync(BROWSER_STATE_DIR)) {
    log.info('No browser state — run `node dist/orchestration/usage-scraper.js --setup` first');
    return null;
  }

  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(BROWSER_STATE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    });

    const page = browser.pages()[0] || await browser.newPage();

    // Navigate to the usage page
    await page.goto('https://claude.ai/settings/usage', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for content to load
    await page.waitForTimeout(3000);

    // Check if we hit the Cloudflare challenge
    const title = await page.title();
    if (title.includes('Just a moment') || title.includes('Cloudflare')) {
      log.warn('Cloudflare challenge — browser state expired. Run --setup again.');
      await browser.close();
      return null;
    }

    // Extract usage information from the page
    const pageText = await page.innerText('body');

    // Also try to get structured data from the page's progress bars / aria attributes
    const ariaValues = await page.evaluate(() => {
      const elements = document.querySelectorAll('[role="progressbar"], [aria-valuenow]');
      return Array.from(elements).map(el => ({
        value: el.getAttribute('aria-valuenow'),
        max: el.getAttribute('aria-valuemax'),
        text: el.textContent?.trim(),
      }));
    });

    // Try to get percentage from style attributes (width of progress bar)
    const progressWidths = await page.evaluate(() => {
      const bars = document.querySelectorAll('[class*="progress"], [class*="usage"], [class*="meter"]');
      return Array.from(bars).map(el => {
        const style = (el as HTMLElement).style;
        return { width: style.width, text: el.textContent?.trim() };
      });
    });

    await browser.close();
    browser = null;

    // Parse the usage percentage
    let usagePct = parseUsageFromText(pageText);

    // Try aria values if text parsing failed
    if (usagePct === null && ariaValues.length > 0) {
      for (const av of ariaValues) {
        if (av.value) {
          const pct = parseFloat(av.value);
          if (pct >= 0 && pct <= 100) {
            usagePct = pct;
            break;
          }
        }
      }
    }

    // Try progress bar widths
    if (usagePct === null && progressWidths.length > 0) {
      for (const pw of progressWidths) {
        if (pw.width) {
          const match = pw.width.match(/(\d+(?:\.\d+)?)%/);
          if (match) {
            usagePct = parseFloat(match[1]);
            break;
          }
        }
      }
    }

    if (usagePct !== null) {
      const cache: UsageCache = {
        weeklyUsagePct: usagePct,
        fetchedAt: new Date().toISOString(),
        planType: creds.subscriptionType,
        rawText: pageText.slice(0, 2000),
      };
      saveCache(cache);
      log.info(`Scraped weekly usage: ${usagePct}%`, { plan: creds.subscriptionType });
      return cache;
    }

    // Save for debugging even if we couldn't parse
    log.warn('Could not parse usage percentage from page', { textLength: pageText.length });
    const debugInfo = { ariaValues, progressWidths, textSnippet: pageText.slice(0, 500) };
    log.info('Debug info for usage page', debugInfo as unknown as Record<string, unknown>);
    saveCache({
      weeklyUsagePct: -1,
      fetchedAt: new Date().toISOString(),
      planType: creds.subscriptionType,
      rawText: pageText.slice(0, 2000),
    });
    return null;
  } catch (e) {
    log.error('Failed to scrape usage page', e);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Parse usage percentage from page text.
 */
function parseUsageFromText(text: string): number | null {
  // Pattern 1: "X% of your" or "X% used" or "X% weekly"
  const pctMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of|used|weekly|limit|usage)/i);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct >= 0 && pct <= 100) return pct;
  }

  // Pattern 2: "Used X of Y" or "X / Y"
  const ratioMatch = text.match(/(?:used|consumed)\s*(\d[\d,.]*)\s*(?:of|\/)\s*(\d[\d,.]*)/i);
  if (ratioMatch) {
    const used = parseFloat(ratioMatch[1].replace(/,/g, ''));
    const total = parseFloat(ratioMatch[2].replace(/,/g, ''));
    if (total > 0) {
      const pct = Math.round((used / total) * 100);
      if (pct >= 0 && pct <= 100) return pct;
    }
  }

  // Pattern 3: Any standalone percentage on the page
  const anyPct = text.match(/\b(\d{1,3})\s*%/);
  if (anyPct) {
    const pct = parseInt(anyPct[1]);
    if (pct >= 0 && pct <= 100) return pct;
  }

  return null;
}

/**
 * Get the real weekly usage percentage from Claude.ai.
 * Returns cached value if fresh enough, otherwise scrapes.
 */
export async function getRealWeeklyUsagePct(): Promise<number | null> {
  const cached = loadCache();
  if (cached && cached.weeklyUsagePct >= 0) {
    return cached.weeklyUsagePct;
  }
  const result = await scrapeUsagePage();
  if (result && result.weeklyUsagePct >= 0) {
    return result.weeklyUsagePct;
  }
  return null;
}

/**
 * Get cached usage without triggering a scrape.
 */
export function getCachedWeeklyUsagePct(): number | null {
  const cached = loadCache();
  if (cached && cached.weeklyUsagePct >= 0) {
    return cached.weeklyUsagePct;
  }
  return null;
}

/**
 * Force a fresh scrape.
 */
export async function refreshWeeklyUsage(): Promise<number | null> {
  const result = await scrapeUsagePage();
  if (result && result.weeklyUsagePct >= 0) {
    return result.weeklyUsagePct;
  }
  return null;
}

// Export for testing
export { parseUsageFromText as _parseUsageFromText };

// ── CLI Entry Point ──────────────────────────────────────────
if (process.argv[1]?.replace(/\.ts$/, '.js').endsWith('/usage-scraper.js')) {
  if (process.argv.includes('--setup')) {
    interactiveSetup().catch(console.error);
  } else {
    getRealWeeklyUsagePct()
      .then(pct => {
        if (pct !== null) {
          console.log(`Weekly usage: ${pct}%`);
        } else {
          console.log('Could not fetch usage. Run with --setup first.');
        }
      })
      .catch(console.error);
  }
}
