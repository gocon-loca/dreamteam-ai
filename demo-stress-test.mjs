import { chromium } from '@playwright/test';

async function run() {
  const browser = await chromium.launch({ headless: true });

  // Test 1: Microservices dataflow - zoom out (overview tier)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2500);

    // Zoom out significantly
    const canvas = page.locator('.react-flow').first();
    if (await canvas.isVisible()) {
      await canvas.hover();
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: '/tmp/stress-micro-zoomout.png', fullPage: true });
    console.log('/tmp/stress-micro-zoomout.png');

    // Collect console errors
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(500);
    if (errors.length > 0) console.log('Console errors:', errors);
    await page.close();
  }

  // Test 2: Microservices dataflow - zoom in a lot (full detail tier)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });

    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2500);

    const canvas = page.locator('.react-flow').first();
    if (await canvas.isVisible()) {
      await canvas.hover();
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: '/tmp/stress-micro-zoomin.png', fullPage: true });
    console.log('/tmp/stress-micro-zoomin.png');
    if (errors.length > 0) console.log('Console errors (zoom in):', errors);
    await page.close();
  }

  // Test 3: Microservices nested - zoom in
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });

    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2000);

    // Switch to nested view
    try {
      await page.locator('button:has-text("Nested")').first().click({ timeout: 3000 });
      await page.waitForTimeout(2500);
    } catch (e) {}

    // Zoom in
    const canvas = page.locator('.react-flow').first();
    if (await canvas.isVisible()) {
      await canvas.hover();
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: '/tmp/stress-nested-zoomin.png', fullPage: true });
    console.log('/tmp/stress-nested-zoomin.png');
    if (errors.length > 0) console.log('Console errors (nested zoom in):', errors);
    await page.close();
  }

  // Test 4: Microservices nested - zoom out
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2000);
    try {
      await page.locator('button:has-text("Nested")').first().click({ timeout: 3000 });
      await page.waitForTimeout(2500);
    } catch (e) {}

    const canvas = page.locator('.react-flow').first();
    if (await canvas.isVisible()) {
      await canvas.hover();
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: '/tmp/stress-nested-zoomout.png', fullPage: true });
    console.log('/tmp/stress-nested-zoomout.png');
    await page.close();
  }

  // Test 5: Check node count in microservices dataflow
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 15000 });
    await page.locator('button:has-text("Microservices")').first().click();
    await page.waitForTimeout(2500);

    const nodeCount = await page.locator('.react-flow__node').count();
    console.log(`Dataflow node count: ${nodeCount}`);

    // Switch to nested
    try {
      await page.locator('button:has-text("Nested")').first().click({ timeout: 3000 });
      await page.waitForTimeout(2500);
    } catch (e) {}
    const nestedNodeCount = await page.locator('.react-flow__node').count();
    console.log(`Nested node count: ${nestedNodeCount}`);

    // Check for overlapping nodes by getting bounding boxes
    const nodes = await page.locator('.react-flow__node').all();
    const boxes = [];
    for (const node of nodes) {
      const box = await node.boundingBox();
      if (box) boxes.push(box);
    }

    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        // Check AABB overlap with 2px tolerance
        if (a.x < b.x + b.width - 2 && a.x + a.width > b.x + 2 &&
            a.y < b.y + b.height - 2 && a.y + a.height > b.y + 2) {
          overlaps++;
          console.log(`OVERLAP: node ${i} (${a.x.toFixed(0)},${a.y.toFixed(0)} ${a.width.toFixed(0)}x${a.height.toFixed(0)}) vs node ${j} (${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)})`);
        }
      }
    }
    console.log(`Total overlaps detected: ${overlaps}`);

    await page.close();
  }

  await browser.close();
  console.log('All stress tests completed');
}

run().catch(e => { console.error(e); process.exit(1); });
