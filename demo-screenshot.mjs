import { chromium } from '@playwright/test';

const demos = [
  { name: 'microservices', buttonText: 'Microservices' },
  { name: 'basic', buttonText: 'Basic Example' },
];

const viewModes = ['dataflow', 'nested'];

async function run() {
  const browser = await chromium.launch({ headless: true });

  for (const demo of demos) {
    for (const mode of viewModes) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });

      // Click the demo button
      const btn = page.locator(`button:has-text("${demo.buttonText}")`).first();
      await btn.click();

      // Wait for graph to render
      await page.waitForTimeout(2000);

      // If we need nested mode, click the nested view toggle
      if (mode === 'nested') {
        // Look for the nested view button/toggle
        const nestedBtn = page.locator('button:has-text("Nested")').first();
        try {
          await nestedBtn.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
        } catch (e) {
          console.log(`No nested button found for ${demo.name}, trying alternative...`);
          // Try other selectors
          const altBtn = page.locator('[data-testid="nested-view"]').first();
          try {
            await altBtn.click({ timeout: 2000 });
            await page.waitForTimeout(2000);
          } catch (e2) {
            console.log(`Could not switch to nested mode for ${demo.name}`);
          }
        }
      }

      const outPath = `/tmp/demo-${demo.name}-${mode}.png`;
      await page.screenshot({ path: outPath, fullPage: true });
      console.log(outPath);

      await page.close();
    }
  }

  // Also screenshot at zoomed-in levels
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
  const btn = page.locator('button:has-text("Microservices")').first();
  await btn.click();
  await page.waitForTimeout(2000);

  // Zoom in by scrolling
  const canvas = page.locator('.react-flow').first();
  if (await canvas.isVisible()) {
    // Zoom in with mouse wheel
    await canvas.hover();
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1000);
    const outPath = `/tmp/demo-microservices-zoomed.png`;
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(outPath);
  }

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
