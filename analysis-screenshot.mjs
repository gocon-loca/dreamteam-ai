import { chromium } from '@playwright/test';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });

  // Click the Analysis nav link
  const analysisLink = page.locator('a:has-text("Analysis"), button:has-text("Analysis")').first();
  try {
    await analysisLink.click({ timeout: 3000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log('Could not find Analysis link');
  }

  await page.screenshot({ path: '/tmp/analysis-page.png', fullPage: true });
  console.log('/tmp/analysis-page.png');
  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
