/**
 * Screenshot Diff Utility — pixelmatch-based visual regression detection
 *
 * Compares current screenshots against baselines at multiple viewports.
 * Returns diff percentage per viewport. Thresholds:
 * - <5%: auto-approved (minor rendering differences)
 * - 5-25%: ambiguous (requires Haiku verification)
 * - >25%: auto-rejected (clear regression)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const DATA_DIR = join(process.cwd(), 'data', 'screenshots');
const BASELINES_DIR = join(DATA_DIR, 'baselines');
const CURRENT_DIR = join(DATA_DIR, 'current');
const DIFF_DIR = join(DATA_DIR, 'diffs');

export const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1200, height: 800 },
] as const;

// Thresholds
const AUTO_APPROVE_THRESHOLD = 0.05;  // <5% diff = auto-approve
const AUTO_REJECT_THRESHOLD = 0.25;   // >25% diff = auto-reject
const PIXEL_THRESHOLD = 0.1;          // pixelmatch sensitivity (0-1)

export interface ScreenshotDiffResult {
  viewport: string;
  diffPercentage: number;
  passed: boolean;
  isNewBaseline: boolean;
  baselinePath: string;
  currentPath: string;
  diffPath?: string;
}

/**
 * Compare a screenshot against its baseline.
 *
 * If no baseline exists:
 * - UPDATE_BASELINES=1: saves current as baseline
 * - Otherwise: auto-approves (new baseline)
 */
export function compareScreenshot(
  project: string,
  flowId: string,
  viewport: string,
  screenshotBuffer: Buffer
): ScreenshotDiffResult {
  const baselinePath = join(BASELINES_DIR, project, flowId, `${viewport}.png`);
  const currentPath = join(CURRENT_DIR, project, flowId, `${viewport}.png`);
  const diffPath = join(DIFF_DIR, project, flowId, `${viewport}-diff.png`);

  // Ensure directories exist
  mkdirSync(dirname(currentPath), { recursive: true });
  mkdirSync(dirname(diffPath), { recursive: true });

  // Save current screenshot
  writeFileSync(currentPath, screenshotBuffer);

  // No baseline — accept or create
  if (!existsSync(baselinePath)) {
    if (process.env.UPDATE_BASELINES === '1') {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, screenshotBuffer);
    }
    return {
      viewport,
      diffPercentage: 0,
      passed: true,
      isNewBaseline: true,
      baselinePath,
      currentPath,
    };
  }

  // Load images
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const current = PNG.sync.read(screenshotBuffer);

  // Handle size mismatch (resize to larger)
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);

  const normalizedBaseline = resizePNG(baseline, width, height);
  const normalizedCurrent = resizePNG(current, width, height);

  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(
    normalizedBaseline.data,
    normalizedCurrent.data,
    diff.data,
    width,
    height,
    { threshold: PIXEL_THRESHOLD }
  );

  const totalPixels = width * height;
  const diffPercentage = numDiffPixels / totalPixels;

  // Save diff image if there are differences
  if (numDiffPixels > 0) {
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
  }

  // Update baseline if requested
  if (process.env.UPDATE_BASELINES === '1') {
    writeFileSync(baselinePath, screenshotBuffer);
  }

  return {
    viewport,
    diffPercentage,
    passed: diffPercentage <= AUTO_APPROVE_THRESHOLD,
    isNewBaseline: false,
    baselinePath,
    currentPath,
    diffPath: numDiffPixels > 0 ? diffPath : undefined,
  };
}

/**
 * Check if a diff result is in the ambiguous zone (needs Haiku verification).
 */
export function isAmbiguousDiff(result: ScreenshotDiffResult): boolean {
  return !result.isNewBaseline &&
    result.diffPercentage > AUTO_APPROVE_THRESHOLD &&
    result.diffPercentage <= AUTO_REJECT_THRESHOLD;
}

/**
 * Check if a diff result is a clear regression.
 */
export function isClearRegression(result: ScreenshotDiffResult): boolean {
  return !result.isNewBaseline && result.diffPercentage > AUTO_REJECT_THRESHOLD;
}

/**
 * Resize a PNG to target dimensions, padding with transparent pixels.
 */
function resizePNG(png: PNG, targetWidth: number, targetHeight: number): PNG {
  if (png.width === targetWidth && png.height === targetHeight) return png;

  const resized = new PNG({ width: targetWidth, height: targetHeight, fill: true });
  // Fill with transparent
  resized.data.fill(0);

  // Copy original pixels
  for (let y = 0; y < Math.min(png.height, targetHeight); y++) {
    for (let x = 0; x < Math.min(png.width, targetWidth); x++) {
      const srcIdx = (y * png.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      resized.data[dstIdx] = png.data[srcIdx];
      resized.data[dstIdx + 1] = png.data[srcIdx + 1];
      resized.data[dstIdx + 2] = png.data[srcIdx + 2];
      resized.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }

  return resized;
}
