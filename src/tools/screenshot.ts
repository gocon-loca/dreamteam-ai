/**
 * Screenshot — capture a web page as PNG for visual verification.
 *
 * CLI:  node dist/tools/screenshot.js <url> [--mobile] [--out file.png]
 * API:  import { screenshot } from '../tools/screenshot.js'
 *
 * Agents use this to see what they built. The Read tool can display
 * the resulting PNG — Claude is multimodal.
 */

import { chromium } from '@playwright/test';

export async function screenshot(
  url: string,
  opts: { mobile?: boolean; out?: string } = {},
): Promise<string> {
  const width = opts.mobile ? 375 : 1280;
  const out = opts.out || `/tmp/screenshot-${Date.now()}.png`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await browser.close();
  }

  return out;
}

// CLI
if (process.argv[1]?.replace(/\.ts$/, '.js').endsWith('/tools/screenshot.js')) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const mobile = args.includes('--mobile');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!url) {
    console.error('Usage: screenshot <url> [--mobile] [--out file.png]');
    process.exit(1);
  }

  screenshot(url, { mobile, out })
    .then(path => console.log(path))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
