import { chromium } from '@playwright/test';

async function checkOverlaps(page, viewName) {
  const nodes = await page.locator('.react-flow__node').all();
  const boxes = [];
  for (const node of nodes) {
    const box = await node.boundingBox();
    const classes = await node.getAttribute('class') || '';
    const id = await node.getAttribute('data-id') || 'unknown';
    if (box) boxes.push({ ...box, id, isContainer: classes.includes('group') || box.width > 400 });
  }

  console.log(`\n=== ${viewName} ===`);
  console.log(`Total nodes: ${boxes.length}`);

  let realOverlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      // Skip parent-child containment (larger node contains smaller)
      const aContainsB = a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
      const bContainsA = b.x <= a.x && b.y <= a.y && b.x + b.width >= a.x + a.width && b.y + b.height >= a.y + a.height;
      if (aContainsB || bContainsA) continue;

      // Check AABB overlap with 2px tolerance
      if (a.x < b.x + b.width - 2 && a.x + a.width > b.x + 2 &&
          a.y < b.y + b.height - 2 && a.y + a.height > b.y + 2) {
        realOverlaps++;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        console.log(`REAL OVERLAP: "${a.id}" vs "${b.id}" (${overlapX.toFixed(0)}x${overlapY.toFixed(0)}px overlap area)`);
      }
    }
  }
  console.log(`Real overlaps (excluding containment): ${realOverlaps}`);
  return realOverlaps;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  let totalOverlaps = 0;

  // Test microservices dataflow
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(3000);
    totalOverlaps += await checkOverlaps(page, 'Microservices Dataflow');
    await page.close();
  }

  // Test microservices nested
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2000);
    try {
      await page.locator('button:has-text("Nested")').first().click({ timeout: 3000 });
      await page.waitForTimeout(3000);
    } catch (e) {}
    totalOverlaps += await checkOverlaps(page, 'Microservices Nested');
    await page.close();
  }

  // Test basic dataflow
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Basic Example")').first().click();
    await page.waitForTimeout(3000);
    totalOverlaps += await checkOverlaps(page, 'Basic Dataflow');
    await page.close();
  }

  // Test basic nested
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Basic Example")').first().click();
    await page.waitForTimeout(2000);
    try {
      await page.locator('button:has-text("Nested")').first().click({ timeout: 3000 });
      await page.waitForTimeout(3000);
    } catch (e) {}
    totalOverlaps += await checkOverlaps(page, 'Basic Nested');
    await page.close();
  }

  await browser.close();
  console.log(`\n=== TOTAL REAL OVERLAPS: ${totalOverlaps} ===`);
  process.exit(totalOverlaps > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
